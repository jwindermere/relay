import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';

import { migrateDatabase } from '../src/lib/server/database/migrations.js';
import {
  AgentRunProviderError,
  processNextAgentRun,
  type AgentRunProvider,
  type AgentRunProviderInput,
  type AgentRunProviderObserver,
  type ProviderReconciliation
} from '../src/worker/execution.js';

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

  after(async () => {
    await pool.end();
    await container?.stop();
  });

  test('one leased worker executes a queued AgentRun and persists safe Provider evidence once', async () => {
    const ids = await seedQueuedAgentRun(pool, 'complete');
    const provider = new FixtureProvider(async (input, observer) => {
      assert.equal(input.prompt, '@Alex inspect the failing test.');
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

  test('an expired execution lease reconciles and pauses an indeterminate Provider turn', async () => {
    const ids = await seedQueuedAgentRun(pool, 'recovery');
    await pool.query(
      `UPDATE public.agent_run
       SET status = 'working', provider_thread_id = 'thread-recovery',
           active_turn_id = 'turn-recovery', lease_owner = 'dead-worker',
           lease_token = 'dead-token', lease_expires_at = now() - interval '1 minute'
       WHERE id = $1`,
      [ids.runId]
    );
    const provider = new FixtureProvider(async () => {
      assert.fail('an indeterminate turn must not be replayed');
    }, async () => ({ outcome: 'indeterminate' }));

    const result = await processNextAgentRun(pool, provider, {
      workerId: 'recovery-worker', workspaceRoot, leaseDurationMs: 10_000
    });
    assert.deepEqual(result, { kind: 'recovered', agentRunId: ids.runId, status: 'paused' });
    assert.equal(provider.reconciliations.length, 1);

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
}

class FixtureProvider implements AgentRunProvider {
  readonly executions: AgentRunProviderInput[] = [];
  readonly reconciliations: Array<{ threadId: string; turnId: string }> = [];

  constructor(
    private readonly executeFixture: (
      input: AgentRunProviderInput,
      observer: AgentRunProviderObserver
    ) => Promise<void>,
    private readonly reconcileFixture: (
      input: { threadId: string; turnId: string }
    ) => Promise<ProviderReconciliation> = async () => ({ outcome: 'indeterminate' })
  ) {}

  async execute(input: AgentRunProviderInput, observer: AgentRunProviderObserver): Promise<void> {
    this.executions.push(input);
    await this.executeFixture(input, observer);
  }

  async reconcile(input: { threadId: string; turnId: string }): Promise<ProviderReconciliation> {
    this.reconciliations.push(input);
    return this.reconcileFixture(input);
  }
}

async function seedQueuedAgentRun(pool: Pool, suffix: string) {
  const workspaceId = `workspace-${suffix}`;
  const userId = `user-${suffix}`;
  const membershipId = `membership-${suffix}`;
  const pilotMemberId = `pilot-${suffix}`;
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
  await pool.query('INSERT INTO public.workspace (id, name) VALUES ($1, $2)', [
    workspaceId, `Workspace ${suffix}`
  ]);
  await pool.query(
    `INSERT INTO public.workspace_membership (workspace_id, user_id, role, id)
     VALUES ($1, $2, 'owner', $3)`,
    [workspaceId, userId, membershipId]
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
    `INSERT INTO public.workspace_member (id, workspace_id, kind, agent_id)
     VALUES ($1, $2, 'agent', $3)`,
    [agentMemberId, workspaceId, agentId]
  );
  await pool.query(
    `INSERT INTO public.project_membership (workspace_id, project_id, workspace_member_id)
     VALUES ($1, $2, $3), ($1, $2, $4)`,
    [workspaceId, projectId, pilotMemberId, agentMemberId]
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
       linked_repository_id, attempt_number, status
     ) VALUES ($1, $2, $3, $4, $5, $6, 1, 'queued')`,
    [runId, workspaceId, taskId, agentId, effectiveProviderConnectionId, linkedRepositoryId]
  );
  await insertQueuedEvent(pool, workspaceId, runId);

  return {
    runId,
    providerConnectionId: effectiveProviderConnectionId,
    workspaceId,
    projectId,
    agentId,
    channelId,
    pilotMemberId,
    linkedRepositoryId
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
       linked_repository_id, attempt_number, status
     ) VALUES ($1, $2, $3, $4, $5, $6, 1, 'queued')`,
    [
      runId, context.workspaceId, taskId, context.agentId,
      context.providerConnectionId, context.linkedRepositoryId
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
