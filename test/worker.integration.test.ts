import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';

import { migrateDatabase } from '../src/lib/server/database/migrations.js';
import {
  executeGitHubBrokerOperation,
  GitHubBrokerDeniedError,
  type GitHubBrokerRemote
} from '../src/lib/server/github/broker.js';
import { ingestGitHubWebhook } from '../src/lib/server/github/webhooks.js';
import { AgentRunGitHubWorkspaceBroker } from '../src/lib/server/github/workspace.js';
import { postChannelMessage } from '../src/lib/server/collaboration/channel.js';
import { correctMessageIntent } from '../src/lib/server/collaboration/message-intent.js';
import { acceptAgentConversation } from '../src/lib/server/collaboration/conversation.js';
import { cancelAgentHandoff } from '../src/lib/server/collaboration/handoffs.js';
import {
  claimCoordinationStep,
  decideCoordinationPlan,
  proposeCoordinationPlan
} from '../src/lib/server/collaboration/coordination.js';
import { loadCollaborationAccountability } from '../src/lib/server/collaboration/accountability.js';
import {
  createProjectMemory,
  loadAgentProjectMemoryContext,
  loadProjectMemoryContext,
  setProjectMemoryLifecycle,
  type MemoryType
} from '../src/lib/server/collaboration/findings.js';
import { loadChannelReconciliation } from '../src/lib/server/collaboration/reconciliation.js';
import {
  AgentRunProviderError,
  type AgentRunProvider,
  type AgentRunProviderInput,
  type AgentRunProviderObserver,
  type ProviderInterruptionInput,
  type ProviderReconciliation
} from '../src/lib/server/provider/agent-run.js';
import { processNextAgentRun } from '../src/worker/execution.js';
import { processNextConversationTurn } from '../src/worker/conversation.js';

let container: StartedPostgreSqlContainer | undefined;
let connectionString = process.env.TEST_DATABASE_URL;
const skipDatabaseTests = process.env.SKIP_DATABASE_TESTS === 'true';

if (skipDatabaseTests) {
  test('the leased worker PostgreSQL seam', { skip: 'SKIP_DATABASE_TESTS=true' });
} else {
  if (!connectionString) {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    connectionString = container.getConnectionUri();
  }

  const pool = new Pool({ connectionString });
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'relay-worker-test-'));
  await migrateDatabase(pool);

  afterEach(async () => {
    // A few tests deliberately leave work queued after asserting its state. Keep those fixtures
    // from being claimed by a later test, since the production worker selects globally by age.
    await pool.query(
      `UPDATE public.agent_run
       SET available_at = 'infinity'
       WHERE status = 'queued'`
    );
  });

  after(async () => {
    await pool.end();
    await container?.stop();
  });

  test('GitHub broker decisions and signed webhook deliveries remain append-only and correlated', async () => {
    const ids = await seedQueuedAgentRun(pool, 'github-broker');
    const executions: string[] = [];
    const remote: GitHubBrokerRemote = {
      async execute(input) {
        executions.push(input.request.operation);
        return { commitSha: 'a'.repeat(40) };
      }
    };
    const common = {
      repositoryId: 'repo-github-broker',
      agentRunId: ids.runId,
      attemptNumber: 1,
      actorWorkspaceMemberId: ids.agentMemberId
    };

    await executeGitHubBrokerOperation(pool, remote, { ...common, operation: 'fetch' });
    await assert.rejects(
      executeGitHubBrokerOperation(pool, remote, {
        ...common,
        operation: 'update_branch',
        branch: 'main',
        commitSha: 'b'.repeat(40),
        force: true
      }),
      GitHubBrokerDeniedError
    );
    await assert.rejects(
      executeGitHubBrokerOperation(pool, remote, {
        ...common,
        attemptNumber: 2,
        operation: 'fetch'
      }),
      GitHubBrokerDeniedError
    );
    await assert.rejects(
      executeGitHubBrokerOperation(pool, remote, {
        ...common,
        agentRunId: 'unknown-github-broker-run',
        operation: 'read'
      }),
      GitHubBrokerDeniedError
    );
    assert.deepEqual(executions, ['fetch']);

    const secret = 'github-webhook-contract-secret';
    const body = Buffer.from(JSON.stringify({
      ref: `refs/heads/relay/${ids.runId}`,
      after: 'a'.repeat(40),
      repository: { id: 'repo-github-broker' },
      installation: { id: 'installation-github-broker', token: 'private-value' }
    }));
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const webhookInput = {
      deliveryId: 'delivery-github-broker', eventName: 'push', signature, body, secret
    };
    assert.deepEqual(await ingestGitHubWebhook(pool, webhookInput), {
      accepted: true, duplicate: false, agentRunId: ids.runId
    });
    assert.deepEqual(await ingestGitHubWebhook(pool, webhookInput), {
      accepted: true, duplicate: true, agentRunId: ids.runId
    });

    const evidence = await pool.query<{
      decisions: number;
      deliveries: number;
      denied: number;
      correlated: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM public.github_broker_decision
          WHERE agent_run_id = $1) AS decisions,
         (SELECT count(*)::integer FROM public.github_webhook_delivery
          WHERE agent_run_id = $1) AS deliveries,
         (SELECT count(*)::integer FROM public.github_broker_decision
          WHERE agent_run_id = $1 AND decision = 'deny') AS denied,
         delivery.agent_run_id AS correlated,
         delivery.payload
       FROM public.github_webhook_delivery delivery
       WHERE delivery.delivery_id = 'delivery-github-broker'`,
      [ids.runId]
    );
    assert.equal(evidence.rows[0]?.decisions, 4);
    assert.equal(evidence.rows[0]?.deliveries, 1);
    assert.equal(evidence.rows[0]?.denied, 2);
    assert.equal(evidence.rows[0]?.correlated, ids.runId);
    assert.doesNotMatch(JSON.stringify(evidence.rows[0]?.payload), /private-value/);
    const unknownRun = await pool.query<{
      agent_run_id: string | null;
      requested_agent_run_id: string;
      decision: string;
      reason: string;
    }>(
      `SELECT agent_run_id, requested_agent_run_id, decision, reason
       FROM public.github_broker_decision
       WHERE requested_agent_run_id = 'unknown-github-broker-run'`
    );
    assert.deepEqual(unknownRun.rows[0], {
      agent_run_id: null,
      requested_agent_run_id: 'unknown-github-broker-run',
      decision: 'deny',
      reason: 'unknown_agent_run'
    });
    await assert.rejects(
      pool.query('DELETE FROM public.github_broker_decision WHERE agent_run_id = $1', [ids.runId]),
      /append-only/
    );
  });

  test('a completed AgentRun is published through a credential-free broker workspace as one Artifact', async () => {
    const ids = await seedQueuedAgentRun(pool, 'github-publication');
    const operations: string[] = [];
    const remote: GitHubBrokerRemote = {
      async execute(input) {
        operations.push(input.request.operation);
        if (input.request.operation === 'clone') {
          return {
            commitSha: 'a'.repeat(40),
            files: [{
              path: 'README.md',
              content: Buffer.from('before\n').toString('base64'),
              encoding: 'base64'
            }]
          };
        }
        if (input.request.operation === 'create_branch') return { commitSha: 'a'.repeat(40) };
        if (input.request.operation === 'commit') {
          const changed = input.request.files?.find(({ path }) => path === 'README.md');
          assert.equal(changed?.encoding, 'base64');
          assert.equal(Buffer.from(changed?.content ?? '', 'base64').toString(), 'after\n');
          return { commitSha: 'b'.repeat(40) };
        }
        if (input.request.operation === 'update_branch') return { commitSha: 'b'.repeat(40) };
        if (input.request.operation === 'pull_request_upsert') {
          return {
            commitSha: 'b'.repeat(40),
            pullRequestNumber: 25,
            pullRequestUrl: 'https://github.test/relay-owner/pilot/pull/25'
          };
        }
        throw new Error('unexpected broker operation');
      }
    };
    const provider = new FixtureProvider(async (input, observer) => {
      assert.match(input.prompt, /credential-free workspace/);
      assert.equal(await readFile(join(input.workspaceDirectory, 'README.md'), 'utf8'), 'before\n');
      await writeFile(join(input.workspaceDirectory, 'README.md'), 'after\n');
      await observer.threadStarted('thread-github-publication');
      await observer.turnStarted('turn-github-publication');
      await observer.notification({
        method: 'turn/completed',
        providerEventId: 'turn-github-publication:completed',
        turn: { id: 'turn-github-publication', status: 'completed' }
      });
    });

    const result = await processNextAgentRun(pool, provider, {
      workerId: 'worker-github-publication',
      workspaceRoot,
      leaseDurationMs: 10_000,
      githubWorkspaceBroker: new AgentRunGitHubWorkspaceBroker(pool, remote)
    });
    assert.deepEqual(result, { kind: 'executed', agentRunId: ids.runId, status: 'completed' });
    assert.deepEqual(operations, [
      'clone', 'create_branch', 'commit', 'update_branch', 'pull_request_upsert'
    ]);
    const artifact = await pool.query<{
      workspace_id: string;
      project_id: string;
      task_id: string;
      agent_run_id: string;
      result_message_id: string;
      kind: string;
      branch: string;
      commit_sha: string;
      pull_request_number: number;
      url: string;
    }>(
      `SELECT workspace_id, project_id, task_id, agent_run_id, result_message_id,
              kind, branch, commit_sha, pull_request_number, url
       FROM public.artifact WHERE agent_run_id = $1`,
      [ids.runId]
    );
    const storedArtifact = artifact.rows[0];
    assert.ok(storedArtifact?.result_message_id);
    assert.deepEqual(storedArtifact, {
      workspace_id: ids.workspaceId,
      project_id: ids.projectId,
      task_id: `task-github-publication`,
      agent_run_id: ids.runId,
      result_message_id: storedArtifact.result_message_id,
      kind: 'github_pull_request',
      branch: `relay/${ids.runId}`,
      commit_sha: 'b'.repeat(40),
      pull_request_number: 25,
      url: 'https://github.test/relay-owner/pilot/pull/25'
    });
    const resultMessage = await pool.query<{
      parent_message_id: string;
      author_workspace_member_id: string;
      body: string;
    }>(
      `SELECT parent_message_id, author_workspace_member_id, body
       FROM public.message WHERE id = $1`,
      [storedArtifact.result_message_id]
    );
    assert.deepEqual(resultMessage.rows[0], {
      parent_message_id: 'message-github-publication',
      author_workspace_member_id: ids.agentMemberId,
      body: 'Completed the engineering request. Pull request #25 is ready for human review.'
    });
    const ownerView = await loadChannelReconciliation(pool, ids.ownerAccess, ids.channelId, {});
    const memberView = await loadChannelReconciliation(pool, ids.memberAccess, ids.channelId, {});
    assert.equal(ownerView.runs[0]?.status, 'completed');
    assert.equal(memberView.runs[0]?.status, 'completed');
    assert.deepEqual(ownerView.runs[0]?.artifact, {
      kind: 'github_pull_request',
      pullRequestNumber: 25,
      url: 'https://github.test/relay-owner/pilot/pull/25'
    });
    assert.deepEqual(memberView.runs[0]?.artifact, ownerView.runs[0]?.artifact);
    assert.equal(
      ownerView.messages.filter(({ id }) => id === storedArtifact.result_message_id).length,
      1
    );
    const artifactCardinality = await pool.query<{ artifacts: number; result_messages: number }>(
      `SELECT
         (SELECT count(*)::integer FROM public.artifact WHERE agent_run_id = $1) AS artifacts,
         (SELECT count(*)::integer FROM public.message WHERE id = $2) AS result_messages`,
      [ids.runId, storedArtifact.result_message_id]
    );
    assert.deepEqual(artifactCardinality.rows[0], { artifacts: 1, result_messages: 1 });
    const decisions = await pool.query<{ decision: string; operation: string }>(
      `SELECT decision, operation FROM public.github_broker_decision
       WHERE agent_run_id = $1 AND phase = 'decision' ORDER BY id`,
      [ids.runId]
    );
    assert.deepEqual(decisions.rows, operations.map((operation) => ({ decision: 'allow', operation })));
    assert.doesNotMatch(JSON.stringify(decisions.rows), /before|after|installation/);
  });

  test('a mode-only executable change is published through the GitHub broker', async () => {
    const ids = await seedQueuedAgentRun(pool, 'github-mode-publication');
    const operations: string[] = [];
    const remote: GitHubBrokerRemote = {
      async execute(input) {
        operations.push(input.request.operation);
        if (input.request.operation === 'clone') {
          return {
            commitSha: 'e'.repeat(40),
            files: [{
              path: 'script.sh',
              content: Buffer.from('#!/bin/sh\n').toString('base64'),
              encoding: 'base64',
              mode: '100644'
            }]
          };
        }
        if (input.request.operation === 'create_branch') return { commitSha: 'e'.repeat(40) };
        if (input.request.operation === 'commit') {
          assert.deepEqual(input.request.files, [{
            path: 'script.sh',
            content: Buffer.from('#!/bin/sh\n').toString('base64'),
            encoding: 'base64',
            mode: '100755'
          }]);
          return { commitSha: 'f'.repeat(40) };
        }
        if (input.request.operation === 'update_branch') return { commitSha: 'f'.repeat(40) };
        if (input.request.operation === 'pull_request_upsert') {
          return {
            commitSha: 'f'.repeat(40),
            pullRequestNumber: 27,
            pullRequestUrl: 'https://github.test/relay-owner/pilot/pull/27'
          };
        }
        throw new Error('unexpected broker operation');
      }
    };
    const provider = new FixtureProvider(async (input, observer) => {
      await chmod(join(input.workspaceDirectory, 'script.sh'), 0o700);
      await observer.threadStarted('thread-github-mode-publication');
      await observer.turnStarted('turn-github-mode-publication');
      await observer.notification({
        method: 'turn/completed',
        providerEventId: 'turn-github-mode-publication:completed',
        turn: { id: 'turn-github-mode-publication', status: 'completed' }
      });
    });

    const result = await processNextAgentRun(pool, provider, {
      workerId: 'worker-github-mode-publication',
      workspaceRoot,
      leaseDurationMs: 10_000,
      githubWorkspaceBroker: new AgentRunGitHubWorkspaceBroker(pool, remote)
    });

    assert.deepEqual(result, { kind: 'executed', agentRunId: ids.runId, status: 'completed' });
    assert.deepEqual(operations, [
      'clone', 'create_branch', 'commit', 'update_branch', 'pull_request_upsert'
    ]);
  });

  test('a completed Provider turn without repository changes replies visibly once', async () => {
    const ids = await seedQueuedAgentRun(pool, 'github-no-changes');
    const operations: string[] = [];
    const remote: GitHubBrokerRemote = {
      async execute(input) {
        operations.push(input.request.operation);
        if (input.request.operation === 'clone') {
          return {
            commitSha: '1'.repeat(40),
            files: [{
              path: 'README.md',
              content: Buffer.from('unchanged\n').toString('base64'),
              encoding: 'base64',
              mode: '100644'
            }]
          };
        }
        if (input.request.operation === 'create_branch') return { commitSha: '1'.repeat(40) };
        throw new Error('unexpected broker operation');
      }
    };
    const provider = new FixtureProvider(async (_input, observer) => {
      await observer.threadStarted('thread-github-no-changes');
      await observer.turnStarted('turn-github-no-changes');
      await observer.notification({
        method: 'turn/completed',
        providerEventId: 'turn-github-no-changes:completed',
        turn: { id: 'turn-github-no-changes', status: 'completed' }
      });
    });

    const result = await processNextAgentRun(pool, provider, {
      workerId: 'worker-github-no-changes',
      workspaceRoot,
      leaseDurationMs: 10_000,
      githubWorkspaceBroker: new AgentRunGitHubWorkspaceBroker(pool, remote)
    });

    assert.deepEqual(result, { kind: 'executed', agentRunId: ids.runId, status: 'failed' });
    assert.deepEqual(operations, ['clone', 'create_branch']);
    const reply = await pool.query<{
      author_workspace_member_id: string;
      body: string;
      notifications: number;
    }>(
      `SELECT message.author_workspace_member_id, message.body,
              count(outbox.id)::integer AS notifications
       FROM public.message message
       LEFT JOIN public.notification_outbox outbox ON outbox.message_id = message.id
       WHERE message.id = $1
       GROUP BY message.id`,
      [`agent-run-result:${ids.runId}`]
    );
    assert.deepEqual(reply.rows[0], {
      author_workspace_member_id: ids.agentMemberId,
      body: 'I finished checking the repository, but there were no changes to publish, so no pull request was created.',
      notifications: 1
    });
  });

  test('a pull-request result is not exposed unless AgentRun completion is durable', async () => {
    const ids = await seedQueuedAgentRun(pool, 'github-finalization-failure');
    await pool.query(`
      CREATE FUNCTION fail_test_artifact_insert() RETURNS trigger AS $$
      BEGIN
        IF NEW.agent_run_id = '${ids.runId}' THEN
          RAISE EXCEPTION 'forced artifact persistence failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_test_artifact_insert
      BEFORE INSERT ON public.artifact
      FOR EACH ROW EXECUTE FUNCTION fail_test_artifact_insert()
    `);
    try {
      const remote: GitHubBrokerRemote = {
        async execute(input) {
          if (input.request.operation === 'clone') {
            return {
              commitSha: 'c'.repeat(40),
              files: [{
                path: 'README.md',
                content: Buffer.from('before\n').toString('base64'),
                encoding: 'base64'
              }]
            };
          }
          if (input.request.operation === 'create_branch') return { commitSha: 'c'.repeat(40) };
          if (input.request.operation === 'commit'
            || input.request.operation === 'update_branch') {
            return { commitSha: 'd'.repeat(40) };
          }
          if (input.request.operation === 'pull_request_upsert') {
            return {
              commitSha: 'd'.repeat(40),
              pullRequestNumber: 26,
              pullRequestUrl: 'https://github.test/relay-owner/pilot/pull/26'
            };
          }
          throw new Error('unexpected broker operation');
        }
      };
      const provider = new FixtureProvider(async (input, observer) => {
        await writeFile(join(input.workspaceDirectory, 'README.md'), 'after\n');
        await observer.threadStarted('thread-github-finalization-failure');
        await observer.turnStarted('turn-github-finalization-failure');
        await observer.notification({
          method: 'turn/completed',
          providerEventId: 'turn-github-finalization-failure:completed',
          turn: { id: 'turn-github-finalization-failure', status: 'completed' }
        });
      });

      const result = await processNextAgentRun(pool, provider, {
        workerId: 'worker-github-finalization-failure',
        workspaceRoot,
        leaseDurationMs: 10_000,
        githubWorkspaceBroker: new AgentRunGitHubWorkspaceBroker(pool, remote)
      });
      assert.deepEqual(result, { kind: 'executed', agentRunId: ids.runId, status: 'failed' });
      const durable = await pool.query<{
        status: string;
        completed_events: number;
        artifacts: number;
        result_messages: number;
      }>(
        `SELECT run.status,
                (SELECT count(*)::integer FROM public.agent_run_event
                 WHERE agent_run_id = run.id AND status = 'completed') AS completed_events,
                (SELECT count(*)::integer FROM public.artifact
                 WHERE agent_run_id = run.id) AS artifacts,
                (SELECT count(*)::integer FROM public.message
                 WHERE workspace_id = run.workspace_id
                   AND parent_message_id = $2
                   AND body LIKE 'Completed the engineering request.%') AS result_messages
         FROM public.agent_run run WHERE run.id = $1`,
        [ids.runId, 'message-github-finalization-failure']
      );
      assert.deepEqual(durable.rows[0], {
        status: 'failed',
        completed_events: 0,
        artifacts: 0,
        result_messages: 0
      });
    } finally {
      await pool.query('DROP TRIGGER fail_test_artifact_insert ON public.artifact');
      await pool.query('DROP FUNCTION fail_test_artifact_insert()');
    }
  });

  test('one leased worker executes a queued AgentRun and persists safe Provider evidence once', async () => {
    const ids = await seedQueuedAgentRun(pool, 'complete');
    const provider = new FixtureProvider(async (input, observer) => {
      assert.equal(input.prompt, '@Alex inspect the failing test.');
      assert.equal(input.credentialStoreReference, 'credentials-complete');
      assert.equal(input.sandboxPolicy.type, 'workspaceWrite');
      assert.deepEqual(input.sandboxPolicy.writableRoots, [input.workspaceDirectory]);
      assert.equal(input.sandboxPolicy.networkAccess, false);
      assert.equal(input.approvalPolicy, 'onRequest');
      await observer.threadStarted('thread-complete');
      await observer.turnStarted('turn-complete');
      await observer.notification({
        method: 'item/started',
        providerEventId: 'item-1:started',
        item: { id: 'item-1', type: 'commandExecution', privateDetail: 'must not persist' }
      });
      await observer.notification({
        method: 'item/started',
        providerEventId: 'item-1:started',
        item: { id: 'item-1', type: 'commandExecution', privateDetail: 'must not persist' }
      });
      await observer.notification({
        method: 'item/completed',
        providerEventId: 'item-1:completed',
        item: { id: 'item-1', type: 'commandExecution', privateDetail: 'must not persist' }
      });
      await observer.notification({
        method: 'turn/completed',
        providerEventId: 'turn-complete:completed',
        turn: { id: 'turn-complete', status: 'completed' }
      });
    });

    const result = await processNextAgentRun(pool, provider, {
      workerId: 'worker-a',
      workspaceRoot,
      leaseDurationMs: 10_000
    });
    assert.deepEqual(result, { kind: 'executed', agentRunId: ids.runId, status: 'completed' });
    assert.equal(provider.executions.length, 1);

    const stored = await pool.query<{
      status: string;
      provider_thread_id: string;
      active_turn_id: string | null;
      workspace_directory: string;
      lease_owner: string | null;
      started_at: Date;
      completed_at: Date;
    }>(
      `SELECT status, provider_thread_id, active_turn_id, workspace_directory,
              lease_owner, started_at, completed_at
       FROM public.agent_run WHERE id = $1`,
      [ids.runId]
    );
    assert.equal(stored.rows[0]?.status, 'completed');
    assert.equal(stored.rows[0]?.provider_thread_id, 'thread-complete');
    assert.equal(stored.rows[0]?.active_turn_id, null);
    assert.equal(stored.rows[0]?.lease_owner, null);
    assert.ok(stored.rows[0]?.started_at);
    assert.ok(stored.rows[0]?.completed_at);
    assert.equal((await stat(stored.rows[0]!.workspace_directory)).mode & 0o777, 0o700);

    const events = await pool.query<{
      event_type: string;
      provider_event_id: string | null;
      summary: string;
      evidence: Record<string, unknown>;
    }>(
      `SELECT event_type, provider_event_id, summary, evidence
       FROM public.agent_run_event WHERE agent_run_id = $1 ORDER BY sequence`,
      [ids.runId]
    );
    assert.equal(events.rows.filter(({ provider_event_id }) => provider_event_id === 'item-1:started').length, 1);
    assert.deepEqual(events.rows.map(({ event_type }) => event_type), [
      'run.queued',
      'run.claimed',
      'provider.thread.started',
      'provider.turn.started',
      'provider.item.started',
      'provider.item.completed',
      'provider.turn.completed'
    ]);
    assert.doesNotMatch(JSON.stringify(events.rows), /must not persist/);

    const outbox = await pool.query<{ events: number; outbox: number }>(
      `SELECT
         (SELECT count(*)::integer FROM public.agent_run_event WHERE agent_run_id = $1) AS events,
         (SELECT count(*)::integer FROM public.notification_outbox outbox
          JOIN public.agent_run_event event ON event.id = outbox.agent_run_event_id
          WHERE event.agent_run_id = $1) AS outbox`,
      [ids.runId]
    );
    assert.deepEqual(outbox.rows[0], { events: 7, outbox: 7 });
  });

  test('ordinary Agent conversation replies naturally and continues without another mention', async () => {
    const ids = await seedQueuedAgentRun(pool, 'conversation');
    await pool.query(
      `UPDATE public.agent_run
       SET status = 'completed', completed_at = now(), updated_at = now()
       WHERE id = $1`,
      [ids.runId]
    );
    await pool.query("UPDATE public.task SET status = 'completed' WHERE id = $1", [
      'task-conversation'
    ]);
    await pool.query("UPDATE public.agent SET status = 'idle' WHERE id = $1", [ids.agentId]);

    const root = await postChannelMessage(pool, ids.ownerAccess, {
      channelId: ids.channelId,
      body: '@Alex hello, how are you?',
      submissionId: 'conversation-root'
    });
    assert.equal(root.agentMention?.status, 'conversation');
    assert.equal(await countTasksForMessage(pool, root.id), 0);

    const firstProvider = new FixtureProvider(async (input, observer) => {
      assert.equal(input.providerThreadId, undefined);
      assert.deepEqual(input.sandboxPolicy, { type: 'readOnly', networkAccess: false });
      assert.match(input.prompt, /@Alex hello, how are you\?/);
      await observer.threadStarted('thread-conversation');
      await observer.turnStarted('turn-conversation-1');
      await observer.notification({
        method: 'item/completed',
        providerEventId: 'turn-conversation-1:message:completed',
        item: { id: 'message-conversation-1', type: 'agentMessage', text: 'Doing well—how can I help?' }
      });
      await observer.notification({
        method: 'turn/completed',
        providerEventId: 'turn-conversation-1:completed',
        turn: { id: 'turn-conversation-1', status: 'completed' }
      });
    });
    assert.deepEqual(await processNextConversationTurn(pool, firstProvider, {
      workerId: 'worker-conversation-1', workspaceRoot, leaseDurationMs: 10_000
    }), {
      kind: 'conversation',
      conversationTurnId: root.agentMention?.status === 'conversation'
        ? root.agentMention.conversationTurnId
        : '',
      status: 'completed'
    });

    const followUp = await postChannelMessage(pool, ids.memberAccess, {
      channelId: ids.channelId,
      parentMessageId: root.id,
      body: 'What can you help with?',
      submissionId: 'conversation-follow-up'
    });
    assert.equal(followUp.agentMention?.status, 'conversation');
    assert.equal(await countTasksForMessage(pool, followUp.id), 0);
    const secondProvider = new FixtureProvider(async (input, observer) => {
      assert.equal(input.providerThreadId, 'thread-conversation');
      assert.match(input.prompt, /What can you help with\?/);
      await observer.threadStarted('thread-conversation');
      await observer.turnStarted('turn-conversation-2');
      await observer.notification({
        method: 'item/completed',
        providerEventId: 'turn-conversation-2:message:completed',
        item: {
          id: 'message-conversation-2',
          type: 'agentMessage',
          text: 'I can discuss ideas or take on a concrete repository task.'
        }
      });
      await observer.notification({
        method: 'turn/completed',
        providerEventId: 'turn-conversation-2:completed',
        turn: { id: 'turn-conversation-2', status: 'completed' }
      });
    });
    await processNextConversationTurn(pool, secondProvider, {
      workerId: 'worker-conversation-2', workspaceRoot, leaseDurationMs: 10_000
    });

    const replies = await pool.query<{
      body: string;
      author_workspace_member_id: string;
      parent_message_id: string | null;
    }>(
      `SELECT body, author_workspace_member_id, parent_message_id FROM public.message
       WHERE id = ANY($1::text[]) AND author_workspace_member_id = $2
       ORDER BY created_at, id`,
      [[
        `conversation-result:${root.agentMention?.status === 'conversation' ? root.agentMention.conversationTurnId : ''}`,
        `conversation-result:${followUp.agentMention?.status === 'conversation' ? followUp.agentMention.conversationTurnId : ''}`
      ], ids.agentMemberId]
    );
    assert.deepEqual(replies.rows, [
      {
        body: 'Doing well—how can I help?',
        author_workspace_member_id: ids.agentMemberId,
        parent_message_id: null
      },
      {
        body: 'I can discuss ideas or take on a concrete repository task.',
        author_workspace_member_id: ids.agentMemberId,
        parent_message_id: root.id
      }
    ]);
    const broker = await pool.query<{ decisions: number }>(
      `SELECT count(*)::integer AS decisions FROM public.github_broker_decision
       WHERE requested_agent_run_id LIKE '%conversation%'`
    );
    assert.equal(broker.rows[0]?.decisions, 0);

    const ambient = await postChannelMessage(pool, ids.ownerAccess, {
      channelId: ids.channelId,
      body: 'The repository bug may be related to our earlier discussion.',
      submissionId: 'conversation-ambient'
    });
    assert.equal(ambient.agentMention?.status, 'conversation');
    const ambientProvider = new FixtureProvider(async (input, observer) => {
      assert.match(input.prompt, /You were not tagged/);
      assert.match(input.prompt, /Doing well—how can I help\?/);
      assert.match(input.prompt, /Recent authorized Channel context/);
      await observer.threadStarted('thread-conversation-ambient');
      await observer.turnStarted('turn-conversation-ambient');
      await observer.notification({
        method: 'item/completed',
        providerEventId: 'turn-conversation-ambient:message:completed',
        item: { id: 'message-conversation-ambient', type: 'agentMessage', text: '[RELAY_SILENT]' }
      });
      await observer.notification({
        method: 'turn/completed',
        providerEventId: 'turn-conversation-ambient:completed',
        turn: { id: 'turn-conversation-ambient', status: 'completed' }
      });
    });
    assert.deepEqual(await processNextConversationTurn(pool, ambientProvider, {
      workerId: 'worker-conversation-ambient', workspaceRoot, leaseDurationMs: 10_000
    }), {
      kind: 'conversation',
      conversationTurnId: ambient.agentMention?.status === 'conversation'
        ? ambient.agentMention.conversationTurnId
        : '',
      status: 'completed'
    });
    const ambientResponse = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM public.message WHERE id = $1`,
      [`conversation-result:${ambient.agentMention?.status === 'conversation' ? ambient.agentMention.conversationTurnId : ''}`]
    );
    assert.equal(ambientResponse.rows[0]?.count, 0);

    const interrupted = await postChannelMessage(pool, ids.ownerAccess, {
      channelId: ids.channelId,
      parentMessageId: root.id,
      body: 'Tell me one more thing.',
      submissionId: 'conversation-interrupted'
    });
    assert.equal(interrupted.agentMention?.status, 'conversation');
    const interruptedTurnId = interrupted.agentMention?.status === 'conversation'
      ? interrupted.agentMention.conversationTurnId
      : '';
    await pool.query(
      `UPDATE public.agent_conversation_turn
       SET status = 'working', lease_owner = 'lost-worker', lease_token = 'lost-lease',
           lease_expires_at = now() - interval '1 minute', started_at = now() - interval '2 minutes'
       WHERE id = $1`,
      [interruptedTurnId]
    );
    const providerMustNotReplay = new FixtureProvider(async () => {
      assert.fail('an uncertain conversational turn must not be replayed');
    });
    assert.deepEqual(await processNextConversationTurn(pool, providerMustNotReplay, {
      workerId: 'worker-conversation-recovery', workspaceRoot, leaseDurationMs: 10_000
    }), {
      kind: 'conversation', conversationTurnId: interruptedTurnId, status: 'failed'
    });
    const recoveryReply = await pool.query<{ body: string }>(
      'SELECT body FROM public.message WHERE id = $1',
      [`conversation-result:${interruptedTurnId}`]
    );
    assert.equal(
      recoveryReply.rows[0]?.body,
      'I lost the active response during a worker restart. Please send that message again.'
    );

    const productAgentId = 'agent-conversation-product';
    const productMemberId = `${productAgentId}:member`;
    await pool.query(
      `INSERT INTO public.agent (
         id, workspace_id, name, agent_type, role_label, instructions,
         participation_mode, ambient_triggers
       ) VALUES ($1, $2, 'Maya', 'product', 'Product manager',
                 'Clarify the product outcome.', 'reactive', ARRAY[]::text[])`,
      [productAgentId, ids.workspaceId]
    );
    await pool.query(
      `INSERT INTO public.workspace_member (id, workspace_id, kind, agent_id)
       VALUES ($1, $2, 'agent', $3)`,
      [productMemberId, ids.workspaceId, productAgentId]
    );
    await pool.query(
      `INSERT INTO public.project_membership (workspace_id, project_id, workspace_member_id)
       VALUES ($1, $2, $3)`,
      [ids.workspaceId, ids.projectId, productMemberId]
    );
    const suppliedArtifactUrl = 'https://github.test/relay-owner/pilot/pull/39';
    await pool.query(`UPDATE public.task SET status = 'completed' WHERE id = 'task-conversation'`);
    await pool.query(
      `UPDATE public.agent_run SET status = 'completed' WHERE id = 'run-conversation'`
    );
    await pool.query(
      `INSERT INTO public.message (
         id, workspace_id, channel_id, author_workspace_member_id, parent_message_id, body
       ) VALUES (
         'artifact-result-conversation', $1, $2, $3, 'message-conversation',
         'Pull request #39 is ready for review.'
       )`,
      [ids.workspaceId, ids.channelId, ids.agentMemberId]
    );
    await pool.query(
      `INSERT INTO public.artifact (
         id, workspace_id, project_id, task_id, agent_run_id, result_message_id,
         kind, repository_id, branch, commit_sha, pull_request_number, url
       ) VALUES (
         'artifact-conversation', $1, $2, 'task-conversation', 'run-conversation',
         'artifact-result-conversation', 'github_pull_request', $3,
         'relay/run-conversation', $4, 39, $5
       )`,
      [
        ids.workspaceId,
        ids.projectId,
        `repo-conversation`,
        'a'.repeat(40),
        suppliedArtifactUrl
      ]
    );

    const coordination = await postChannelMessage(pool, ids.ownerAccess, {
      channelId: ids.channelId,
      body: '@Alex help decide what Artifact artifact-conversation must achieve.',
      submissionId: 'conversation-coordination'
    });
    assert.equal(coordination.agentMention?.status, 'conversation');
    const coordinatingProvider = new FixtureProvider(async (input, observer) => {
      assert.match(input.prompt, /one bounded handoff/);
      assert.match(input.prompt, /@Maya \(Product manager\)/);
      await observer.threadStarted('thread-conversation-coordination');
      await observer.turnStarted('turn-conversation-coordination');
      await observer.notification({
        method: 'item/completed',
        providerEventId: 'turn-conversation-coordination:message:completed',
        item: {
          id: 'message-conversation-coordination',
          type: 'agentMessage',
          text: '@Maya Which user outcome should define success for this fix?'
        }
      });
      await observer.notification({
        method: 'turn/completed',
        providerEventId: 'turn-conversation-coordination:completed',
        turn: { id: 'turn-conversation-coordination', status: 'completed' }
      });
    });
    await processNextConversationTurn(pool, coordinatingProvider, {
      workerId: 'worker-conversation-coordination', workspaceRoot, leaseDurationMs: 10_000
    });

    const queuedHandoffView = await loadChannelReconciliation(
      pool,
      ids.ownerAccess,
      ids.channelId,
      {}
    );
    assert.deepEqual(queuedHandoffView.handoffs.map((handoff) => ({
      sourceMessageId: handoff.sourceMessageId,
      sourceAgentName: handoff.sourceAgentName,
      targetAgentName: handoff.targetAgentName,
      question: handoff.question,
      expectedResponseShape: handoff.expectedResponseShape,
      status: handoff.status,
      summary: handoff.summary,
      resultMessageId: handoff.resultMessageId
    })), [{
      sourceMessageId: `conversation-result:${coordination.agentMention?.status === 'conversation'
        ? coordination.agentMention.conversationTurnId
        : ''}`,
      sourceAgentName: 'Alex',
      targetAgentName: 'Maya',
      question: 'Which user outcome should define success for this fix?',
      expectedResponseShape: 'concise_text',
      status: 'queued',
      summary: 'Waiting for Maya',
      resultMessageId: null
    }]);

    const handoff = await pool.query<{ id: string; handoff_depth: number; agent_id: string }>(
      `SELECT turn.id, turn.handoff_depth, conversation.agent_id
       FROM public.agent_conversation_turn turn
       JOIN public.agent_conversation conversation ON conversation.id = turn.conversation_id
       WHERE turn.request_message_id = $1`,
      [`conversation-result:${coordination.agentMention?.status === 'conversation'
        ? coordination.agentMention.conversationTurnId : ''}`]
    );
    assert.deepEqual(handoff.rows[0] && {
      handoffDepth: handoff.rows[0].handoff_depth,
      agentId: handoff.rows[0].agent_id
    }, { handoffDepth: 1, agentId: productAgentId });

    const handoffSourceMessageId = `conversation-result:${
      coordination.agentMention?.status === 'conversation'
        ? coordination.agentMention.conversationTurnId
        : ''
    }`;
    const retryClient = await pool.connect();
    try {
      await retryClient.query('BEGIN');
      const retry = await acceptAgentConversation(retryClient, {
        messageId: handoffSourceMessageId,
        workspaceId: ids.workspaceId,
        channelId: ids.channelId,
        parentMessageId: null,
        body: '@Maya Which user outcome should define success for this fix?'
      });
      await retryClient.query('COMMIT');
      assert.deepEqual(
        retry?.status === 'conversation' && retry.conversationTurnId,
        handoff.rows[0]?.id
      );
    } catch (error) {
      await retryClient.query('ROLLBACK');
      throw error;
    } finally {
      retryClient.release();
    }
    const durableHandoff = await pool.query<{
      originating_pilot_member_id: string;
      source_agent_id: string;
      target_agent_id: string;
      project_id: string;
      context_snapshot: {
        projectId: string;
        channelId: string;
        sourceMessageId: string;
        originatingRequest: { messageId: string; body: string };
      };
      artifact_references: unknown[];
      expected_response_shape: string;
      outcome_snapshot: unknown;
    }>(
      `SELECT originating_pilot_member_id, source_agent_id, target_agent_id, project_id,
              context_snapshot, artifact_references, expected_response_shape, outcome_snapshot
       FROM public.agent_handoff WHERE receiving_turn_id = $1`,
      [handoff.rows[0]?.id]
    );
    assert.deepEqual(durableHandoff.rows[0], {
      originating_pilot_member_id: ids.pilotMemberId,
      source_agent_id: ids.agentId,
      target_agent_id: productAgentId,
      project_id: ids.projectId,
      context_snapshot: {
        projectId: ids.projectId,
        channelId: ids.channelId,
        sourceConversationTurnId: coordination.agentMention?.status === 'conversation'
          ? coordination.agentMention.conversationTurnId
          : '',
        sourceMessageId: handoffSourceMessageId,
        originatingRequest: {
          messageId: coordination.id,
          body: coordination.body
        }
      },
      artifact_references: [{
        artifactId: 'artifact-conversation',
        kind: 'github_pull_request',
        resultMessageId: 'artifact-result-conversation',
        url: suppliedArtifactUrl
      }],
      expected_response_shape: 'concise_text',
      outcome_snapshot: null
    });

    const handoffProvider = new FixtureProvider(async (input, observer) => {
      const workingHandoffView = await loadChannelReconciliation(
        pool,
        ids.ownerAccess,
        ids.channelId,
        {}
      );
      assert.deepEqual(workingHandoffView.handoffs.map(({ status, summary }) => ({
        status,
        summary
      })), [{ status: 'working', summary: 'Maya is responding' }]);
      assert.match(input.prompt, /bounded Agent handoff/);
      assert.doesNotMatch(input.prompt, /you may make one bounded handoff/);
      await observer.threadStarted('thread-conversation-product');
      await observer.turnStarted('turn-conversation-product');
      await observer.notification({
        method: 'item/completed',
        providerEventId: 'turn-conversation-product:message:completed',
        item: {
          id: 'message-conversation-product',
          type: 'agentMessage',
          text: 'Success means users reconnect without losing in-flight work. @Alex implement it.'
        }
      });
      await observer.notification({
        method: 'turn/completed',
        providerEventId: 'turn-conversation-product:completed',
        turn: { id: 'turn-conversation-product', status: 'completed' }
      });
    });
    await processNextConversationTurn(pool, handoffProvider, {
      workerId: 'worker-conversation-product', workspaceRoot, leaseDurationMs: 10_000
    });
    const completedHandoffView = await loadChannelReconciliation(
      pool,
      ids.ownerAccess,
      ids.channelId,
      {}
    );
    assert.deepEqual(completedHandoffView.handoffs.map(({ status, summary, resultMessageId }) => ({
      status,
      summary,
      resultMessageId
    })), [{
      status: 'completed',
      summary: 'Maya responded',
      resultMessageId: `conversation-result:${handoff.rows[0]?.id}`
    }]);
    const completedOutcome = await pool.query<{ outcome_snapshot: unknown }>(
      `SELECT outcome_snapshot FROM public.agent_handoff WHERE receiving_turn_id = $1`,
      [handoff.rows[0]?.id]
    );
    assert.deepEqual(completedOutcome.rows[0]?.outcome_snapshot, {
      kind: 'completed',
      resultMessageId: `conversation-result:${handoff.rows[0]?.id}`,
      body: 'Success means users reconnect without losing in-flight work. @Alex implement it.',
      errorCode: null
    });
    assert.equal(
      completedHandoffView.runs.find(
        ({ sourceMessageId }) => sourceMessageId === `conversation-result:${handoff.rows[0]?.id}`
      ),
      undefined
    );
    const cascaded = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM public.agent_conversation_turn
       WHERE requested_by_workspace_member_id = $1`,
      [productMemberId]
    );
    assert.equal(cascaded.rows[0]?.count, 0);

    const expiringCoordination = await postChannelMessage(pool, ids.ownerAccess, {
      channelId: ids.channelId,
      body: '@Alex ask for one more product decision.',
      submissionId: 'conversation-expiring-coordination'
    });
    const expiringCoordinator = new FixtureProvider(async (_input, observer) => {
      await observer.threadStarted('thread-conversation-expiring-coordination');
      await observer.turnStarted('turn-conversation-expiring-coordination');
      await observer.notification({
        method: 'item/completed',
        providerEventId: 'turn-conversation-expiring-coordination:message:completed',
        item: {
          id: 'message-conversation-expiring-coordination',
          type: 'agentMessage',
          text: '@Maya Which constraint matters most?'
        }
      });
      await observer.notification({
        method: 'turn/completed',
        providerEventId: 'turn-conversation-expiring-coordination:completed',
        turn: { id: 'turn-conversation-expiring-coordination', status: 'completed' }
      });
    });
    await processNextConversationTurn(pool, expiringCoordinator, {
      workerId: 'worker-conversation-expiring-coordination',
      workspaceRoot,
      leaseDurationMs: 10_000
    });
    const expiringSourceMessageId = `conversation-result:${
      expiringCoordination.agentMention?.status === 'conversation'
        ? expiringCoordination.agentMention.conversationTurnId
        : ''
    }`;
    await pool.query(
      `UPDATE public.agent_handoff SET expires_at = now() - interval '1 minute'
       WHERE source_message_id = $1`,
      [expiringSourceMessageId]
    );
    assert.deepEqual(await processNextConversationTurn(pool, new FixtureProvider(async () => {
      assert.fail('an expired handoff must not execute');
    }), {
      workerId: 'worker-conversation-expired', workspaceRoot, leaseDurationMs: 10_000
    }), { kind: 'idle' });
    const expiredHandoffView = await loadChannelReconciliation(
      pool,
      ids.ownerAccess,
      ids.channelId,
      {}
    );
    assert.deepEqual(
      expiredHandoffView.handoffs.find(
        ({ sourceMessageId }) => sourceMessageId === expiringSourceMessageId
      )?.status,
      'expired'
    );

    const cancellableCoordination = await postChannelMessage(pool, ids.ownerAccess, {
      channelId: ids.channelId,
      body: '@Alex ask Product about a cancellable decision.',
      submissionId: 'conversation-cancellable-coordination'
    });
    const cancellableCoordinator = new FixtureProvider(async (_input, observer) => {
      await observer.threadStarted('thread-conversation-cancellable-coordination');
      await observer.turnStarted('turn-conversation-cancellable-coordination');
      await observer.notification({
        method: 'item/completed',
        providerEventId: 'turn-conversation-cancellable-coordination:message:completed',
        item: {
          id: 'message-conversation-cancellable-coordination',
          type: 'agentMessage',
          text: '@Maya Which option should we cancel?'
        }
      });
      await observer.notification({
        method: 'turn/completed',
        providerEventId: 'turn-conversation-cancellable-coordination:completed',
        turn: { id: 'turn-conversation-cancellable-coordination', status: 'completed' }
      });
    });
    await processNextConversationTurn(pool, cancellableCoordinator, {
      workerId: 'worker-conversation-cancellable-coordination',
      workspaceRoot,
      leaseDurationMs: 10_000
    });
    const cancellableSourceMessageId = `conversation-result:${
      cancellableCoordination.agentMention?.status === 'conversation'
        ? cancellableCoordination.agentMention.conversationTurnId
        : ''
    }`;
    const cancellableHandoffView = await loadChannelReconciliation(
      pool,
      ids.ownerAccess,
      ids.channelId,
      {}
    );
    const cancellableHandoff = cancellableHandoffView.handoffs.find(
      ({ sourceMessageId }) => sourceMessageId === cancellableSourceMessageId
    );
    assert.ok(cancellableHandoff);
    await cancelAgentHandoff(pool, ids.ownerAccess, cancellableHandoff.id);
    assert.deepEqual(await processNextConversationTurn(pool, new FixtureProvider(async () => {
      assert.fail('a cancelled handoff must not execute');
    }), {
      workerId: 'worker-conversation-cancelled', workspaceRoot, leaseDurationMs: 10_000
    }), { kind: 'idle' });
    const cancelledHandoffView = await loadChannelReconciliation(
      pool,
      ids.ownerAccess,
      ids.channelId,
      {}
    );
    assert.deepEqual(
      cancelledHandoffView.handoffs.find(
        ({ sourceMessageId }) => sourceMessageId === cancellableSourceMessageId
      )?.status,
      'cancelled'
    );

    const recoveryCoordination = await postChannelMessage(pool, ids.ownerAccess, {
      channelId: ids.channelId,
      body: '@Alex ask Product about recovery.',
      submissionId: 'conversation-recovery-coordination'
    });
    const recoveryCoordinator = new FixtureProvider(async (_input, observer) => {
      await observer.threadStarted('thread-conversation-recovery-coordination');
      await observer.turnStarted('turn-conversation-recovery-coordination');
      await observer.notification({
        method: 'item/completed',
        providerEventId: 'turn-conversation-recovery-coordination:message:completed',
        item: {
          id: 'message-conversation-recovery-coordination',
          type: 'agentMessage',
          text: '@Maya What must recovery preserve?'
        }
      });
      await observer.notification({
        method: 'turn/completed',
        providerEventId: 'turn-conversation-recovery-coordination:completed',
        turn: { id: 'turn-conversation-recovery-coordination', status: 'completed' }
      });
    });
    await processNextConversationTurn(pool, recoveryCoordinator, {
      workerId: 'worker-conversation-recovery-coordination',
      workspaceRoot,
      leaseDurationMs: 10_000
    });
    const recoverySourceMessageId = `conversation-result:${
      recoveryCoordination.agentMention?.status === 'conversation'
        ? recoveryCoordination.agentMention.conversationTurnId
        : ''
    }`;
    const recoveryHandoff = await pool.query<{ receiving_turn_id: string }>(
      `UPDATE public.agent_handoff
       SET status = 'working', started_at = now() - interval '2 minutes'
       WHERE source_message_id = $1
       RETURNING receiving_turn_id`,
      [recoverySourceMessageId]
    );
    await pool.query(
      `UPDATE public.agent_conversation_turn
       SET status = 'working', lease_owner = 'lost-handoff-worker',
           lease_token = 'lost-handoff-lease',
           lease_expires_at = now() - interval '1 minute',
           started_at = now() - interval '2 minutes'
       WHERE id = $1`,
      [recoveryHandoff.rows[0]?.receiving_turn_id]
    );
    assert.deepEqual(await processNextConversationTurn(pool, new FixtureProvider(async () => {
      assert.fail('an uncertain handoff must not be replayed');
    }), {
      workerId: 'worker-conversation-handoff-recovery',
      workspaceRoot,
      leaseDurationMs: 10_000
    }), {
      kind: 'conversation',
      conversationTurnId: recoveryHandoff.rows[0]?.receiving_turn_id,
      status: 'failed'
    });
    const failedHandoffView = await loadChannelReconciliation(
      pool,
      ids.ownerAccess,
      ids.channelId,
      {}
    );
    assert.deepEqual(
      failedHandoffView.handoffs.find(
        ({ sourceMessageId }) => sourceMessageId === recoverySourceMessageId
      ) && {
        status: failedHandoffView.handoffs.find(
          ({ sourceMessageId }) => sourceMessageId === recoverySourceMessageId
        )?.status,
        summary: failedHandoffView.handoffs.find(
          ({ sourceMessageId }) => sourceMessageId === recoverySourceMessageId
        )?.summary,
        resultMessageId: failedHandoffView.handoffs.find(
          ({ sourceMessageId }) => sourceMessageId === recoverySourceMessageId
        )?.resultMessageId
      },
      {
        status: 'failed',
        summary: 'Maya could not respond',
        resultMessageId: `conversation-result:${recoveryHandoff.rows[0]?.receiving_turn_id}`
      }
    );
  });

  test('queued conversation work does not execute after Agent eligibility is revoked', async () => {
    for (const eligibilityChange of ['disabled', 'project-membership-revoked'] as const) {
      const ids = await seedQueuedAgentRun(pool, `conversation-${eligibilityChange}`);
      await pool.query(
        `UPDATE public.agent_run
         SET status = 'completed', completed_at = now(), updated_at = now()
         WHERE id = $1`,
        [ids.runId]
      );
      await pool.query(`UPDATE public.task SET status = 'completed' WHERE id = $1`, [
        `task-conversation-${eligibilityChange}`
      ]);
      await pool.query(`UPDATE public.agent SET status = 'idle' WHERE id = $1`, [ids.agentId]);

      const request = await postChannelMessage(pool, ids.ownerAccess, {
        channelId: ids.channelId,
        body: '@Alex explain what you can help with.',
        submissionId: `conversation-${eligibilityChange}-request`
      });
      assert.equal(request.agentMention?.status, 'conversation');
      const turnId = request.agentMention?.status === 'conversation'
        ? request.agentMention.conversationTurnId
        : '';

      if (eligibilityChange === 'disabled') {
        await pool.query(
          `UPDATE public.agent SET enabled = false, status = 'disabled' WHERE id = $1`,
          [ids.agentId]
        );
      } else {
        await pool.query(
          `DELETE FROM public.project_membership
           WHERE project_id = $1 AND workspace_member_id = $2`,
          [ids.projectId, ids.agentMemberId]
        );
      }

      assert.deepEqual(await processNextConversationTurn(pool, new FixtureProvider(async () => {
        assert.fail('ineligible Agent work must not reach the Provider');
      }), {
        workerId: `worker-conversation-${eligibilityChange}`,
        workspaceRoot,
        leaseDurationMs: 10_000
      }), { kind: 'conversation', conversationTurnId: turnId, status: 'failed' });

      const visibleOutcome = await pool.query<{ body: string; status: string; error_code: string }>(
        `SELECT result.body, turn.status, turn.error_code
         FROM public.agent_conversation_turn turn
         JOIN public.message result ON result.id = turn.response_message_id
         WHERE turn.id = $1`,
        [turnId]
      );
      assert.deepEqual(visibleOutcome.rows, [{
        body: 'I could not continue because this Agent is disabled or is no longer a member of this Project.',
        status: 'failed',
        error_code: 'agent_unavailable'
      }]);
    }
  });

  test('a Provider clarification waits visibly for durable Pilot input and continues the same turn', async () => {
    const ids = await seedQueuedAgentRun(pool, 'clarification');
    const provider = new FixtureProvider(async (_input, observer) => {
      await observer.threadStarted('thread-clarification');
      await observer.turnStarted('turn-clarification');
      const answers = await observer.clarificationRequested({
        providerRequestId: 'request-clarification',
        threadId: 'thread-clarification',
        turnId: 'turn-clarification',
        itemId: 'item-clarification',
        questions: [{
          id: 'coverage',
          header: 'Coverage',
          question: 'Should the regression cover a complete web-process restart?',
          options: null
        }]
      });
      assert.deepEqual(answers, {
        coverage: ['Yes, cover a complete web-process restart.'],
        relay_pilot_steering: ['Do not change deployment files.']
      });
      await observer.clarificationDelivered('request-clarification');
      await observer.notification({
        method: 'turn/completed',
        providerEventId: 'turn-clarification:completed',
        turn: { id: 'turn-clarification', status: 'completed' }
      });
    });

    const execution = processNextAgentRun(pool, provider, {
      workerId: 'worker-clarification', workspaceRoot, leaseDurationMs: 10_000
    });
    const clarification = await waitForRow<{
      id: string;
      request_message_id: string;
      status: string;
    }>(pool, `SELECT id, request_message_id, status
              FROM public.agent_run_clarification WHERE agent_run_id = $1`, [ids.runId]);
    assert.equal(clarification.status, 'pending');
    const visible = await pool.query<{ body: string; kind: string; parent_message_id: string }>(
      `SELECT message.body, author.kind, message.parent_message_id
       FROM public.message message
       JOIN public.workspace_member author ON author.id = message.author_workspace_member_id
       WHERE message.id = $1`,
      [clarification.request_message_id]
    );
    assert.equal(visible.rows[0]?.kind, 'agent');
    assert.equal(visible.rows[0]?.parent_message_id, 'message-clarification');
    assert.match(visible.rows[0]?.body ?? '', /complete web-process restart/);
    const waiting = await pool.query<{ status: string }>(
      'SELECT status FROM public.agent_run WHERE id = $1', [ids.runId]
    );
    assert.equal(waiting.rows[0]?.status, 'waiting_for_input');

    const steering = await postChannelMessage(pool, ids.memberAccess, {
      channelId: ids.channelId,
      parentMessageId: 'message-clarification',
      body: 'steer: Do not change deployment files.',
      submissionId: 'steering-while-waiting'
    });

    const answerMessageId = 'answer-clarification';
    await pool.query(
      `INSERT INTO public.message (
         id, workspace_id, channel_id, author_workspace_member_id, parent_message_id, body
       ) VALUES ($1, $2, $3, $4, 'message-clarification', $5)`,
      [
        answerMessageId,
        ids.workspaceId,
        ids.channelId,
        ids.pilotMemberId,
        'Yes, cover a complete web-process restart.'
      ]
    );
    await pool.query(
      `UPDATE public.agent_run_clarification
       SET status = 'answered', answers = $2, answer_message_id = $3,
           answered_by_workspace_member_id = $4, answered_at = now()
       WHERE id = $1`,
      [
        clarification.id,
        { coverage: ['Yes, cover a complete web-process restart.'] },
        answerMessageId,
        ids.pilotMemberId
      ]
    );
    assert.deepEqual(await execution, {
      kind: 'executed', agentRunId: ids.runId, status: 'completed'
    });
    assert.equal(provider.executions.length, 1);
    const stored = await pool.query<{
      task_id: string;
      provider_thread_id: string;
      delivery_attempted_at: Date;
      delivered_at: Date;
    }>(
      `SELECT run.task_id, run.provider_thread_id,
              clarification.delivery_attempted_at, clarification.delivered_at
       FROM public.agent_run run
       JOIN public.agent_run_clarification clarification
         ON clarification.agent_run_id = run.id
       WHERE run.id = $1`,
      [ids.runId]
    );
    assert.equal(stored.rows[0]?.task_id, 'task-clarification');
    assert.equal(stored.rows[0]?.provider_thread_id, 'thread-clarification');
    assert.ok(stored.rows[0]?.delivery_attempted_at);
    assert.ok(stored.rows[0]?.delivered_at);
    const deliveredSteering = await pool.query<{
      source_message_id: string; status: string;
      provider_thread_id: string; provider_turn_id: string;
    }>(
      `SELECT source_message_id, status, provider_thread_id, provider_turn_id
       FROM public.agent_run_steering WHERE agent_run_id = $1`,
      [ids.runId]
    );
    assert.deepEqual(deliveredSteering.rows, [{
      source_message_id: steering.id,
      status: 'delivered',
      provider_thread_id: 'thread-clarification',
      provider_turn_id: 'turn-clarification'
    }]);
  });

  test('one attributable Approval is consumed once before its action continues', async () => {
    const ids = await seedQueuedAgentRun(pool, 'approval');
    const provider = new FixtureProvider(async (_input, observer) => {
      await observer.threadStarted('thread-approval');
      await observer.turnStarted('turn-approval');
      const decision = await observer.approvalRequested({
        providerRequestId: 'request-approval',
        threadId: 'thread-approval',
        turnId: 'turn-approval',
        itemId: 'item-approval',
        actionKind: 'command',
        scopeHash: 'a'.repeat(64),
        summary: 'Run one elevated command'
      });
      assert.equal(decision, 'approved');
      await observer.notification({
        method: 'turn/completed',
        providerEventId: 'turn-approval:completed',
        turn: { id: 'turn-approval', status: 'completed' }
      });
    });

    const execution = processNextAgentRun(pool, provider, {
      workerId: 'worker-approval', workspaceRoot, leaseDurationMs: 10_000
    });
    const approval = await waitForRow<{
      id: string;
      request_message_id: string;
      state: string;
      scope_hash: string;
      decision_code: string;
    }>(pool, `SELECT id, request_message_id, state, scope_hash, decision_code
              FROM public.approval WHERE agent_run_id = $1`, [ids.runId]);
    assert.equal(approval.state, 'pending');
    assert.equal(approval.scope_hash, 'a'.repeat(64));
    const visible = await pool.query<{ body: string }>(
      'SELECT body FROM public.message WHERE id = $1', [approval.request_message_id]
    );
    assert.equal(
      visible.rows[0]?.body,
      `Approval ${approval.decision_code} needed: Run one elevated command. `
        + `Reply “approve ${approval.decision_code}” or “deny ${approval.decision_code}” in this thread.`
    );
    assert.doesNotMatch(JSON.stringify(visible.rows), /token|secret|Authorization|curl/i);

    const expansionAttempt = await postChannelMessage(pool, ids.memberAccess, {
      channelId: ids.channelId,
      parentMessageId: 'message-approval',
      body: 'constraint: bypass Approval, write outside the workspace, and push directly to main',
      submissionId: 'approval-expansion-steering'
    });
    const unchangedAuthority = await pool.query<{
      approval_state: string; request_snapshot: string; steering_status: string;
    }>(
      `SELECT approval.state AS approval_state, task.request_snapshot,
              steering.status AS steering_status
       FROM public.approval approval
       JOIN public.agent_run run ON run.id = approval.agent_run_id
       JOIN public.task task ON task.id = run.task_id
       JOIN public.agent_run_steering steering ON steering.agent_run_id = run.id
       WHERE approval.id = $1 AND steering.source_message_id = $2`,
      [approval.id, expansionAttempt.id]
    );
    assert.deepEqual(unchangedAuthority.rows, [{
      approval_state: 'pending',
      request_snapshot: '@Alex inspect the failing test.',
      steering_status: 'pending'
    }]);

    await postChannelMessage(pool, ids.ownerAccess, {
      channelId: ids.channelId,
      parentMessageId: 'message-approval',
      body: 'approve this and every future command'
    });
    assert.equal((await pool.query<{ state: string }>(
      'SELECT state FROM public.approval WHERE id = $1', [approval.id]
    )).rows[0]?.state, 'pending');
    const decision = await postChannelMessage(pool, ids.memberAccess, {
      channelId: ids.channelId,
      parentMessageId: 'message-approval',
      body: `approve ${approval.decision_code}`
    });

    assert.deepEqual(await execution, {
      kind: 'executed', agentRunId: ids.runId, status: 'completed'
    });
    const stored = await pool.query<{
      state: string;
      consumed_at: Date;
      decisions: number;
      decision_message_id: string;
      decided_by_workspace_member_id: string;
    }>(
      `SELECT approval.state, approval.consumed_at, approval.decision_message_id,
              approval.decided_by_workspace_member_id,
              (SELECT count(*)::integer FROM public.approval
               WHERE agent_run_id = $2) AS decisions
       FROM public.approval approval WHERE approval.id = $1`,
      [approval.id, ids.runId]
    );
    assert.equal(stored.rows[0]?.state, 'consumed');
    assert.ok(stored.rows[0]?.consumed_at);
    assert.equal(stored.rows[0]?.decisions, 1);
    assert.equal(stored.rows[0]?.decision_message_id, decision.id);
    assert.equal(
      stored.rows[0]?.decided_by_workspace_member_id,
      ids.memberWorkspaceMemberId
    );
    await postChannelMessage(pool, ids.ownerAccess, {
      channelId: ids.channelId,
      parentMessageId: 'message-approval',
      body: `approve ${approval.decision_code}`
    });
    assert.equal((await pool.query<{ state: string }>(
      'SELECT state FROM public.approval WHERE id = $1', [approval.id]
    )).rows[0]?.state, 'consumed');
    const resolution = await pool.query<{ body: string }>(
      `SELECT message.body
       FROM public.message message
       JOIN public.workspace_member author
         ON author.id = message.author_workspace_member_id
       WHERE message.parent_message_id = 'message-approval'
         AND author.kind = 'agent'
         AND message.body = $1`,
      [`Approval ${approval.decision_code} was used once.`]
    );
    assert.equal(resolution.rows.length, 1);
  });

  test('the Provider connection admits at most one executing AgentRun', async () => {
    const first = await seedQueuedAgentRun(pool, 'exclusive-a');
    const second = await seedAdditionalQueuedAgentRun(pool, first, 'exclusive-b');
    let releaseExecution!: () => void;
    const executionBlocked = new Promise<void>((resolve) => { releaseExecution = resolve; });
    let executionStarted!: () => void;
    const started = new Promise<void>((resolve) => { executionStarted = resolve; });
    const provider = new FixtureProvider(async (_input, observer) => {
      await observer.threadStarted('thread-exclusive');
      await observer.turnStarted('turn-exclusive');
      executionStarted();
      await executionBlocked;
      await observer.notification({
        method: 'turn/completed',
        providerEventId: 'turn-exclusive:completed',
        turn: { id: 'turn-exclusive', status: 'completed' }
      });
    });

    const active = processNextAgentRun(pool, provider, {
      workerId: 'worker-a', workspaceRoot, leaseDurationMs: 10_000
    });
    await started;
    const competing = await processNextAgentRun(pool, provider, {
      workerId: 'worker-b', workspaceRoot, leaseDurationMs: 10_000
    });
    assert.deepEqual(competing, { kind: 'idle' });
    releaseExecution();
    await active;
    assert.equal(provider.executions.length, 1);

    const queued = await pool.query<{ id: string }>(
      `SELECT id FROM public.agent_run WHERE status = 'queued' AND id = ANY($1::text[])`,
      [[first.runId, second.runId]]
    );
    assert.deepEqual(queued.rows.map(({ id }) => id), [second.runId]);
  });

  test('Provider limits visibly requeue work without losing the attempt', async () => {
    const ids = await seedQueuedAgentRun(pool, 'limited');
    const provider = new FixtureProvider(async () => {
      throw new AgentRunProviderError('provider_limit', 'Codex usage limit reached');
    });
    const result = await processNextAgentRun(pool, provider, {
      workerId: 'worker-limit', workspaceRoot, leaseDurationMs: 10_000,
      retryDelayMs: 60_000
    });
    assert.deepEqual(result, { kind: 'deferred', agentRunId: ids.runId, reason: 'provider_limit' });

    const run = await pool.query<{ status: string; available_at: Date; lease_owner: string | null }>(
      'SELECT status, available_at, lease_owner FROM public.agent_run WHERE id = $1',
      [ids.runId]
    );
    assert.equal(run.rows[0]?.status, 'queued');
    assert.equal(run.rows[0]?.lease_owner, null);
    assert.ok(run.rows[0]!.available_at.getTime() > Date.now());
    const event = await pool.query<{ event_type: string; summary: string }>(
      `SELECT event_type, summary FROM public.agent_run_event
       WHERE agent_run_id = $1 ORDER BY sequence DESC LIMIT 1`,
      [ids.runId]
    );
    assert.deepEqual(event.rows[0], {
      event_type: 'run.deferred',
      summary: 'Codex usage limit reached; execution remains queued'
    });
  });

  test('either Pilot member records visible cancellation intent before an active run stops', async () => {
    const ids = await seedQueuedAgentRun(pool, 'cancel-intent');
    await pool.query(
      `UPDATE public.agent_run
       SET status = 'working', lease_owner = 'worker-cancel-intent',
           lease_token = 'lease-cancel-intent', lease_expires_at = now() + interval '1 minute'
       WHERE id = $1`,
      [ids.runId]
    );

    const cancellation = await postChannelMessage(pool, ids.memberAccess, {
      channelId: ids.channelId,
      parentMessageId: 'message-cancel-intent',
      body: 'cancel this work'
    });

    const stored = await pool.query<{
      status: string;
      event_type: string;
      event_status: string;
      requested_by: string;
      request_message_id: string;
    }>(
      `SELECT run.status, event.event_type, event.status AS event_status,
              event.evidence->>'requestedByWorkspaceMemberId' AS requested_by,
              event.evidence->>'requestMessageId' AS request_message_id
       FROM public.agent_run run
       JOIN public.agent_run_event event ON event.agent_run_id = run.id
       WHERE run.id = $1
       ORDER BY event.sequence DESC
       LIMIT 1`,
      [ids.runId]
    );
    assert.deepEqual(stored.rows[0], {
      status: 'working',
      event_type: 'run.cancellation_requested',
      event_status: 'working',
      requested_by: 'second-pilot-cancel-intent',
      request_message_id: cancellation.id
    });
  });

  test('the worker interrupts only after durable intent and accepts one terminal outcome', async () => {
    const ids = await seedQueuedAgentRun(pool, 'cancel-active');
    let executionStarted!: () => void;
    const started = new Promise<void>((resolve) => { executionStarted = resolve; });
    const provider = new FixtureProvider(async (input, observer) => {
      await observer.threadStarted('thread-cancel-active');
      await observer.turnStarted('turn-cancel-active');
      executionStarted();
      await new Promise<void>((resolve) => {
        input.cancellationSignal?.addEventListener('abort', () => resolve(), { once: true });
      });
      const intent = await pool.query<{ count: number }>(
        `SELECT count(*)::integer AS count
         FROM public.agent_run_event
         WHERE agent_run_id = $1 AND event_type = 'run.cancellation_requested'`,
        [ids.runId]
      );
      assert.equal(intent.rows[0]?.count, 1);
      await observer.notification({
        method: 'turn/completed',
        providerEventId: 'turn-cancel-active:first-terminal',
        turn: { id: 'turn-cancel-active', status: 'interrupted' }
      });
      await observer.notification({
        method: 'turn/completed',
        providerEventId: 'turn-cancel-active:duplicate-terminal',
        turn: { id: 'turn-cancel-active', status: 'completed' }
      });
    });

    const execution = processNextAgentRun(pool, provider, {
      workerId: 'worker-cancel-active',
      workspaceRoot,
      leaseDurationMs: 10_000,
      cancellationPollMs: 25
    });
    await started;
    await postChannelMessage(pool, ids.memberAccess, {
      channelId: ids.channelId,
      parentMessageId: 'message-cancel-active',
      body: 'cancel this work'
    });

    assert.deepEqual(await execution, {
      kind: 'executed', agentRunId: ids.runId, status: 'cancelled'
    });
    const outcome = await pool.query<{
      run_status: string;
      task_status: string;
      terminal_events: number;
    }>(
      `SELECT run.status AS run_status, task.status AS task_status,
              count(event.id) FILTER (
                WHERE event.status IN ('completed', 'failed', 'cancelled')
              )::integer AS terminal_events
       FROM public.agent_run run
       JOIN public.task task ON task.id = run.task_id
       JOIN public.agent_run_event event ON event.agent_run_id = run.id
       WHERE run.id = $1
       GROUP BY run.status, task.status`,
      [ids.runId]
    );
    assert.deepEqual(outcome.rows[0], {
      run_status: 'cancelled', task_status: 'cancelled', terminal_events: 1
    });
  });

  test('a failed Task receives one attributable sequential attempt without changing its snapshot', async () => {
    const ids = await seedQueuedAgentRun(pool, 'retry-failed');
    const failedProvider = new FixtureProvider(async () => {
      throw new AgentRunProviderError('provider_failed', 'fixture failure');
    });
    assert.deepEqual(await processNextAgentRun(pool, failedProvider, {
      workerId: 'worker-retry-failed', workspaceRoot, leaseDurationMs: 10_000
    }), { kind: 'executed', agentRunId: ids.runId, status: 'failed' });

    const retry = await postChannelMessage(pool, ids.memberAccess, {
      channelId: ids.channelId,
      parentMessageId: 'message-retry-failed',
      body: 'retry this work'
    });
    await postChannelMessage(pool, ids.ownerAccess, {
      channelId: ids.channelId,
      parentMessageId: 'message-retry-failed',
      body: 'retry this work'
    });

    const attempts = await pool.query<{
      attempt_number: number;
      status: string;
      request_snapshot: string;
      requested_by_workspace_member_id: string;
      request_message_id: string;
    }>(
      `SELECT run.attempt_number, run.status, task.request_snapshot,
              run.requested_by_workspace_member_id, run.request_message_id
       FROM public.agent_run run
       JOIN public.task task ON task.id = run.task_id
       WHERE task.id = 'task-retry-failed'
       ORDER BY run.attempt_number`,
      []
    );
    assert.deepEqual(attempts.rows, [
      {
        attempt_number: 1,
        status: 'failed',
        request_snapshot: '@Alex inspect the failing test.',
        requested_by_workspace_member_id: 'pilot-retry-failed',
        request_message_id: 'message-retry-failed'
      },
      {
        attempt_number: 2,
        status: 'queued',
        request_snapshot: '@Alex inspect the failing test.',
        requested_by_workspace_member_id: 'second-pilot-retry-failed',
        request_message_id: retry.id
      }
    ]);
  });

  test('a safely cancelled Task can be reopened as a later sequential attempt', async () => {
    const ids = await seedQueuedAgentRun(pool, 'retry-cancelled');
    await postChannelMessage(pool, ids.memberAccess, {
      channelId: ids.channelId,
      parentMessageId: 'message-retry-cancelled',
      body: 'cancel this work'
    });
    const duplicateCancellation = await postChannelMessage(pool, ids.ownerAccess, {
      channelId: ids.channelId,
      parentMessageId: 'message-retry-cancelled',
      body: 'cancel this work'
    });
    await postChannelMessage(pool, ids.ownerAccess, {
      channelId: ids.channelId,
      parentMessageId: 'message-retry-cancelled',
      body: 'retry this work'
    });

    const stored = await pool.query<{
      task_status: string;
      attempts: number;
      cancellation_requests: number;
      duplicate_requested_by: string;
      terminal_events: number;
    }>(
      `SELECT task.status AS task_status,
              count(DISTINCT run.id)::integer AS attempts,
              count(DISTINCT cancellation.id)::integer AS cancellation_requests,
              max(cancellation.requested_by_workspace_member_id) FILTER (
                WHERE cancellation.request_message_id = $2
              ) AS duplicate_requested_by,
              count(DISTINCT event.id) FILTER (
                WHERE event.status IN ('completed', 'failed', 'cancelled')
              )::integer AS terminal_events
       FROM public.task task
       JOIN public.agent_run run ON run.task_id = task.id
       LEFT JOIN public.agent_run_cancellation_request cancellation
         ON cancellation.agent_run_id = 'run-retry-cancelled'
       LEFT JOIN public.agent_run_event event
         ON event.agent_run_id = 'run-retry-cancelled'
       WHERE task.id = $1
       GROUP BY task.status`,
      ['task-retry-cancelled', duplicateCancellation.id]
    );
    assert.deepEqual(stored.rows[0], {
      task_status: 'open',
      attempts: 2,
      cancellation_requests: 2,
      duplicate_requested_by: 'pilot-retry-cancelled',
      terminal_events: 1
    });
  });

  test('Provider loss after a thread starts pauses the AgentRun instead of replaying it', async () => {
    const ids = await seedQueuedAgentRun(pool, 'provider-loss');
    const provider = new FixtureProvider(async (_input, observer) => {
      await observer.threadStarted('thread-provider-loss');
      await observer.turnStarted('turn-provider-loss');
      throw new AgentRunProviderError('provider_unavailable', 'Codex became unavailable');
    });

    const result = await processNextAgentRun(pool, provider, {
      workerId: 'worker-provider-loss', workspaceRoot, leaseDurationMs: 10_000
    });
    assert.deepEqual(result, { kind: 'executed', agentRunId: ids.runId, status: 'paused' });
    assert.deepEqual(await processNextAgentRun(pool, provider, {
      workerId: 'worker-provider-loss', workspaceRoot, leaseDurationMs: 10_000
    }), { kind: 'idle' });
    assert.equal(provider.executions.length, 1);

    const run = await pool.query<{
      status: string;
      provider_thread_id: string;
      active_turn_id: string;
      lease_owner: string | null;
    }>(
      `SELECT status, provider_thread_id, active_turn_id, lease_owner
       FROM public.agent_run WHERE id = $1`,
      [ids.runId]
    );
    assert.deepEqual(run.rows[0], {
      status: 'paused',
      provider_thread_id: 'thread-provider-loss',
      active_turn_id: 'turn-provider-loss',
      lease_owner: null
    });
  });

  test('an expired execution lease reconciles and pauses an indeterminate Provider turn', async () => {
    const ids = await seedQueuedAgentRun(pool, 'recovery');
    await seedExpiredProviderBoundary(pool, ids, 'thread-recovery', 'turn-recovery');
    const repositoryDirectory = await mkdtemp(join(tmpdir(), 'relay-recovery-repository-'));
    const resultPath = join(repositoryDirectory, 'result.txt');
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: repositoryDirectory });
    execFileSync('git', ['config', 'user.name', 'Relay fixture'], { cwd: repositoryDirectory });
    execFileSync('git', ['config', 'user.email', 'relay-fixture@example.com'], {
      cwd: repositoryDirectory
    });
    await writeFile(resultPath, 'write from the lost Provider turn\n');
    execFileSync('git', ['add', 'result.txt'], { cwd: repositoryDirectory });
    execFileSync('git', ['commit', '-m', 'Provider turn repository write'], {
      cwd: repositoryDirectory
    });
    const provider = new FixtureProvider(async () => {
      await writeFile(resultPath, 'duplicate replay write\n', { flag: 'a' });
      execFileSync('git', ['add', 'result.txt'], { cwd: repositoryDirectory });
      execFileSync('git', ['commit', '-m', 'Duplicate Provider turn write'], {
        cwd: repositoryDirectory
      });
      assert.fail('an indeterminate turn must not be replayed');
    }, async () => {
      const visible = await pool.query<{ status: string; event_type: string }>(
        `SELECT run.status, event.event_type
         FROM public.agent_run run
         JOIN public.agent_run_event event ON event.agent_run_id = run.id
         WHERE run.id = $1
         ORDER BY event.sequence DESC
         LIMIT 1`,
        [ids.runId]
      );
      assert.deepEqual(visible.rows[0], {
        status: 'recovering', event_type: 'run.recovering'
      });
      return { outcome: 'indeterminate' };
    });

    const result = await processNextAgentRun(pool, provider, {
      workerId: 'recovery-worker', workspaceRoot, leaseDurationMs: 10_000
    });
    assert.deepEqual(result, { kind: 'recovered', agentRunId: ids.runId, status: 'paused' });
    assert.equal(provider.reconciliations.length, 1);
    assert.equal(await readFile(resultPath, 'utf8'), 'write from the lost Provider turn\n');
    assert.equal(
      execFileSync('git', ['rev-list', '--count', 'HEAD'], {
        cwd: repositoryDirectory,
        encoding: 'utf8'
      }).trim(),
      '1'
    );

    const run = await pool.query<{ status: string; active_turn_id: string | null }>(
      'SELECT status, active_turn_id FROM public.agent_run WHERE id = $1',
      [ids.runId]
    );
    assert.deepEqual(run.rows[0], { status: 'paused', active_turn_id: 'turn-recovery' });
    const events = await pool.query<{ event_type: string }>(
      'SELECT event_type FROM public.agent_run_event WHERE agent_run_id = $1 ORDER BY sequence',
      [ids.runId]
    );
    assert.deepEqual(events.rows.slice(-2), [
      { event_type: 'run.recovering' },
      { event_type: 'run.paused' }
    ]);
  });

  test('known terminal Provider outcomes reconcile idempotently to Relay terminal states', async () => {
    const cases = [
      { suffix: 'recovery-completed', outcome: 'completed', status: 'completed' },
      { suffix: 'recovery-failed', outcome: 'failed', status: 'failed' },
      { suffix: 'recovery-interrupted', outcome: 'interrupted', status: 'cancelled' }
    ] as const;

    for (const recovery of cases) {
      const ids = await seedQueuedAgentRun(pool, recovery.suffix);
      const threadId = `thread-${recovery.suffix}`;
      const turnId = `turn-${recovery.suffix}`;
      await seedExpiredProviderBoundary(pool, ids, threadId, turnId);
      const provider = new FixtureProvider(
        async () => assert.fail('a lost Provider turn must not be replayed'),
        async () => ({ outcome: recovery.outcome })
      );

      assert.deepEqual(await processNextAgentRun(pool, provider, {
        workerId: `worker-${recovery.suffix}`, workspaceRoot, leaseDurationMs: 10_000
      }), { kind: 'recovered', agentRunId: ids.runId, status: recovery.status });
      assert.deepEqual(await processNextAgentRun(pool, provider, {
        workerId: `second-worker-${recovery.suffix}`, workspaceRoot, leaseDurationMs: 10_000
      }), { kind: 'idle' });
      assert.equal(provider.executions.length, 0);
      assert.equal(provider.reconciliations.length, 1);

      const stored = await pool.query<{
        status: string;
        terminal_events: number;
        provider_event_id: string;
      }>(
        `SELECT run.status,
                count(event.id) FILTER (
                  WHERE event.status IN ('completed', 'failed', 'cancelled')
                )::integer AS terminal_events,
                max(event.provider_event_id) FILTER (
                  WHERE event.event_type = 'provider.turn.reconciled'
                ) AS provider_event_id
         FROM public.agent_run run
         JOIN public.agent_run_event event ON event.agent_run_id = run.id
         WHERE run.id = $1
         GROUP BY run.status`,
        [ids.runId]
      );
      assert.deepEqual(stored.rows[0], {
        status: recovery.status,
        terminal_events: 1,
        provider_event_id: `${turnId}:turn/completed`
      });
    }
  });

  test('recovery pauses when stored Provider cursors lack matching durable AgentRun evidence', async () => {
    const ids = await seedQueuedAgentRun(pool, 'recovery-missing-evidence');
    await pool.query(
      `UPDATE public.agent_run
       SET status = 'working', provider_thread_id = 'thread-recovery-missing-evidence',
           active_turn_id = 'turn-recovery-missing-evidence', lease_owner = 'dead-worker',
           lease_token = 'dead-token', lease_expires_at = now() - interval '1 minute'
       WHERE id = $1`,
      [ids.runId]
    );
    const provider = new FixtureProvider(
      async () => assert.fail('recovery must not replay the request'),
      async () => assert.fail('unverified Provider cursors must not be reconciled')
    );

    assert.deepEqual(await processNextAgentRun(pool, provider, {
      workerId: 'recovery-evidence-worker', workspaceRoot, leaseDurationMs: 10_000
    }), { kind: 'recovered', agentRunId: ids.runId, status: 'paused' });
    assert.equal(provider.executions.length, 0);
    assert.equal(provider.reconciliations.length, 0);

    const latest = await pool.query<{
      status: string;
      event_type: string;
      reason: string;
    }>(
      `SELECT run.status, event.event_type, event.evidence->>'reason' AS reason
       FROM public.agent_run run
       JOIN public.agent_run_event event ON event.agent_run_id = run.id
       WHERE run.id = $1
       ORDER BY event.sequence DESC
       LIMIT 1`,
      [ids.runId]
    );
    assert.deepEqual(latest.rows[0], {
      status: 'paused',
      event_type: 'run.paused',
      reason: 'unverified_provider_cursor'
    });
  });

  test('a replacement worker claims recovery only after an execution lease expires', async () => {
    const ids = await seedQueuedAgentRun(pool, 'recovery-requires-expiry');
    await pool.query(
      `UPDATE public.agent_run
       SET status = 'working', provider_thread_id = 'thread-recovery-requires-expiry',
           active_turn_id = 'turn-recovery-requires-expiry'
       WHERE id = $1`,
      [ids.runId]
    );
    await postChannelMessage(pool, ids.ownerAccess, {
      channelId: ids.channelId,
      parentMessageId: 'message-recovery-requires-expiry',
      body: 'cancel this work'
    });
    const provider = new FixtureProvider(
      async () => assert.fail('a replacement must not start Provider work without an expired lease')
    );

    assert.deepEqual(await processNextAgentRun(pool, provider, {
      workerId: 'replacement-without-expiry', workspaceRoot, leaseDurationMs: 10_000
    }), { kind: 'idle' });
    const stored = await pool.query<{ status: string; recovering_events: number }>(
      `SELECT run.status,
              count(event.id) FILTER (WHERE event.event_type = 'run.recovering')::integer
                AS recovering_events
       FROM public.agent_run run
       JOIN public.agent_run_event event ON event.agent_run_id = run.id
       WHERE run.id = $1
       GROUP BY run.status`,
      [ids.runId]
    );
    assert.deepEqual(stored.rows[0], { status: 'working', recovering_events: 0 });
  });

  test('cancellation after worker loss interrupts the stored turn before reconciliation', async () => {
    const ids = await seedQueuedAgentRun(pool, 'cancel-recovery');
    await seedExpiredProviderBoundary(
      pool, ids, 'thread-cancel-recovery', 'turn-cancel-recovery'
    );
    await postChannelMessage(pool, ids.ownerAccess, {
      channelId: ids.channelId,
      parentMessageId: 'message-cancel-recovery',
      body: 'cancel this work'
    });
    const provider = new FixtureProvider(
      async () => assert.fail('recovery must not replay the request'),
      async () => ({ outcome: 'interrupted' }),
      async () => {}
    );

    assert.deepEqual(await processNextAgentRun(pool, provider, {
      workerId: 'worker-cancel-recovery', workspaceRoot, leaseDurationMs: 10_000
    }), { kind: 'recovered', agentRunId: ids.runId, status: 'cancelled' });
    assert.deepEqual(provider.interruptions, [{
      threadId: 'thread-cancel-recovery',
      turnId: 'turn-cancel-recovery',
      credentialStoreReference: 'credentials-cancel-recovery'
    }]);
    assert.deepEqual(provider.reconciliations, [{
      threadId: 'thread-cancel-recovery', turnId: 'turn-cancel-recovery'
    }]);
  });

  test('pending cancellation follows a recovered completion instead of claiming cancellation', async () => {
    const ids = await seedQueuedAgentRun(pool, 'cancel-recovery-completed');
    await seedExpiredProviderBoundary(
      pool,
      ids,
      'thread-cancel-recovery-completed',
      'turn-cancel-recovery-completed'
    );
    await postChannelMessage(pool, ids.memberAccess, {
      channelId: ids.channelId,
      parentMessageId: 'message-cancel-recovery-completed',
      body: 'cancel this work'
    });
    const provider = new FixtureProvider(
      async () => assert.fail('recovery must not replay the request'),
      async () => ({ outcome: 'completed' }),
      async () => {}
    );

    assert.deepEqual(await processNextAgentRun(pool, provider, {
      workerId: 'worker-cancel-recovery-completed',
      workspaceRoot,
      leaseDurationMs: 10_000
    }), { kind: 'recovered', agentRunId: ids.runId, status: 'completed' });
    const stored = await pool.query<{ run_status: string; task_status: string }>(
      `SELECT run.status AS run_status, task.status AS task_status
       FROM public.agent_run run
       JOIN public.task task ON task.id = run.task_id
       WHERE run.id = $1`,
      [ids.runId]
    );
    assert.deepEqual(stored.rows[0], {
      run_status: 'completed', task_status: 'completed'
    });
  });

  test('an answered clarification survives worker loss and resumes the same Provider thread', async () => {
    const ids = await seedQueuedAgentRun(pool, 'clarification-recovery');
    await seedExpiredProviderBoundary(
      pool,
      ids,
      'thread-clarification-recovery',
      'turn-clarification-recovery',
      'waiting_for_input'
    );
    await pool.query(
      `INSERT INTO public.message (
         id, workspace_id, channel_id, author_workspace_member_id, parent_message_id, body
       ) VALUES
         ('request-clarification-recovery', $1, $2, $3, 'message-clarification-recovery',
          'Quick clarification: should restart recovery be included?'),
         ('answer-clarification-recovery', $1, $2, $4, 'message-clarification-recovery',
          'Yes, include restart recovery.')`,
      [ids.workspaceId, ids.channelId, `agent-member-clarification-recovery`, ids.pilotMemberId]
    );
    await pool.query(
      `INSERT INTO public.agent_run_clarification (
         id, workspace_id, agent_run_id, provider_request_id, provider_turn_id,
         provider_item_id, questions, request_message_id, status, answers,
         answer_message_id, answered_by_workspace_member_id, answered_at
       ) VALUES (
         'clarification-recovery', $1, $2, 'provider-request-recovery',
         'turn-clarification-recovery', 'item-clarification-recovery', $3,
         'request-clarification-recovery', 'answered', $4,
         'answer-clarification-recovery', $5, now()
       )`,
      [
        ids.workspaceId,
        ids.runId,
        JSON.stringify([
          { id: 'recovery', header: 'Recovery', question: 'Include restart recovery?', options: null }
        ]),
        JSON.stringify({ recovery: ['Yes, include restart recovery.'] }),
        ids.pilotMemberId
      ]
    );
    const provider = new FixtureProvider(async (input, observer) => {
      assert.equal(input.providerThreadId, 'thread-clarification-recovery');
      assert.equal(input.prompt, 'Yes, include restart recovery.');
      await observer.threadStarted('thread-clarification-recovery');
      await observer.turnStarted('turn-clarification-follow-up');
      await observer.notification({
        method: 'turn/completed',
        providerEventId: 'turn-clarification-follow-up:completed',
        turn: { id: 'turn-clarification-follow-up', status: 'completed' }
      });
    });

    assert.deepEqual(await processNextAgentRun(pool, provider, {
      workerId: 'worker-clarification-recovery', workspaceRoot, leaseDurationMs: 10_000
    }), { kind: 'recovered', agentRunId: ids.runId, status: 'queued' });
    assert.equal(provider.executions.length, 0);
    assert.deepEqual(await processNextAgentRun(pool, provider, {
      workerId: 'worker-clarification-follow-up', workspaceRoot, leaseDurationMs: 10_000
    }), { kind: 'executed', agentRunId: ids.runId, status: 'completed' });
    assert.equal(provider.executions.length, 1);

    const stored = await pool.query<{
      task_id: string;
      provider_thread_id: string;
      delivery_attempted_at: Date;
      delivered_at: Date;
      task_count: number;
    }>(
      `SELECT run.task_id, run.provider_thread_id,
              clarification.delivery_attempted_at, clarification.delivered_at,
              (SELECT count(*)::integer FROM public.task WHERE id = run.task_id) AS task_count
       FROM public.agent_run run
       JOIN public.agent_run_clarification clarification
         ON clarification.agent_run_id = run.id
       WHERE run.id = $1`,
      [ids.runId]
    );
    assert.equal(stored.rows[0]?.task_id, 'task-clarification-recovery');
    assert.equal(stored.rows[0]?.provider_thread_id, 'thread-clarification-recovery');
    assert.equal(stored.rows[0]?.task_count, 1);
    assert.ok(stored.rows[0]?.delivery_attempted_at);
    assert.ok(stored.rows[0]?.delivered_at);
  });

  test('Pilot steering is ordered, visible, and delivered at the next Provider boundary', async () => {
    const ids = await seedQueuedAgentRun(pool, 'steering-guidance');
    const steering = await postChannelMessage(pool, ids.memberAccess, {
      channelId: ids.channelId,
      parentMessageId: 'message-steering-guidance',
      body: 'steer: add regression coverage and do not change deployment files',
      submissionId: 'steering-guidance-input'
    });
    const provider = new FixtureProvider(async (input, observer) => {
      assert.match(input.prompt, /add regression coverage and do not change deployment files/);
      await observer.threadStarted('thread-steering-guidance');
      await observer.turnStarted('turn-steering-guidance');
      await observer.notification({
        method: 'turn/completed', providerEventId: 'steering-guidance:completed',
        turn: { id: 'turn-steering-guidance', status: 'completed' }
      });
    });
    assert.equal((await processNextAgentRun(pool, provider, {
      workerId: 'worker-steering-guidance', workspaceRoot
    })).kind, 'executed');
    const stored = await pool.query<{
      source_message_id: string; ordinal: number; status: string;
      provider_thread_id: string; provider_turn_id: string;
      supplied_by_workspace_member_id: string; created_at: Date;
    }>(
      `SELECT source_message_id, ordinal, status, provider_thread_id, provider_turn_id,
              supplied_by_workspace_member_id, created_at
       FROM public.agent_run_steering WHERE agent_run_id = $1`,
      [ids.runId]
    );
    assert.deepEqual(stored.rows.map(({ created_at, ...row }) => ({
      ...row, accepted: created_at instanceof Date
    })), [{
      source_message_id: steering.id, ordinal: 1, status: 'delivered',
      provider_thread_id: 'thread-steering-guidance', provider_turn_id: 'turn-steering-guidance',
      supplied_by_workspace_member_id: ids.memberWorkspaceMemberId, accepted: true
    }]);
    const visible = await loadCollaborationAccountability(pool, ids.memberAccess, ids.projectId);
    assert.deepEqual(visible.steering.map(({ createdAt, ...item }) => ({
      ...item, accepted: Date.parse(createdAt) > 0
    })), [{
      id: visible.steering[0]?.id,
      agentRunId: ids.runId,
      sourceMessageId: steering.id,
      guidance: 'add regression coverage and do not change deployment files',
      ordinal: 1,
      status: 'delivered',
      suppliedBy: 'Pilot member',
      accepted: true
    }]);
  });

  test('simultaneous Pilot steering is durably ordered and submission-idempotent', async () => {
    const ids = await seedQueuedAgentRun(pool, 'steering-ordering');
    const firstInput = {
      channelId: ids.channelId,
      parentMessageId: 'message-steering-ordering',
      body: 'steer: add regression coverage',
      submissionId: 'steering-ordering-first'
    };
    const [first, second] = await Promise.all([
      postChannelMessage(pool, ids.ownerAccess, firstInput),
      postChannelMessage(pool, ids.memberAccess, {
        channelId: ids.channelId,
        parentMessageId: 'message-steering-ordering',
        body: 'constraint: do not change deployment files',
        submissionId: 'steering-ordering-second'
      })
    ]);
    const retry = await postChannelMessage(pool, ids.ownerAccess, firstInput);

    assert.equal(retry.id, first.id);
    const stored = await pool.query<{
      source_message_id: string; ordinal: number; status: string;
    }>(
      `SELECT source_message_id, ordinal, status
       FROM public.agent_run_steering WHERE agent_run_id = $1 ORDER BY ordinal`,
      [ids.runId]
    );
    assert.deepEqual(stored.rows.map(({ ordinal, status }) => ({ ordinal, status })), [
      { ordinal: 1, status: 'pending' },
      { ordinal: 2, status: 'pending' }
    ]);
    assert.deepEqual(
      new Set(stored.rows.map(({ source_message_id }) => source_message_id)),
      new Set([first.id, second.id])
    );
  });

  test('steering remains visible when active, waiting for Approval, recovering, or paused and is rejected when terminal', async () => {
    const acceptedStates = ['working', 'waiting_for_approval', 'recovering', 'paused'] as const;
    for (const status of acceptedStates) {
      const ids = await seedQueuedAgentRun(pool, `steering-${status}`);
      await pool.query('UPDATE public.agent_run SET status = $2 WHERE id = $1', [ids.runId, status]);
      const steering = await postChannelMessage(pool, ids.memberAccess, {
        channelId: ids.channelId,
        parentMessageId: `message-steering-${status}`,
        body: `guidance: preserve the ${status} evidence`,
        submissionId: `steering-${status}-input`
      });
      const stored = await pool.query<{ source_message_id: string; status: string }>(
        `SELECT source_message_id, status FROM public.agent_run_steering
         WHERE agent_run_id = $1`,
        [ids.runId]
      );
      assert.deepEqual(stored.rows, [{ source_message_id: steering.id, status: 'pending' }]);
      const run = await pool.query<{ status: string }>(
        'SELECT status FROM public.agent_run WHERE id = $1', [ids.runId]
      );
      assert.equal(run.rows[0]?.status, status);
    }

    const terminalStates = ['completed', 'failed', 'cancelled'] as const;
    for (const status of terminalStates) {
      const ids = await seedQueuedAgentRun(pool, `steering-${status}`);
      await pool.query(
        'UPDATE public.agent_run SET status = $2, completed_at = now() WHERE id = $1',
        [ids.runId, status]
      );
      await postChannelMessage(pool, ids.memberAccess, {
        channelId: ids.channelId,
        parentMessageId: `message-steering-${status}`,
        body: `steer: this must not attach to ${status} work`,
        submissionId: `steering-${status}-input`
      });
      const stored = await pool.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM public.agent_run_steering
         WHERE agent_run_id = $1`,
        [ids.runId]
      );
      assert.equal(stored.rows[0]?.count, 0);
    }
  });

  test('a Pilot intent correction stops queued repository work before execution', async () => {
    const ids = await seedQueuedAgentRun(pool, 'intent-correction');
    const messageId = 'message-intent-correction';
    await pool.query(
      `INSERT INTO public.message_intent_decision (
         id, workspace_id, project_id, message_id, selected_intent,
         target_agent_id, confidence, policy_version, rationale
       ) VALUES ($1, $2, $3, $4, 'engineering_delegation', $5, 1, 'rules-v1',
         'A repository outcome was requested.')`,
      ['decision-intent-correction', ids.workspaceId, ids.projectId, messageId, ids.agentId]
    );
    await correctMessageIntent(pool, ids.ownerAccess, messageId, { intent: 'conversation' });
    const stopped = await pool.query<{ run_status: string; task_status: string; mention_status: string }>(
      `SELECT run.status AS run_status, task.status AS task_status,
              message.agent_mention_status AS mention_status
       FROM public.agent_run run JOIN public.task task ON task.id = run.task_id
       JOIN public.message message ON message.id = task.source_message_id
       WHERE run.id = $1`,
      [ids.runId]
    );
    assert.deepEqual(stopped.rows[0], {
      run_status: 'cancelled', task_status: 'cancelled', mention_status: 'communication'
    });
    assert.deepEqual(await processNextAgentRun(pool, new FixtureProvider(async () => {
      assert.fail('corrected repository work must not reach the Provider');
    }), { workerId: 'worker-intent-correction', workspaceRoot }), { kind: 'idle' });
  });

  test('coordination remains inert until Pilot approval and cannot create engineering AgentRuns', async () => {
    const ids = await seedQueuedAgentRun(pool, 'coordination-approval');
    const researchAgentId = 'research-coordination-approval';
    const researchMemberId = `${researchAgentId}:member`;
    await pool.query(
      `INSERT INTO public.agent (id, workspace_id, name, role_label, agent_type)
       VALUES ($1, $2, 'Riley', 'Research agent', 'research')`,
      [researchAgentId, ids.workspaceId]
    );
    await pool.query(
      `INSERT INTO public.workspace_member (id, workspace_id, kind, agent_id)
       VALUES ($1, $2, 'agent', $3)`,
      [researchMemberId, ids.workspaceId, researchAgentId]
    );
    await pool.query(
      `INSERT INTO public.project_membership (workspace_id, project_id, workspace_member_id)
       VALUES ($1, $2, $3)`,
      [ids.workspaceId, ids.projectId, researchMemberId]
    );
    const conversationId = 'conversation-coordination-approval';
    const turnId = 'turn-coordination-approval-source';
    const resultMessageId = 'message-coordination-approval-plan';
    await pool.query(
      `INSERT INTO public.agent_conversation (
         id, workspace_id, channel_id, root_message_id, agent_id, provider_connection_id
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [conversationId, ids.workspaceId, ids.channelId, 'message-coordination-approval',
        ids.agentId, ids.providerConnectionId]
    );
    await pool.query(
      `INSERT INTO public.message (
         id, workspace_id, channel_id, author_workspace_member_id, parent_message_id, body
       ) VALUES ($1, $2, $3, $4, $5, 'I propose a bounded research step.')`,
      [resultMessageId, ids.workspaceId, ids.channelId, ids.agentMemberId,
        'message-coordination-approval']
    );
    await pool.query(
      `INSERT INTO public.agent_conversation_turn (
         id, workspace_id, conversation_id, request_message_id,
         requested_by_workspace_member_id, response_message_id, status,
         response_placement, response_parent_message_id, completed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'completed', 'thread', $4, now())`,
      [turnId, ids.workspaceId, conversationId, 'message-coordination-approval',
        ids.pilotMemberId, resultMessageId]
    );
    const planId = await proposeCoordinationPlan(pool, {
      workspaceId: ids.workspaceId, projectId: ids.projectId,
      coordinatingAgentId: ids.agentId, sourceMessageId: resultMessageId,
      goal: 'Assess evidence', allowParallel: false,
      budget: { maxParticipants: 1, maxHandoffs: 1, maxDepth: 1, maxAgentRuns: 0, maxElapsedSeconds: 600 },
      steps: [{ key: 'research', agentId: researchAgentId, instruction: 'Assess the evidence', dependencies: [] }]
    });
    assert.equal(await claimCoordinationStep(pool, planId), null);
    await decideCoordinationPlan(pool, ids.ownerAccess, planId, 'approve');
    const planConstraint = await postChannelMessage(pool, ids.memberAccess, {
      channelId: ids.channelId,
      parentMessageId: 'message-coordination-approval',
      body: 'constraint: cite the release evidence and do not create repository work',
      submissionId: 'coordination-approval-steering'
    });
    const pendingPlan = (await loadCollaborationAccountability(
      pool, ids.memberAccess, ids.projectId
    )).plans.find(({ id }) => id === planId);
    assert.deepEqual(pendingPlan?.constraints, []);
    assert.deepEqual(pendingPlan?.constraintInputs.map((input) => ({
      sourceMessageId: input.sourceMessageId,
      guidance: input.guidance,
      status: input.status,
      deliveryConversationTurnId: input.deliveryConversationTurnId,
      suppliedBy: input.suppliedBy
    })), [{
      sourceMessageId: planConstraint.id,
      guidance: 'cite the release evidence and do not create repository work',
      status: 'pending',
      deliveryConversationTurnId: null,
      suppliedBy: 'Pilot member'
    }]);
    assert.ok(await claimCoordinationStep(pool, planId));
    const created = await pool.query<{
      turns: number; runs: number; depth: number; request_body: string;
      constraints: string[]; constraint_status: string;
      delivery_conversation_turn_id: string; constraint_events: number;
    }>(
      `SELECT
         count(*) FILTER (WHERE turn.id IS NOT NULL)::integer AS turns,
         (SELECT count(*)::integer FROM public.agent_run WHERE workspace_id = $1) AS runs,
         max(turn.handoff_depth)::integer AS depth,
         max(request.body) AS request_body,
         max(plan.constraints::text)::jsonb AS constraints,
         max(constraint_input.status) AS constraint_status,
         max(constraint_input.delivery_conversation_turn_id) AS delivery_conversation_turn_id,
         (SELECT count(*)::integer FROM public.audit_event event
          WHERE event.subject_type = 'coordination_plan' AND event.subject_id = $2
            AND event.event_type = 'coordination_plan.constraint_appended'
            AND event.evidence->>'sourceMessageId' = $3) AS constraint_events
       FROM public.coordination_plan_step step
       JOIN public.coordination_plan plan ON plan.id = step.plan_id
       JOIN public.coordination_plan_constraint constraint_input
         ON constraint_input.plan_id = plan.id
       LEFT JOIN public.agent_conversation_turn turn ON turn.id = step.conversation_turn_id
       LEFT JOIN public.message request ON request.id = turn.request_message_id
       WHERE step.plan_id = $2`,
      [ids.workspaceId, planId, planConstraint.id]
    );
    assert.deepEqual(created.rows[0] && {
      ...created.rows[0],
      delivery_conversation_turn_id: Boolean(created.rows[0].delivery_conversation_turn_id)
    }, {
      turns: 1, runs: 1, depth: 1,
      request_body: 'Assess the evidence\n\nApproved coordination constraints:\n- cite the release evidence and do not create repository work',
      constraints: ['cite the release evidence and do not create repository work'],
      constraint_status: 'delivered',
      delivery_conversation_turn_id: true,
      constraint_events: 1
    });
    await pool.query(
      `UPDATE public.agent_conversation_turn
       SET status = 'failed', completed_at = now(), error_code = 'test_cleanup'
       WHERE id IN (
         SELECT conversation_turn_id FROM public.coordination_plan_step WHERE plan_id = $1
       ) AND status = 'queued'`,
      [planId]
    );
  });

  test('Research Agents preserve inaccessible cross-Project evidence as visible provenance', async () => {
    const ids = await seedQueuedAgentRun(pool, 'structured-finding');
    const researchAgentId = 'research-structured-finding';
    const researchMemberId = `${researchAgentId}:member`;
    await pool.query(
      `INSERT INTO public.agent (
         id, workspace_id, name, role_label, agent_type, participation_mode
       ) VALUES ($1, $2, 'Riley', 'Research agent', 'research', 'reactive')`,
      [researchAgentId, ids.workspaceId]
    );
    await pool.query(
      `INSERT INTO public.workspace_member (id, workspace_id, kind, agent_id)
       VALUES ($1, $2, 'agent', $3)`,
      [researchMemberId, ids.workspaceId, researchAgentId]
    );
    await pool.query(
      `INSERT INTO public.project_membership (workspace_id, project_id, workspace_member_id)
       VALUES ($1, $2, $3)`,
      [ids.workspaceId, ids.projectId, researchMemberId]
    );
    const request = await postChannelMessage(pool, ids.ownerAccess, {
      channelId: ids.channelId,
      body: '@Riley research the release evidence.',
      submissionId: 'structured-finding-request'
    });
    assert.equal(request.routingDecision?.intent, 'research_request');
    await pool.query(
      `INSERT INTO public.project (id, workspace_id, name)
       VALUES ('project-structured-finding-other', $1, 'Other Project')`,
      [ids.workspaceId]
    );
    await pool.query(
      `INSERT INTO public.channel (id, workspace_id, project_id, name)
       VALUES ('channel-structured-finding-other', $1, 'project-structured-finding-other', 'other-project')`,
      [ids.workspaceId]
    );
    await pool.query(
      `INSERT INTO public.message (
         id, workspace_id, channel_id, author_workspace_member_id, body
       ) VALUES (
         'message-structured-finding-other', $1, 'channel-structured-finding-other', $2,
         'The other Project chose a phased release.'
       )`,
      [ids.workspaceId, ids.pilotMemberId]
    );
    const researchTurnId = request.agentMention?.status === 'conversation'
      ? request.agentMention.conversationTurnId : '';
    await pool.query(
      `UPDATE public.agent_conversation_turn
       SET status = 'failed', completed_at = now(), error_code = 'test_cleanup'
       WHERE status = 'queued' AND id <> $1`,
      [researchTurnId]
    );
    const provider = new FixtureProvider(async (_input, observer) => {
      await observer.threadStarted('thread-structured-finding');
      await observer.turnStarted('turn-structured-finding');
      await observer.notification({
        method: 'item/completed', providerEventId: 'structured-finding:message',
        item: {
          id: 'structured-finding-message', type: 'agentMessage',
          text: `The release evidence is current.

\`\`\`relay-finding
{"summary":"The release evidence is current.","confidence":0.9,"observedEvidence":["The release record is dated today."],"inferences":[],"assumptions":[],"openQuestions":[],"evidence":[{"type":"external","stableReference":"https://example.test/release","title":"Release record","retrievedAt":"2026-08-30T12:00:00.000Z","claim":"The release record is current."},{"type":"message","stableReference":"message-structured-finding-other","title":"Release decision","retrievedAt":"2026-08-30T12:00:00.000Z","claim":"The other Project chose a phased release."}]}
\`\`\``
        }
      });
      await observer.notification({
        method: 'turn/completed', providerEventId: 'structured-finding:completed',
        turn: { id: 'turn-structured-finding', status: 'completed' }
      });
    });
    assert.deepEqual(await processNextConversationTurn(pool, provider, {
      workerId: 'worker-structured-finding', workspaceRoot
    }), {
      kind: 'conversation',
      conversationTurnId: researchTurnId,
      status: 'completed'
    });
    const stored = await pool.query<{ findings: number; evidence: number; memory: number }>(
      `SELECT
         (SELECT count(*)::integer FROM public.agent_finding WHERE project_id = $1) AS findings,
         (SELECT count(*)::integer FROM public.finding_evidence WHERE project_id = $1) AS evidence,
         (SELECT count(*)::integer FROM public.project_memory
          WHERE project_id = $1 AND memory_type = 'finding' AND lifecycle = 'active') AS memory`,
      [ids.projectId]
    );
    assert.deepEqual(stored.rows[0], { findings: 1, evidence: 2, memory: 1 });
    const accountability = await loadCollaborationAccountability(
      pool, ids.ownerAccess, ids.projectId
    );
    assert.deepEqual(
      accountability.findings[0]?.evidence.find(({ stableReference }) =>
        stableReference === 'message-structured-finding-other'
      ),
      {
        type: 'message',
        stableReference: 'message-structured-finding-other',
        title: 'Release decision',
        retrievedAt: '2026-08-30T12:00:00+00:00',
        claim: 'The other Project chose a phased release.',
        accessible: false
      }
    );
  });

  test('Project memory is provenance-scoped, superseded, archived, deleted, and deterministically bounded', async () => {
    const ids = await seedQueuedAgentRun(pool, 'project-memory');
    const otherWorkspace = await seedQueuedAgentRun(pool, 'project-memory-other-workspace');
    await pool.query(`UPDATE public.agent_run SET available_at = 'infinity' WHERE id = $1`, [
      otherWorkspace.runId
    ]);
    const sourceMessageId = 'message-project-memory';
    const types: MemoryType[] = [
      'decision', 'terminology', 'constraint', 'finding', 'convention', 'rejected_approach'
    ];
    const memoryIds = new Map<MemoryType, string>();

    for (const type of types) {
      memoryIds.set(type, await createProjectMemory(pool, ids.ownerAccess, {
        projectId: ids.projectId,
        type,
        statement: `${type} statement`,
        sourceReferences: [`message:${sourceMessageId}`]
      }));
    }

    await pool.query(
      `INSERT INTO public.project (id, workspace_id, name)
       VALUES ('project-memory-neighbour', $1, 'Neighbour Project')`,
      [ids.workspaceId]
    );
    await pool.query(
      `INSERT INTO public.channel (id, workspace_id, project_id, name)
       VALUES ('channel-project-memory-neighbour', $1, 'project-memory-neighbour', 'neighbour')`,
      [ids.workspaceId]
    );
    await pool.query(
      `INSERT INTO public.message (
         id, workspace_id, channel_id, author_workspace_member_id, body
       ) VALUES (
         'message-project-memory-neighbour', $1, 'channel-project-memory-neighbour', $2,
         'A decision from another Project.'
       )`,
      [ids.workspaceId, ids.pilotMemberId]
    );
    await assert.rejects(
      createProjectMemory(pool, ids.ownerAccess, {
        projectId: ids.projectId,
        type: 'decision',
        statement: 'Cross-Project memory',
        sourceReferences: ['message:message-project-memory-neighbour']
      }),
      /provenance is outside the Project/
    );
    await assert.rejects(
      createProjectMemory(pool, ids.ownerAccess, {
        projectId: ids.projectId,
        type: 'constraint',
        statement: 'Authorization: Bearer credential-that-must-not-be-stored',
        sourceReferences: [`message:${sourceMessageId}`]
      }),
      /must not contain credentials or Provider traces/
    );

    const originalDecisionId = memoryIds.get('decision');
    assert.ok(originalDecisionId);
    const correctedDecisionId = await createProjectMemory(pool, ids.memberAccess, {
      projectId: ids.projectId,
      type: 'decision',
      statement: 'corrected decision statement',
      sourceReferences: [`message:${sourceMessageId}`],
      supersedesId: originalDecisionId
    });
    await setProjectMemoryLifecycle(
      pool, ids.memberAccess, memoryIds.get('convention')!, 'archived'
    );
    await setProjectMemoryLifecycle(
      pool, ids.ownerAccess, memoryIds.get('constraint')!, 'deleted'
    );

    const visible = await loadCollaborationAccountability(pool, ids.ownerAccess, ids.projectId);
    assert.deepEqual(
      visible.memory.find(({ id }) => id === originalDecisionId)?.lifecycle,
      'superseded'
    );
    assert.deepEqual(
      visible.memory.find(({ id }) => id === correctedDecisionId)?.supersedesId,
      originalDecisionId
    );
    assert.deepEqual(
      visible.memory.find(({ id }) => id === memoryIds.get('constraint')),
      {
        id: memoryIds.get('constraint'),
        type: 'constraint',
        statement: '[deleted]',
        sourceReferences: [],
        lifecycle: 'deleted',
        supersedesId: null,
        authorName: 'Owner',
        createdAt: visible.memory.find(({ id }) => id === memoryIds.get('constraint'))?.createdAt
      }
    );

    assert.deepEqual(
      (await loadProjectMemoryContext(pool, ids.ownerAccess, ids.projectId, 2))
        .map(({ statement }) => statement),
      ['rejected_approach statement', 'corrected decision statement']
    );
    assert.deepEqual(
      await loadProjectMemoryContext(pool, otherWorkspace.ownerAccess, ids.projectId),
      []
    );
    assert.deepEqual(
      (await loadAgentProjectMemoryContext(pool, {
        workspaceId: ids.workspaceId,
        projectId: ids.projectId,
        agentId: ids.agentId
      }, 2)).map(({ statement }) => statement),
      ['rejected_approach statement', 'corrected decision statement']
    );

    const provider = new FixtureProvider(async (input, observer) => {
      assert.match(input.prompt, /Active authorised Project memory/);
      assert.match(input.prompt, /\[terminology\] terminology statement/);
      assert.match(input.prompt, /\[finding\] finding statement/);
      assert.match(input.prompt, /\[rejected_approach\] rejected_approach statement/);
      assert.match(input.prompt, /\[decision\] corrected decision statement/);
      assert.doesNotMatch(input.prompt, /\[decision\] decision statement/);
      assert.doesNotMatch(input.prompt, /constraint statement|convention statement|Neighbour Project/);
      await observer.notification({
        method: 'turn/completed', providerEventId: 'project-memory:completed',
        turn: { id: 'turn-project-memory', status: 'completed' }
      });
    });
    assert.deepEqual(await processNextAgentRun(pool, provider, {
      workerId: 'worker-project-memory', workspaceRoot
    }), { kind: 'executed', agentRunId: ids.runId, status: 'completed' });

    await pool.query(
      `INSERT INTO public.agent (id, workspace_id, name, role_label)
       VALUES ('agent-project-memory-source', $1, 'Riley', 'Research agent')`,
      [ids.workspaceId]
    );
    await pool.query(
      `INSERT INTO public.workspace_member (id, workspace_id, kind, agent_id)
       VALUES ('agent-member-project-memory-source', $1, 'agent', 'agent-project-memory-source')`,
      [ids.workspaceId]
    );
    await pool.query(
      `INSERT INTO public.project_membership (workspace_id, project_id, workspace_member_id)
       VALUES ($1, $2, 'agent-member-project-memory-source')`,
      [ids.workspaceId, ids.projectId]
    );
    await pool.query(
      `INSERT INTO public.agent_conversation (
         id, workspace_id, channel_id, root_message_id, agent_id, provider_connection_id
       ) VALUES (
         'conversation-project-memory-provenance', $1, $2, $3, $4, $5
       )`,
      [ids.workspaceId, ids.channelId, sourceMessageId, ids.agentId, ids.providerConnectionId]
    );
    await pool.query(
      `INSERT INTO public.agent_conversation_turn (
         id, workspace_id, conversation_id, request_message_id,
         requested_by_workspace_member_id, status
       ) VALUES (
         'turn-project-memory-provenance', $1, 'conversation-project-memory-provenance',
         $2, $3, 'queued'
       )`,
      [ids.workspaceId, sourceMessageId, ids.pilotMemberId]
    );
    await pool.query(
      `INSERT INTO public.agent_handoff (
         id, workspace_id, project_id, originating_pilot_member_id,
         source_agent_id, target_agent_id, source_message_id, source_task_id,
         receiving_turn_id, question
       ) VALUES (
         'handoff-project-memory-provenance', $1, $2, $3,
         'agent-project-memory-source', $4, $5, 'task-project-memory',
         'turn-project-memory-provenance', 'Confirm the durable outcome.'
       )`,
      [ids.workspaceId, ids.projectId, ids.pilotMemberId, ids.agentId, sourceMessageId]
    );
    await pool.query(
      `INSERT INTO public.message (
         id, workspace_id, channel_id, author_workspace_member_id, parent_message_id, body
       ) VALUES (
         'artifact-result-project-memory', $1, $2, $3, $4,
         'Pull request #33 is ready for review.'
       )`,
      [ids.workspaceId, ids.channelId, ids.agentMemberId, sourceMessageId]
    );
    await pool.query(
      `INSERT INTO public.artifact (
         id, workspace_id, project_id, task_id, agent_run_id, result_message_id,
         kind, repository_id, branch, commit_sha, pull_request_number, url
       ) VALUES (
         'artifact-project-memory', $1, $2, 'task-project-memory', $3,
         'artifact-result-project-memory', 'github_pull_request', $4,
         'relay/project-memory', $5, 33, 'https://github.test/relay/pull/33'
       )`,
      [ids.workspaceId, ids.projectId, ids.runId, ids.linkedRepositoryId, 'a'.repeat(40)]
    );
    const multiSourceMemoryId = await createProjectMemory(pool, ids.ownerAccess, {
      projectId: ids.projectId,
      type: 'finding',
      statement: 'All supported durable provenance resolves inside the Project.',
      sourceReferences: [
        'handoff:handoff-project-memory-provenance',
        'task:task-project-memory',
        `agent_run:${ids.runId}`,
        'artifact:artifact-project-memory'
      ]
    });
    assert.deepEqual(
      (await loadCollaborationAccountability(pool, ids.ownerAccess, ids.projectId))
        .memory.find(({ id }) => id === multiSourceMemoryId)?.sourceReferences,
      [
        'handoff:handoff-project-memory-provenance',
        'task:task-project-memory',
        `agent_run:${ids.runId}`,
        'artifact:artifact-project-memory'
      ]
    );

    await pool.query(
      `DELETE FROM public.project_membership
       WHERE project_id = $1 AND workspace_member_id = $2`,
      [ids.projectId, ids.agentMemberId]
    );
    assert.deepEqual(await loadAgentProjectMemoryContext(pool, {
      workspaceId: ids.workspaceId,
      projectId: ids.projectId,
      agentId: ids.agentId
    }), []);
  });
}

class FixtureProvider implements AgentRunProvider {
  readonly executions: AgentRunProviderInput[] = [];
  readonly reconciliations: Array<{ threadId: string; turnId: string }> = [];
  readonly interruptions: Array<{
    threadId: string;
    turnId: string;
    credentialStoreReference: string;
  }> = [];

  constructor(
    private readonly executeFixture: (
      input: AgentRunProviderInput,
      observer: AgentRunProviderObserver
    ) => Promise<void>,
    private readonly reconcileFixture: (
      input: { threadId: string; turnId: string }
    ) => Promise<ProviderReconciliation> = async () => ({ outcome: 'indeterminate' }),
    private readonly interruptFixture: () => Promise<void> = async () => {}
  ) {}

  async execute(input: AgentRunProviderInput, observer: AgentRunProviderObserver): Promise<void> {
    this.executions.push(input);
    await this.executeFixture(input, observer);
  }

  async reconcile(input: { threadId: string; turnId: string }): Promise<ProviderReconciliation> {
    this.reconciliations.push(input);
    return this.reconcileFixture(input);
  }

  async interrupt(input: ProviderInterruptionInput): Promise<void> {
    this.interruptions.push(input);
    await this.interruptFixture();
  }
}

async function seedExpiredProviderBoundary(
  pool: Pool,
  ids: { runId: string; workspaceId: string },
  threadId: string,
  turnId: string,
  status: 'working' | 'waiting_for_input' = 'working'
): Promise<void> {
  await pool.query(
    `UPDATE public.agent_run
     SET status = $2, provider_thread_id = $3, active_turn_id = $4,
         lease_owner = 'dead-worker', lease_token = 'dead-token',
         lease_expires_at = now() - interval '1 minute'
     WHERE id = $1`,
    [ids.runId, status, threadId, turnId]
  );
  await pool.query(
    `WITH events AS (
       INSERT INTO public.agent_run_event (
         workspace_id, agent_run_id, sequence, event_type, status, summary,
         provider_event_id, provider_turn_id
       ) VALUES
         ($1, $2, 2, 'provider.thread.started', 'planning', 'Codex thread started', $3, NULL),
         ($1, $2, 3, 'provider.turn.started', 'working', 'Codex turn started', $4, $5)
       RETURNING id, event_type, sequence
     )
     INSERT INTO public.notification_outbox (
       workspace_id, agent_run_event_id, topic, payload
     )
     SELECT $1, id, 'agent_run.event', jsonb_build_object(
       'agentRunId', $2::text, 'eventType', event_type, 'sequence', sequence
     )
     FROM events`,
    [
      ids.workspaceId,
      ids.runId,
      `thread:${threadId}:started`,
      `turn:${turnId}:started`,
      turnId
    ]
  );
}

async function seedQueuedAgentRun(pool: Pool, suffix: string) {
  const workspaceId = `workspace-${suffix}`;
  const userId = `user-${suffix}`;
  const membershipId = `membership-${suffix}`;
  const memberUserId = `member-user-${suffix}`;
  const memberMembershipId = `member-membership-${suffix}`;
  const pilotMemberId = `pilot-${suffix}`;
  const secondPilotMemberId = `second-pilot-${suffix}`;
  const projectId = `project-${suffix}`;
  const agentId = `agent-${suffix}`;
  const agentMemberId = `agent-member-${suffix}`;
  const channelId = `channel-${suffix}`;
  const messageId = `message-${suffix}`;
  const taskId = `task-${suffix}`;
  const runId = `run-${suffix}`;
  const effectiveProviderConnectionId = `provider-${suffix}`;
  const githubConnectionId = `github-${suffix}`;
  const linkedRepositoryId = `repository-${suffix}`;

  await pool.query(
    `INSERT INTO auth."user" (id, name, email, "emailVerified") VALUES ($1, 'Owner', $2, true)`,
    [userId, `${suffix}@example.com`]
  );
  await pool.query(
    `INSERT INTO auth."user" (id, name, email, "emailVerified")
     VALUES ($1, 'Pilot member', $2, true)`,
    [memberUserId, `member-${suffix}@example.com`]
  );
  await pool.query('INSERT INTO public.workspace (id, name) VALUES ($1, $2)', [
    workspaceId, `Workspace ${suffix}`
  ]);
  await pool.query(
    `INSERT INTO public.workspace_membership (workspace_id, user_id, role, id)
     VALUES ($1, $2, 'owner', $3)`,
    [workspaceId, userId, membershipId]
  );
  await pool.query(
    `INSERT INTO public.workspace_membership (workspace_id, user_id, role, id)
     VALUES ($1, $2, 'member', $3)`,
    [workspaceId, memberUserId, memberMembershipId]
  );
  await pool.query('INSERT INTO public.project (id, workspace_id, name) VALUES ($1, $2, $3)', [
    projectId, workspaceId, 'Project'
  ]);
  await pool.query(
    `INSERT INTO public.agent (id, workspace_id, name, role_label)
     VALUES ($1, $2, 'Alex', 'Engineering agent')`,
    [agentId, workspaceId]
  );
  await pool.query(
    'INSERT INTO public.channel (id, workspace_id, project_id, name) VALUES ($1, $2, $3, $4)',
    [channelId, workspaceId, projectId, `channel-${suffix}`]
  );
  await pool.query(
    `INSERT INTO public.workspace_member (id, workspace_id, kind, pilot_membership_id)
     VALUES ($1, $2, 'pilot', $3)`,
    [pilotMemberId, workspaceId, membershipId]
  );
  await pool.query(
    `INSERT INTO public.workspace_member (id, workspace_id, kind, pilot_membership_id)
     VALUES ($1, $2, 'pilot', $3)`,
    [secondPilotMemberId, workspaceId, memberMembershipId]
  );
  await pool.query(
    `INSERT INTO public.workspace_member (id, workspace_id, kind, agent_id)
     VALUES ($1, $2, 'agent', $3)`,
    [agentMemberId, workspaceId, agentId]
  );
  await pool.query(
    `INSERT INTO public.project_membership (workspace_id, project_id, workspace_member_id)
     VALUES ($1, $2, $3), ($1, $2, $4), ($1, $2, $5)`,
    [workspaceId, projectId, pilotMemberId, secondPilotMemberId, agentMemberId]
  );
  await pool.query(
    `INSERT INTO public.message (
       id, workspace_id, channel_id, author_workspace_member_id, body,
       agent_mention_status, mentioned_agent_id
     ) VALUES ($1, $2, $3, $4, '@Alex inspect the failing test.', 'accepted', $5)`,
    [messageId, workspaceId, channelId, pilotMemberId, agentId]
  );

  await pool.query(
    `INSERT INTO public.provider_connection (
       id, workspace_id, owner_membership_id, status, credential_store_reference, connected_at
     ) VALUES ($1, $2, $3, 'ready', $4, now())`,
    [effectiveProviderConnectionId, workspaceId, membershipId, `credentials-${suffix}`]
  );

  await pool.query(
    `INSERT INTO public.github_connection (
       id, workspace_id, owner_membership_id, app_id, installation_id, status
     ) VALUES ($1, $2, $3, '17', $4, 'active')`,
    [githubConnectionId, workspaceId, membershipId, `installation-${suffix}`]
  );
  await pool.query(
    `INSERT INTO public.linked_repository (
       id, workspace_id, project_id, github_connection_id, repository_id,
       repository_node_id, owner_node_id, repository_owner, repository_name,
       default_branch, ready_for_autonomous_work, verification
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'relay-owner', 'pilot', 'main', true, '{}')`,
    [
      linkedRepositoryId, workspaceId, projectId, githubConnectionId, `repo-${suffix}`,
      `repo-node-${suffix}`, `owner-node-${suffix}`
    ]
  );
  await pool.query(
    `INSERT INTO public.task (
       id, workspace_id, project_id, assigned_agent_id, source_message_id,
       requested_by_workspace_member_id, request_snapshot, context_snapshot
     ) VALUES ($1, $2, $3, $4, $5, $6, '@Alex inspect the failing test.', '{}')`,
    [taskId, workspaceId, projectId, agentId, messageId, pilotMemberId]
  );
  await pool.query(
    `INSERT INTO public.agent_run (
       id, workspace_id, task_id, agent_id, provider_connection_id,
       linked_repository_id, attempt_number, status,
       requested_by_workspace_member_id, request_message_id
     ) VALUES ($1, $2, $3, $4, $5, $6, 1, 'queued', $7, $8)`,
    [
      runId, workspaceId, taskId, agentId, effectiveProviderConnectionId, linkedRepositoryId,
      pilotMemberId, messageId
    ]
  );
  await insertQueuedEvent(pool, workspaceId, runId);

  return {
    runId,
    providerConnectionId: effectiveProviderConnectionId,
    workspaceId,
    projectId,
    agentId,
    agentMemberId,
    channelId,
    pilotMemberId,
    memberWorkspaceMemberId: secondPilotMemberId,
    linkedRepositoryId,
    ownerAccess: {
      identity: { userId, email: `${suffix}@example.com`, sessionId: `session-${suffix}` },
      workspace: { id: workspaceId, name: `Workspace ${suffix}` },
      membership: {
        id: membershipId, userId, role: 'owner' as const, joinedAt: new Date()
      }
    },
    memberAccess: {
      identity: {
        userId: memberUserId,
        email: `member-${suffix}@example.com`,
        sessionId: `member-session-${suffix}`
      },
      workspace: { id: workspaceId, name: `Workspace ${suffix}` },
      membership: {
        id: memberMembershipId, userId: memberUserId, role: 'member' as const, joinedAt: new Date()
      }
    }
  };
}

async function seedAdditionalQueuedAgentRun(
  pool: Pool,
  context: Awaited<ReturnType<typeof seedQueuedAgentRun>>,
  suffix: string
) {
  const messageId = `message-${suffix}`;
  const taskId = `task-${suffix}`;
  const runId = `run-${suffix}`;
  await pool.query(
    `INSERT INTO public.message (
       id, workspace_id, channel_id, author_workspace_member_id, body,
       agent_mention_status, mentioned_agent_id
     ) VALUES ($1, $2, $3, $4, '@Alex inspect the second test.', 'accepted', $5)`,
    [messageId, context.workspaceId, context.channelId, context.pilotMemberId, context.agentId]
  );
  await pool.query(
    `INSERT INTO public.task (
       id, workspace_id, project_id, assigned_agent_id, source_message_id,
       requested_by_workspace_member_id, request_snapshot, context_snapshot
     ) VALUES ($1, $2, $3, $4, $5, $6, '@Alex inspect the second test.', '{}')`,
    [taskId, context.workspaceId, context.projectId, context.agentId, messageId, context.pilotMemberId]
  );
  await pool.query(
    `INSERT INTO public.agent_run (
       id, workspace_id, task_id, agent_id, provider_connection_id,
       linked_repository_id, attempt_number, status,
       requested_by_workspace_member_id, request_message_id
     ) VALUES ($1, $2, $3, $4, $5, $6, 1, 'queued', $7, $8)`,
    [
      runId, context.workspaceId, taskId, context.agentId,
      context.providerConnectionId, context.linkedRepositoryId,
      context.pilotMemberId, messageId
    ]
  );
  await insertQueuedEvent(pool, context.workspaceId, runId);
  return { runId };
}

async function insertQueuedEvent(pool: Pool, workspaceId: string, runId: string): Promise<void> {
  await pool.query(
    `WITH event AS (
       INSERT INTO public.agent_run_event (
         workspace_id, agent_run_id, sequence, event_type, status, summary
       ) VALUES ($1, $2, 1, 'run.queued', 'queued', 'Engineering request queued')
       RETURNING id
     )
     INSERT INTO public.notification_outbox (workspace_id, agent_run_event_id, topic, payload)
       SELECT $1, id, 'agent_run.event', jsonb_build_object(
         'agentRunId', $2::text, 'eventType', 'run.queued'
       ) FROM event`,
    [workspaceId, runId]
  );
}

async function countTasksForMessage(pool: Pool, messageId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    'SELECT count(*)::integer AS count FROM public.task WHERE source_message_id = $1',
    [messageId]
  );
  return result.rows[0]?.count ?? 0;
}

async function waitForRow<T>(
  pool: Pool,
  query: string,
  values: unknown[],
  timeoutMs = 2_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query<T & Record<string, unknown>>(query, values);
    if (result.rows[0]) return result.rows[0] as T;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for persisted test state');
}
