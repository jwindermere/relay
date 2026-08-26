import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { hashPassword } from 'better-auth/crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';

import { createAuthDatabasePool, createRelayAuth } from '../src/lib/server/auth.js';
import {
  authorizeWorkspaceRequest,
  revokeWorkspaceMembership
} from '../src/lib/server/authentication/authorization.js';
import { bootstrapOwner } from '../src/lib/server/authentication/bootstrap.js';
import {
  loadSharedAgentChannel,
  postChannelMessage
} from '../src/lib/server/collaboration/channel.js';
import { loadChannelReconciliation } from '../src/lib/server/collaboration/reconciliation.js';
import {
  beginProviderConnectionLogin,
  disableProviderConnection,
  disconnectProviderConnection,
  loadProviderConnection,
  requireReadyProviderConnection,
  type ManagedCodexRuntime,
  type ManagedLoginCompletion
} from '../src/lib/server/provider/connection.js';
import {
  disableGitHubConnection,
  linkGitHubRepository,
  loadLinkedRepository,
  requireAutonomousLinkedRepository,
  verifyLinkedRepository,
  type GitHubRepositoryGateway
} from '../src/lib/server/github/connection.js';
import type { GitHubRepositoryEvidence } from '../src/lib/server/github/protection.js';
import {
  acceptWorkspaceInvitation,
  issueWorkspaceInvitation,
  registerInvitedAccount
} from '../src/lib/server/authentication/invitations.js';
import { migrateDatabase } from '../src/lib/server/database/migrations.js';
import {
  assertCompatibleSchema,
  IncompatibleSchemaError,
  REQUIRED_MIGRATION_STREAM_VERSIONS
} from '../src/lib/server/database/schema.js';
import { attachAuthenticatedRealtime } from '../src/lib/server/realtime.js';

let container: StartedPostgreSqlContainer | undefined;
let connectionString = process.env.TEST_DATABASE_URL;
const skipDatabaseTests = process.env.SKIP_DATABASE_TESTS === 'true';

function protectedRepositoryEvidence(): GitHubRepositoryEvidence {
  return {
    appId: 17,
    installation: {
      id: 101,
      repositorySelection: 'selected',
      permissions: { metadata: 'read', contents: 'write', pullRequests: 'write' },
      repositoryIds: [202]
    },
    repository: {
      id: 202,
      nodeId: 'R_202',
      ownerNodeId: 'O_303',
      owner: 'relay-owner',
      name: 'pilot',
      defaultBranch: 'main',
      branches: ['main', 'release']
    },
    branches: ['main', 'release'].map((name, index) => ({
      name,
      rules: [
        {
          rulesetId: 401 + index,
          type: 'pull_request',
          parameters: {
            requiredApprovingReviewCount: 1,
            dismissStaleReviewsOnPush: true,
            requireLastPushApproval: true
          }
        },
        {
          rulesetId: 401 + index,
          type: 'required_status_checks',
          parameters: { requiredStatusChecks: ['test'] }
        },
        { rulesetId: 401 + index, type: 'non_fast_forward' },
        { rulesetId: 401 + index, type: 'deletion' }
      ],
      rulesets: [{ id: 401 + index, bypassActorAppIds: [] }]
    }))
  };
}

if (skipDatabaseTests) {
  test('the production PostgreSQL seam', { skip: 'SKIP_DATABASE_TESTS=true' });
} else if (!connectionString) {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  connectionString = container.getConnectionUri();
}

if (connectionString) {
  const pool = new Pool({ connectionString });
  const authPools: Pool[] = [];
  let pilotMemberHeaders: Headers | undefined;
  let pilotMemberUserId: string | undefined;
  const createTestAuth = (
    sendVerificationEmail?: (data: { user: { email: string }; url: string }) => Promise<void>
  ) => {
    const authPool = createAuthDatabasePool(connectionString);
    authPools.push(authPool);
    return createRelayAuth({
      pool: authPool,
      baseURL: 'http://relay.test',
      secret: 'test-secret-at-least-thirty-two-characters',
      sendVerificationEmail
    });
  };
  after(async () => {
    await Promise.all(authPools.map((authPool) => authPool.end()));
    await pool.end();
    await container?.stop();
  });

  test('migrations isolate Relay domain data in public and authentication data in auth', async () => {
    await migrateDatabase(pool);

    const result = await pool.query<{ table_schema: string; table_name: string }>(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_schema IN ('public', 'auth')
      ORDER BY table_schema, table_name
    `);

    assert.deepEqual(result.rows, [
      { table_schema: 'auth', table_name: 'account' },
      { table_schema: 'auth', table_name: 'schema_migrations' },
      { table_schema: 'auth', table_name: 'session' },
      { table_schema: 'auth', table_name: 'user' },
      { table_schema: 'auth', table_name: 'verification' },
      { table_schema: 'public', table_name: 'agent' },
      { table_schema: 'public', table_name: 'agent_run' },
      { table_schema: 'public', table_name: 'agent_run_event' },
      { table_schema: 'public', table_name: 'audit_event' },
      { table_schema: 'public', table_name: 'channel' },
      { table_schema: 'public', table_name: 'github_connection' },
      { table_schema: 'public', table_name: 'linked_repository' },
      { table_schema: 'public', table_name: 'message' },
      { table_schema: 'public', table_name: 'notification_outbox' },
      { table_schema: 'public', table_name: 'project' },
      { table_schema: 'public', table_name: 'project_membership' },
      { table_schema: 'public', table_name: 'provider_connection' },
      { table_schema: 'public', table_name: 'runtime_state' },
      { table_schema: 'public', table_name: 'schema_migrations' },
      { table_schema: 'public', table_name: 'task' },
      { table_schema: 'public', table_name: 'workspace' },
      { table_schema: 'public', table_name: 'workspace_invitation' },
      { table_schema: 'public', table_name: 'workspace_member' },
      { table_schema: 'public', table_name: 'workspace_membership' }
    ]);
    await assert.doesNotReject(assertCompatibleSchema(pool));
  });

  test('a runtime rejects an incompatible schema version', async () => {
    await pool.query('UPDATE public.schema_migrations SET version = 99 WHERE version = 9');

    try {
      await assert.rejects(assertCompatibleSchema(pool), (error: unknown) => {
        assert.ok(error instanceof IncompatibleSchemaError);
        assert.match(error.message, /relay schema version 99 is incompatible/);
        assert.deepEqual(error.requiredVersions, REQUIRED_MIGRATION_STREAM_VERSIONS);
        return true;
      });
    } finally {
      await pool.query('UPDATE public.schema_migrations SET version = 9 WHERE version = 99');
    }
  });

  test('local bootstrap creates one verified owner and no public sign-up', async () => {
    await pool.query('TRUNCATE public.audit_event, public.workspace_membership, public.workspace, auth.session, auth.account, auth.verification, auth."user" CASCADE');

    const owner = await bootstrapOwner(pool, {
      email: 'Owner@Example.com',
      name: 'Relay Owner',
      password: 'correct horse battery staple',
      workspaceName: 'MVP pilot workspace'
    });

    await assert.rejects(
      bootstrapOwner(pool, {
        email: 'other@example.com',
        name: 'Other Owner',
        password: 'another correct horse battery staple',
        workspaceName: 'Another workspace'
      }),
      /already bootstrapped/
    );

    const counts = await pool.query<{ users: number; workspaces: number; memberships: number }>(`
      SELECT
        (SELECT count(*)::integer FROM auth."user") AS users,
        (SELECT count(*)::integer FROM public.workspace) AS workspaces,
        (SELECT count(*)::integer FROM public.workspace_membership WHERE revoked_at IS NULL) AS memberships
    `);
    assert.deepEqual(counts.rows[0], { users: 1, workspaces: 1, memberships: 1 });

    const storedOwner = await pool.query<{
      email: string;
      emailVerified: boolean;
      password: string;
      role: string;
    }>(`
      SELECT u.email, u."emailVerified", a.password, m.role
      FROM auth."user" u
      JOIN auth.account a ON a."userId" = u.id
      JOIN public.workspace_membership m ON m.user_id = u.id
      WHERE u.id = $1
    `, [owner.userId]);
    assert.equal(storedOwner.rows[0]?.email, 'owner@example.com');
    assert.equal(storedOwner.rows[0]?.emailVerified, true);
    assert.equal(storedOwner.rows[0]?.role, 'owner');
    assert.notEqual(storedOwner.rows[0]?.password, 'correct horse battery staple');

    const auth = createTestAuth();
    const signUpResponse = await auth.handler(new Request('http://relay.test/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://relay.test' },
      body: JSON.stringify({
        email: 'public@example.com',
        name: 'Public User',
        password: 'not allowed here'
      })
    }));
    assert.equal(signUpResponse.status, 400);

    const audit = await pool.query<{ evidence: Record<string, unknown> }>(
      'SELECT evidence FROM public.audit_event ORDER BY id'
    );
    assert.equal(audit.rows.length, 1);
    assert.doesNotMatch(JSON.stringify(audit.rows), /correct horse|password|session.*token/i);
  });

  test('an active owner invites the verified second Pilot member exactly once', async () => {
    let verificationUrl: string | undefined;
    const auth = createTestAuth(async ({ url }) => {
      verificationUrl = url;
    });
    const ownerSignIn = await auth.handler(new Request('http://relay.test/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://relay.test' },
      body: JSON.stringify({
        email: 'owner@example.com',
        password: 'correct horse battery staple'
      })
    }));
    const ownerCookie = ownerSignIn.headers.get('set-cookie');
    assert.equal(ownerSignIn.status, 200);
    assert.ok(ownerCookie);
    const ownerHeaders = new Headers({ cookie: ownerCookie.split(';', 1)[0] });
    const ownerAccess = await authorizeWorkspaceRequest(pool, auth, ownerHeaders);

    await assert.rejects(
      issueWorkspaceInvitation(
        pool,
        { ...ownerAccess, identity: { ...ownerAccess.identity, sessionId: 'stale-session' } },
        { email: 'member@example.com' }
      ),
      /current Workspace owner access is required/
    );

    const invitation = await issueWorkspaceInvitation(pool, ownerAccess, {
      email: 'Member@Example.com'
    });
    assert.equal(invitation.email, 'member@example.com');
    assert.ok(invitation.expiresAt > new Date());

    const storedInvitation = await pool.query<{
      token_hash: string;
      inviter_membership_id: string;
    }>(
      `SELECT token_hash, inviter_membership_id
       FROM public.workspace_invitation
       WHERE id = $1`,
      [invitation.id]
    );
    assert.notEqual(storedInvitation.rows[0]?.token_hash, invitation.token);
    assert.equal(storedInvitation.rows[0]?.inviter_membership_id, ownerAccess.membership.id);
    await assert.rejects(
      acceptWorkspaceInvitation(pool, auth, new Headers(), invitation.token),
      /authenticated verified email is required/
    );

    const passwordHash = await hashPassword('wrong member password');
    await pool.query(
      `INSERT INTO auth."user" (
         id, name, email, "emailVerified", "createdAt", "updatedAt"
       ) VALUES ('wrong-member', 'Wrong member', 'wrong@example.com', true, now(), now())`
    );
    await pool.query(
      `INSERT INTO auth.account (
         id, issuer, "accountId", "providerId", "userId", password, "createdAt", "updatedAt"
       ) VALUES ($1, 'local:credential', 'wrong-member', 'credential',
         'wrong-member', $2, now(), now())`,
      [randomUUID(), passwordHash]
    );

    const wrongSignIn = await auth.handler(new Request('http://relay.test/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://relay.test' },
      body: JSON.stringify({ email: 'wrong@example.com', password: 'wrong member password' })
    }));
    const wrongCookie = wrongSignIn.headers.get('set-cookie');
    assert.equal(wrongSignIn.status, 200);
    assert.ok(wrongCookie);
    await assert.rejects(
      acceptWorkspaceInvitation(
        pool,
        auth,
        new Headers({ cookie: wrongCookie.split(';', 1)[0] }),
        invitation.token
      ),
      /verified email does not match/
    );

    const memberAccount = await registerInvitedAccount(pool, auth, invitation.token, {
      name: 'Pilot member',
      password: 'member password is private'
    });
    const unverified = await pool.query<{ email_verified: boolean; password: string }>(
      `SELECT u."emailVerified" AS email_verified, a.password
       FROM auth."user" u
       JOIN auth.account a ON a."userId" = u.id
       WHERE u.id = $1`,
      [memberAccount.userId]
    );
    assert.equal(unverified.rows[0]?.email_verified, false);
    assert.notEqual(unverified.rows[0]?.password, 'member password is private');
    assert.ok(verificationUrl);

    const unverifiedSignIn = await auth.handler(new Request(
      'http://relay.test/api/auth/sign-in/email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://relay.test' },
        body: JSON.stringify({
          email: 'member@example.com',
          password: 'member password is private'
        })
      }
    ));
    assert.equal(unverifiedSignIn.status, 403);
    assert.ok(verificationUrl);
    const verification = await auth.handler(new Request(verificationUrl, {
      headers: { origin: 'http://relay.test' },
      redirect: 'manual'
    }));
    assert.ok(verification.status === 200 || verification.status === 302);

    await pool.query(
      `UPDATE public.workspace_invitation
       SET created_at = now() - interval '2 days',
           expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [invitation.id]
    );

    const memberSignIn = await auth.handler(new Request('http://relay.test/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://relay.test' },
      body: JSON.stringify({ email: 'member@example.com', password: 'member password is private' })
    }));
    const memberCookie = memberSignIn.headers.get('set-cookie');
    assert.equal(memberSignIn.status, 200);
    assert.ok(memberCookie);
    const memberHeaders = new Headers({ cookie: memberCookie.split(';', 1)[0] });
    pilotMemberHeaders = memberHeaders;
    pilotMemberUserId = memberAccount.userId;
    await assert.rejects(
      acceptWorkspaceInvitation(pool, auth, memberHeaders, invitation.token),
      /invitation is no longer available/
    );
    const replacementInvitation = await issueWorkspaceInvitation(pool, ownerAccess, {
      email: 'member@example.com'
    });
    const acceptanceAttempts = await Promise.allSettled([
      acceptWorkspaceInvitation(pool, auth, memberHeaders, replacementInvitation.token),
      acceptWorkspaceInvitation(pool, auth, memberHeaders, replacementInvitation.token)
    ]);
    const acceptedAttempts = acceptanceAttempts.filter(
      (attempt) => attempt.status === 'fulfilled'
    );
    const rejectedAttempts = acceptanceAttempts.filter(
      (attempt) => attempt.status === 'rejected'
    );
    assert.equal(acceptedAttempts.length, 1);
    assert.equal(rejectedAttempts.length, 1);
    assert.match(String(rejectedAttempts[0]?.reason), /invitation is no longer available/);
    const accepted = acceptedAttempts[0]?.value;
    assert.ok(accepted);
    assert.equal(accepted.membership.userId, pilotMemberUserId);
    assert.equal(accepted.membership.role, 'member');
    assert.notEqual(accepted.membership.id, ownerAccess.membership.id);

    const memberAccess = await authorizeWorkspaceRequest(pool, auth, memberHeaders);
    assert.deepEqual(memberAccess.membership, accepted.membership);
    await assert.rejects(
      issueWorkspaceInvitation(pool, memberAccess, { email: 'third@example.com' }),
      /Workspace owner access is required/
    );
    await assert.rejects(
      issueWorkspaceInvitation(pool, ownerAccess, { email: 'third@example.com' }),
      /already has both Pilot members/
    );

    const audit = await pool.query<{
      actor_user_id: string;
      actor_membership_id: string;
      event_type: string;
      evidence: Record<string, unknown>;
    }>(
      `SELECT actor_user_id, actor_membership_id, event_type, evidence
       FROM public.audit_event
       WHERE event_type IN ('invitation.issued', 'invitation.accepted', 'membership.joined')
       ORDER BY id`
    );
    assert.deepEqual(
      audit.rows.map(({ actor_user_id, actor_membership_id, event_type }) => ({
        actor_user_id,
        actor_membership_id,
        event_type
      })),
      [
        {
          actor_user_id: ownerAccess.identity.userId,
          actor_membership_id: ownerAccess.membership.id,
          event_type: 'invitation.issued'
        },
        {
          actor_user_id: ownerAccess.identity.userId,
          actor_membership_id: ownerAccess.membership.id,
          event_type: 'invitation.issued'
        },
        {
          actor_user_id: pilotMemberUserId,
          actor_membership_id: accepted.membership.id,
          event_type: 'membership.joined'
        },
        {
          actor_user_id: pilotMemberUserId,
          actor_membership_id: accepted.membership.id,
          event_type: 'invitation.accepted'
        }
      ]
    );
    assert.doesNotMatch(
      JSON.stringify(audit.rows),
      new RegExp(`${invitation.token}|${replacementInvitation.token}`, 'i')
    );
  });

  test('both Pilot members share attributable roots and direct replies with Alex', async () => {
    assert.ok(pilotMemberHeaders);
    const auth = createTestAuth();
    const ownerSignIn = await auth.handler(new Request('http://relay.test/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://relay.test' },
      body: JSON.stringify({
        email: 'owner@example.com',
        password: 'correct horse battery staple'
      })
    }));
    const ownerCookie = ownerSignIn.headers.get('set-cookie');
    assert.equal(ownerSignIn.status, 200);
    assert.ok(ownerCookie);

    const ownerAccess = await authorizeWorkspaceRequest(
      pool,
      auth,
      new Headers({ cookie: ownerCookie.split(';', 1)[0] })
    );
    const memberAccess = await authorizeWorkspaceRequest(pool, auth, pilotMemberHeaders);
    const initial = await loadSharedAgentChannel(pool, ownerAccess);

    assert.equal(initial.project.name, 'Relay MVP');
    assert.equal(initial.channel.name, 'agent-work');
    assert.deepEqual(
      initial.members.map(({ name, kind }) => ({ name, kind })),
      [
        { name: 'Alex', kind: 'agent' },
        { name: 'Pilot member', kind: 'pilot' },
        { name: 'Relay Owner', kind: 'pilot' }
      ]
    );

    const root = await postChannelMessage(pool, ownerAccess, {
      channelId: initial.channel.id,
      body: 'Can we ship the reconnect fix?'
    });
    assert.equal(root.author.workspaceMemberId, ownerAccess.membership.id);
    assert.equal(root.author.name, 'Relay Owner');
    assert.equal(root.parentMessageId, null);

    const reply = await postChannelMessage(pool, memberAccess, {
      channelId: initial.channel.id,
      parentMessageId: root.id,
      body: 'Yes, after the focused checks pass.'
    });
    assert.equal(reply.author.workspaceMemberId, memberAccess.membership.id);
    assert.equal(reply.author.name, 'Pilot member');
    assert.equal(reply.parentMessageId, root.id);

    await assert.rejects(
      postChannelMessage(pool, ownerAccess, {
        channelId: initial.channel.id,
        parentMessageId: reply.id,
        body: 'This nested reply must not be stored.'
      }),
      /reply directly to a channel root/
    );

    const reloadedByOwner = await loadSharedAgentChannel(pool, ownerAccess);
    const reloadedByMember = await loadSharedAgentChannel(pool, memberAccess);
    assert.deepEqual(reloadedByMember.messages, reloadedByOwner.messages);
    assert.deepEqual(
      reloadedByOwner.messages.map(({ body, parentMessageId, author }) => ({
        body,
        parentMessageId,
        author: author.name
      })),
      [
        {
          body: 'Can we ship the reconnect fix?',
          parentMessageId: null,
          author: 'Relay Owner'
        },
        {
          body: 'Yes, after the focused checks pass.',
          parentMessageId: root.id,
          author: 'Pilot member'
        }
      ]
    );
  });

  test('a Message without an explicit Agent mention remains communication only', async () => {
    assert.ok(pilotMemberHeaders);
    const auth = createTestAuth();
    const memberAccess = await authorizeWorkspaceRequest(pool, auth, pilotMemberHeaders);
    const channel = await loadSharedAgentChannel(pool, memberAccess);

    const message = await postChannelMessage(pool, memberAccess, {
      channelId: channel.channel.id,
      body: 'Email support@Alex.com; Alex has useful context, but this is not a delegation.'
    });
    assert.equal(message.agentMention, null);

    const work = await pool.query<{ tasks: number; runs: number }>(`
      SELECT
        (SELECT count(*)::integer FROM public.task WHERE source_message_id = $1) AS tasks,
        (SELECT count(*)::integer
         FROM public.agent_run run
         JOIN public.task task ON task.id = run.task_id
         WHERE task.source_message_id = $1) AS runs
    `, [message.id]);
    assert.deepEqual(work.rows[0], { tasks: 0, runs: 0 });
  });

  test('an ineligible Agent mention retains its Message without partial work', async () => {
    assert.ok(pilotMemberHeaders);
    const auth = createTestAuth();
    const memberAccess = await authorizeWorkspaceRequest(pool, auth, pilotMemberHeaders);
    const channel = await loadSharedAgentChannel(pool, memberAccess);

    const message = await postChannelMessage(pool, memberAccess, {
      channelId: channel.channel.id,
      body: '@Alex please investigate the reconnect failure.'
    });

    assert.equal(message.agentMention?.status, 'rejected');
    assert.match(
      message.agentMention?.status === 'rejected' ? message.agentMention.reason : '',
      /ready Codex Provider connection/
    );
    const persisted = await loadSharedAgentChannel(pool, memberAccess);
    assert.deepEqual(
      persisted.messages.find(({ id }) => id === message.id)?.agentMention,
      message.agentMention
    );
    const work = await pool.query<{ tasks: number; runs: number; events: number; outbox: number }>(`
      SELECT
        (SELECT count(*)::integer FROM public.task WHERE source_message_id = $1) AS tasks,
        (SELECT count(*)::integer
         FROM public.agent_run run JOIN public.task task ON task.id = run.task_id
         WHERE task.source_message_id = $1) AS runs,
        (SELECT count(*)::integer
         FROM public.agent_run_event event
         JOIN public.agent_run run ON run.id = event.agent_run_id
         JOIN public.task task ON task.id = run.task_id
         WHERE task.source_message_id = $1) AS events,
        (SELECT count(*)::integer
         FROM public.notification_outbox outbox
         JOIN public.agent_run_event event ON event.id = outbox.agent_run_event_id
         JOIN public.agent_run run ON run.id = event.agent_run_id
         JOIN public.task task ON task.id = run.task_id
         WHERE task.source_message_id = $1) AS outbox
    `, [message.id]);
    assert.deepEqual(work.rows[0], { tasks: 0, runs: 0, events: 0, outbox: 0 });
  });

  test('only the active owner manages the protected Codex Provider connection', async () => {
    assert.ok(pilotMemberHeaders);
    const auth = createTestAuth();
    const ownerSignIn = await auth.handler(new Request('http://relay.test/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://relay.test' },
      body: JSON.stringify({
        email: 'owner@example.com',
        password: 'correct horse battery staple'
      })
    }));
    const ownerCookie = ownerSignIn.headers.get('set-cookie');
    assert.equal(ownerSignIn.status, 200);
    assert.ok(ownerCookie);

    const ownerAccess = await authorizeWorkspaceRequest(
      pool,
      auth,
      new Headers({ cookie: ownerCookie.split(';', 1)[0] })
    );
    const memberAccess = await authorizeWorkspaceRequest(pool, auth, pilotMemberHeaders);
    let finishLogin: ((completion: ManagedLoginCompletion) => Promise<void>) | undefined;
    const runtimeCalls: Array<Record<string, unknown>> = [];
    const runtime: ManagedCodexRuntime = {
      async startManagedLogin(input) {
        runtimeCalls.push({
          operation: 'startManagedLogin',
          credentialStoreReference: input.credentialStoreReference,
          loginType: input.loginType
        });
        finishLogin = input.onCompleted;
        return {
          loginId: 'provider-login-secret-reference',
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'OWNER-CODE'
        };
      },
      async logout(input) {
        runtimeCalls.push({ operation: 'logout', ...input });
      }
    };

    await assert.rejects(
      beginProviderConnectionLogin(pool, memberAccess, runtime),
      /current Workspace owner access is required/
    );

    const initiated = await beginProviderConnectionLogin(pool, ownerAccess, runtime);
    assert.deepEqual(initiated.login, {
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'OWNER-CODE'
    });
    assert.equal(initiated.connection.state, 'connecting');
    assert.equal(initiated.connection.readyForExecution, false);
    assert.equal(initiated.connection.canManage, true);
    assert.ok(finishLogin);
    await finishLogin({ success: true, authMode: 'chatgpt' });

    const ownerView = await loadProviderConnection(pool, ownerAccess);
    const memberView = await loadProviderConnection(pool, memberAccess);
    assert.deepEqual(
      { ...memberView, canManage: true },
      ownerView
    );
    assert.equal(memberView.state, 'ready');
    assert.equal(memberView.readyForExecution, true);
    assert.equal(memberView.canManage, false);
    assert.doesNotMatch(
      JSON.stringify({ ownerView, memberView }),
      /provider-login-secret-reference|credentialStoreReference|OWNER-CODE/i
    );

    const stored = await pool.query<{
      id: string;
      credential_store_reference: string;
      provider_login_id: string;
      status: string;
    }>(
      `SELECT id, credential_store_reference, provider_login_id, status
       FROM public.provider_connection
       WHERE workspace_id = $1`,
      [ownerAccess.workspace.id]
    );
    assert.match(stored.rows[0]?.credential_store_reference ?? '', /^codex:/);
    assert.equal(stored.rows[0]?.provider_login_id, 'provider-login-secret-reference');
    assert.equal(stored.rows[0]?.status, 'ready');
    const executionConnection = await requireReadyProviderConnection(pool, ownerAccess.workspace.id);
    assert.equal(executionConnection.connectionId, stored.rows[0]?.id);
    assert.match(executionConnection.credentialStoreReference, /^codex:/);

    await assert.rejects(
      disableProviderConnection(pool, memberAccess),
      /current Workspace owner access is required/
    );
    const disabled = await disableProviderConnection(pool, ownerAccess);
    assert.equal(disabled.state, 'disabled');
    assert.equal(disabled.readyForExecution, false);
    await assert.rejects(
      requireReadyProviderConnection(pool, ownerAccess.workspace.id),
      /ready Codex Provider connection is required/
    );

    await assert.rejects(
      disconnectProviderConnection(pool, memberAccess, runtime),
      /current Workspace owner access is required/
    );
    const failingRuntime: ManagedCodexRuntime = {
      ...runtime,
      async logout() {
        throw new Error('fixture logout failure containing protected details');
      }
    };
    await assert.rejects(
      disconnectProviderConnection(pool, ownerAccess, failingRuntime),
      /remains disabled and can be retried/
    );
    assert.equal((await loadProviderConnection(pool, ownerAccess)).state, 'disabled');

    await pool.query(
      `UPDATE public.provider_connection
       SET status = 'disconnecting'
       WHERE workspace_id = $1`,
      [ownerAccess.workspace.id]
    );

    const disconnected = await disconnectProviderConnection(pool, ownerAccess, runtime);
    assert.equal(disconnected.state, 'not_connected');
    assert.equal(disconnected.readyForExecution, false);
    assert.equal(runtimeCalls.at(-1)?.operation, 'logout');

    const preserved = await pool.query<{ provider_rows: number; agent_rows: number; message_rows: number }>(
      `SELECT
         (SELECT count(*)::integer FROM public.provider_connection WHERE workspace_id = $1)
           AS provider_rows,
         (SELECT count(*)::integer FROM public.agent WHERE workspace_id = $1) AS agent_rows,
         (SELECT count(*)::integer FROM public.message WHERE workspace_id = $1) AS message_rows`,
      [ownerAccess.workspace.id]
    );
    assert.deepEqual(preserved.rows[0], { provider_rows: 1, agent_rows: 1, message_rows: 2 });

    const audit = await pool.query<{ evidence: Record<string, unknown> }>(
      `SELECT evidence FROM public.audit_event
       WHERE event_type LIKE 'provider.connection.%'
       ORDER BY id`
    );
    assert.equal(audit.rows.length, 6);
    assert.doesNotMatch(
      JSON.stringify(audit.rows),
      /provider-login-secret-reference|codex:|OWNER-CODE|api.?key/i
    );
  });

  test('only the active owner links and verifies one stable GitHub repository identity', async () => {
    assert.ok(pilotMemberHeaders);
    const auth = createTestAuth();
    const ownerSignIn = await auth.handler(new Request('http://relay.test/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://relay.test' },
      body: JSON.stringify({
        email: 'owner@example.com',
        password: 'correct horse battery staple'
      })
    }));
    const ownerCookie = ownerSignIn.headers.get('set-cookie');
    assert.equal(ownerSignIn.status, 200);
    assert.ok(ownerCookie);
    const ownerAccess = await authorizeWorkspaceRequest(
      pool,
      auth,
      new Headers({ cookie: ownerCookie.split(';', 1)[0] })
    );
    const memberAccess = await authorizeWorkspaceRequest(pool, auth, pilotMemberHeaders);
    const inspected: GitHubRepositoryEvidence[] = [];
    let inspectionFails = false;
    let evidence = protectedRepositoryEvidence();
    const gateway: GitHubRepositoryGateway = {
      async inspect(input) {
        if (inspectionFails) throw new Error('GitHub fixture unavailable');
        assert.equal(input.installationId, String(evidence.installation.id));
        assert.equal(input.repositoryId, String(evidence.repository.id));
        inspected.push(evidence);
        return evidence;
      }
    };

    await assert.rejects(
      linkGitHubRepository(pool, memberAccess, {
        installationId: '101',
        repositoryId: '202',
        releaseBranches: ['release']
      }, gateway),
      /current Workspace owner access is required/
    );

    evidence = structuredClone(evidence);
    evidence.branches[0]!.rulesets[0]!.bypassActorAppIds = [17];
    const unsafe = await linkGitHubRepository(pool, ownerAccess, {
      installationId: '101',
      repositoryId: '202',
      releaseBranches: ['release']
    }, gateway);
    assert.equal(unsafe.linkState, 'linked');
    assert.equal(unsafe.githubConnectionState, 'active');
    assert.equal(unsafe.readyForAutonomousWork, false);
    assert.deepEqual(unsafe.configuration?.repository, {
      owner: 'relay-owner',
      name: 'pilot',
      defaultBranch: 'main',
      releaseBranches: ['release']
    });
    await assert.rejects(
      requireAutonomousLinkedRepository(pool, ownerAccess.workspace.id, gateway),
      /verified Linked pilot repository is required/
    );

    const memberView = await loadLinkedRepository(pool, memberAccess);
    assert.equal(memberView.linkState, 'linked');
    assert.equal(memberView.githubConnectionState, 'active');
    assert.equal(memberView.readyForAutonomousWork, false);
    assert.equal(memberView.canManage, false);
    assert.equal(memberView.configuration, undefined);

    evidence = structuredClone(evidence);
    evidence.branches[0]!.rulesets[0]!.bypassActorAppIds = [];
    const verified = await verifyLinkedRepository(pool, ownerAccess, gateway);
    assert.equal(verified.readyForAutonomousWork, true);
    const executionRepository = await requireAutonomousLinkedRepository(
      pool,
      ownerAccess.workspace.id,
      gateway
    );
    assert.deepEqual(executionRepository, {
      githubConnectionId: verified.configuration?.githubConnectionId,
      linkedRepositoryId: verified.configuration?.linkedRepositoryId,
      installationId: '101',
      repositoryId: '202',
      owner: 'relay-owner',
      name: 'pilot',
      defaultBranch: 'main',
      releaseBranches: ['release']
    });

    evidence = structuredClone(evidence);
    evidence.branches[0]!.rulesets[0]!.bypassActorAppIds = [17];
    await assert.rejects(
      requireAutonomousLinkedRepository(pool, ownerAccess.workspace.id, gateway),
      /verified Linked pilot repository is required/
    );
    assert.equal((await loadLinkedRepository(pool, ownerAccess)).readyForAutonomousWork, false);
    evidence = structuredClone(evidence);
    evidence.branches[0]!.rulesets[0]!.bypassActorAppIds = [];
    assert.equal(
      (await verifyLinkedRepository(pool, ownerAccess, gateway)).readyForAutonomousWork,
      true
    );

    inspectionFails = true;
    const unverifiable = await verifyLinkedRepository(pool, ownerAccess, gateway);
    assert.equal(unverifiable.readyForAutonomousWork, false);
    assert.deepEqual(unverifiable.configuration?.protection.failures, [
      'GitHub repository configuration could not be verified'
    ]);
    await assert.rejects(
      requireAutonomousLinkedRepository(pool, ownerAccess.workspace.id, gateway),
      /verified Linked pilot repository is required/
    );
    inspectionFails = false;

    await assert.rejects(
      loadLinkedRepository(pool, {
        ...ownerAccess,
        identity: { ...ownerAccess.identity, sessionId: 'stale-session' }
      }),
      /current Workspace owner access is required/
    );
    await assert.rejects(
      disableGitHubConnection(pool, memberAccess),
      /current Workspace owner access is required/
    );
    const disabled = await disableGitHubConnection(pool, ownerAccess);
    assert.equal(disabled.linkState, 'linked');
    assert.equal(disabled.githubConnectionState, 'disabled');
    assert.equal(disabled.readyForAutonomousWork, false);
    const disabledVerification = await verifyLinkedRepository(pool, ownerAccess, gateway);
    assert.equal(disabledVerification.linkState, 'linked');
    assert.equal(disabledVerification.githubConnectionState, 'disabled');
    assert.equal(disabledVerification.readyForAutonomousWork, false);
    assert.equal(inspected.length, 6);

    const stored = await pool.query<{
      installation_id: string;
      repository_id: string;
      repository_node_id: string;
      owner_node_id: string;
    }>(
      `SELECT installation_id, repository_id, repository_node_id, owner_node_id
       FROM public.github_connection connection
       JOIN public.linked_repository repository
         ON repository.github_connection_id = connection.id
       WHERE connection.workspace_id = $1`,
      [ownerAccess.workspace.id]
    );
    assert.deepEqual(stored.rows, [{
      installation_id: '101',
      repository_id: '202',
      repository_node_id: 'R_202',
      owner_node_id: 'O_303'
    }]);
  });

  test('an eligible Agent mention atomically creates one snapshotted queued AgentRun', async () => {
    assert.ok(pilotMemberHeaders);
    const auth = createTestAuth();
    const memberAccess = await authorizeWorkspaceRequest(pool, auth, pilotMemberHeaders);
    const channel = await loadSharedAgentChannel(pool, memberAccess);
    await pool.query(
      `UPDATE public.provider_connection
       SET status = 'ready', connected_at = COALESCE(connected_at, now())
       WHERE workspace_id = $1`,
      [memberAccess.workspace.id]
    );
    await pool.query(
      `UPDATE public.github_connection SET status = 'active' WHERE workspace_id = $1`,
      [memberAccess.workspace.id]
    );
    let repositoryEvidence = protectedRepositoryEvidence();
    const repositoryGateway: GitHubRepositoryGateway = {
      async inspect() {
        return repositoryEvidence;
      }
    };
    const mentionDependencies = { getRepositoryGateway: () => repositoryGateway };

    repositoryEvidence = structuredClone(repositoryEvidence);
    repositoryEvidence.installation.permissions = { metadata: 'read' };
    const unsafeRepository = await postChannelMessage(pool, memberAccess, {
      channelId: channel.channel.id,
      body: '@Alex investigate the reconnect failure.'
    }, mentionDependencies);
    assert.equal(unsafeRepository.agentMention?.status, 'rejected');
    assert.match(
      unsafeRepository.agentMention?.status === 'rejected'
        ? unsafeRepository.agentMention.reason
        : '',
      /Current repository permissions and protected-branch controls/
    );
    repositoryEvidence = protectedRepositoryEvidence();

    const unsafe = await postChannelMessage(pool, memberAccess, {
      channelId: channel.channel.id,
      body: '@Alex please deploy this directly to production.'
    }, mentionDependencies);
    assert.equal(unsafe.agentMention?.status, 'rejected');
    assert.match(
      unsafe.agentMention?.status === 'rejected' ? unsafe.agentMention.reason : '',
      /cannot accept requests to merge, deploy, or administer/
    );
    for (const forbiddenRequest of [
      '@Alex destroy the repository.',
      '@Alex truncate every table.',
      '@Alex remove all files.',
      '@Alex git reset --hard.',
      '@Alex push directly to main.'
    ]) {
      const rejected = await postChannelMessage(pool, memberAccess, {
        channelId: channel.channel.id,
        body: forbiddenRequest
      }, mentionDependencies);
      assert.equal(rejected.agentMention?.status, 'rejected', forbiddenRequest);
    }

    await pool.query(
      `UPDATE public.agent SET status = 'working' WHERE workspace_id = $1`,
      [memberAccess.workspace.id]
    );
    const atCapacity = await postChannelMessage(pool, memberAccess, {
      channelId: channel.channel.id,
      body: '@Alex investigate another reconnect failure.'
    }, mentionDependencies);
    assert.equal(atCapacity.agentMention?.status, 'rejected');
    assert.match(
      atCapacity.agentMention?.status === 'rejected' ? atCapacity.agentMention.reason : '',
      /no capacity/
    );
    await pool.query(
      `UPDATE public.agent SET status = 'idle' WHERE workspace_id = $1`,
      [memberAccess.workspace.id]
    );

    const submissionId = randomUUID();
    const request = '@Alex investigate why the app failed to deploy to production.';
    const [first, retry] = await Promise.all([
      postChannelMessage(pool, memberAccess, {
        channelId: channel.channel.id,
        body: request,
        submissionId
      }, mentionDependencies),
      postChannelMessage(pool, memberAccess, {
        channelId: channel.channel.id,
        body: '@Alex this retry must not retarget the accepted work.',
        submissionId
      }, mentionDependencies)
    ]);
    assert.equal(first.id, retry.id);
    assert.equal(first.body, retry.body);
    assert.equal(first.agentMention?.status, 'accepted');
    assert.deepEqual(first.agentMention, retry.agentMention);

    const accepted = await pool.query<{
      task_id: string;
      run_id: string;
      linked_repository_id: string;
      request_snapshot: string;
      context_snapshot: {
        project: { id: string; name: string };
        channel: { id: string; name: string };
        agent: { id: string; name: string; roleLabel: string };
        repository: {
          linkedRepositoryId: string;
          repositoryId: string;
          owner: string;
          name: string;
          defaultBranch: string;
          releaseBranches: string[];
        };
        safetyPolicy: string;
        messages: Array<{ id: string; body: string }>;
      };
      task_status: string;
      run_status: string;
      event_sequence: number;
      event_type: string;
      event_summary: string;
      outbox_topic: string;
      outbox_payload: { agentRunId: string; eventType: string; sequence: number };
    }>(
      `SELECT task.id AS task_id, run.id AS run_id, run.linked_repository_id,
              task.request_snapshot, task.context_snapshot,
              task.status AS task_status, run.status AS run_status,
              event.sequence AS event_sequence, event.event_type,
              event.summary AS event_summary, outbox.topic AS outbox_topic,
              outbox.payload AS outbox_payload
       FROM public.task task
       JOIN public.agent_run run ON run.task_id = task.id
       JOIN public.agent_run_event event ON event.agent_run_id = run.id
       JOIN public.notification_outbox outbox ON outbox.agent_run_event_id = event.id
       WHERE task.source_message_id = $1`,
      [first.id]
    );
    assert.equal(accepted.rows.length, 1);
    assert.equal(accepted.rows[0]?.request_snapshot, first.body);
    assert.equal(accepted.rows[0]?.task_status, 'open');
    assert.equal(accepted.rows[0]?.run_status, 'queued');
    assert.equal(accepted.rows[0]?.event_sequence, 1);
    assert.equal(accepted.rows[0]?.event_type, 'run.queued');
    assert.equal(accepted.rows[0]?.event_summary, 'Engineering request queued');
    assert.equal(accepted.rows[0]?.outbox_topic, 'agent_run.event');
    assert.deepEqual(accepted.rows[0]?.outbox_payload, {
      agentRunId: accepted.rows[0]?.run_id,
      eventType: 'run.queued',
      sequence: 1
    });

    const initialReconciliation = await loadChannelReconciliation(
      pool,
      memberAccess,
      channel.channel.id,
      {}
    );
    assert.deepEqual(initialReconciliation.runs, [{
      id: accepted.rows[0]?.run_id,
      sourceMessageId: first.id,
      status: 'queued',
      summary: 'Engineering request queued',
      sequence: 1,
      events: [{
        sequence: 1,
        status: 'queued',
        summary: 'Engineering request queued'
      }]
    }]);
    assert.equal(
      initialReconciliation.messages.find(({ id }) => id === first.id)?.body,
      first.body
    );
    assert.deepEqual(
      (await loadChannelReconciliation(
        pool,
        memberAccess,
        channel.channel.id,
        { [accepted.rows[0]!.run_id]: 1 }
      )).runs[0]?.events,
      []
    );
    assert.deepEqual(accepted.rows[0]?.context_snapshot.project, channel.project);
    assert.deepEqual(accepted.rows[0]?.context_snapshot.channel, channel.channel);
    assert.deepEqual(accepted.rows[0]?.context_snapshot.agent, {
      id: first.agentMention?.agentId,
      name: 'Alex',
      roleLabel: 'Engineering agent'
    });
    assert.deepEqual(accepted.rows[0]?.context_snapshot.repository, {
      linkedRepositoryId: accepted.rows[0]?.linked_repository_id,
      repositoryId: '202',
      owner: 'relay-owner',
      name: 'pilot',
      defaultBranch: 'main',
      releaseBranches: ['release']
    });
    assert.equal(
      accepted.rows[0]?.context_snapshot.safetyPolicy,
      'mvp-engineering-autonomy-v1'
    );
    assert.deepEqual(
      accepted.rows[0]?.context_snapshot.messages.map(({ id, body }) => ({ id, body })),
      [{ id: first.id, body: first.body }]
    );

    await pool.query('UPDATE public.message SET body = $2 WHERE id = $1', [
      first.id,
      '@Alex do something entirely different.'
    ]);
    const immutableSnapshot = await pool.query<{ request_snapshot: string }>(
      'SELECT request_snapshot FROM public.task WHERE source_message_id = $1',
      [first.id]
    );
    assert.equal(immutableSnapshot.rows[0]?.request_snapshot, first.body);

    await pool.query(`
      CREATE FUNCTION public.reject_test_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'test outbox failure';
      END;
      $$;
      CREATE TRIGGER reject_test_outbox_insert
      BEFORE INSERT ON public.notification_outbox
      FOR EACH ROW EXECUTE FUNCTION public.reject_test_outbox()
    `);
    const failedSubmissionId = randomUUID();
    try {
      await assert.rejects(
        postChannelMessage(pool, memberAccess, {
          channelId: channel.channel.id,
          body: '@Alex prove the transaction rolls back.',
          submissionId: failedSubmissionId
        }, mentionDependencies),
        /test outbox failure/
      );
    } finally {
      await pool.query('DROP TRIGGER reject_test_outbox_insert ON public.notification_outbox');
      await pool.query('DROP FUNCTION public.reject_test_outbox()');
    }
    const rolledBack = await pool.query<{ messages: number; tasks: number; runs: number }>(`
      SELECT
        (SELECT count(*)::integer FROM public.message
         WHERE client_submission_id = $1) AS messages,
        (SELECT count(*)::integer FROM public.task
         WHERE request_snapshot = '@Alex prove the transaction rolls back.') AS tasks,
        (SELECT count(*)::integer FROM public.agent_run run
         JOIN public.task task ON task.id = run.task_id
         WHERE task.request_snapshot = '@Alex prove the transaction rolls back.') AS runs
    `, [failedSubmissionId]);
    assert.deepEqual(rolledBack.rows[0], { messages: 0, tasks: 0, runs: 0 });
  });

  test('revocation immediately denies protected HTTP and realtime access', async () => {
    const auth = createTestAuth();
    const signInResponse = await auth.handler(new Request('http://relay.test/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://relay.test' },
      body: JSON.stringify({
        email: 'owner@example.com',
        password: 'correct horse battery staple'
      })
    }));
    assert.equal(signInResponse.status, 200);
    const sessionCookie = signInResponse.headers.get('set-cookie');
    assert.ok(sessionCookie);
    const secondSignInResponse = await auth.handler(new Request('http://relay.test/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://relay.test' },
      body: JSON.stringify({
        email: 'owner@example.com',
        password: 'correct horse battery staple'
      })
    }));
    const secondSessionCookie = secondSignInResponse.headers.get('set-cookie');
    assert.equal(secondSignInResponse.status, 200);
    assert.ok(secondSessionCookie);
    const requestHeaders = new Headers({ cookie: sessionCookie.split(';', 1)[0] });

    const httpAccess = await authorizeWorkspaceRequest(pool, auth, requestHeaders);
    assert.equal(httpAccess.membership.role, 'owner');
    await assert.rejects(
      revokeWorkspaceMembership(
        pool,
        { ...httpAccess, identity: { ...httpAccess.identity, sessionId: 'stale-session' } },
        'browser-supplied-user-from-another-workspace'
      ),
      /current Workspace owner access is required/
    );
    await assert.rejects(
      revokeWorkspaceMembership(pool, httpAccess, 'browser-supplied-user-from-another-workspace'),
      /active Workspace membership was not found/
    );

    const server = createServer();
    const realtime = attachAuthenticatedRealtime(server, pool, auth);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const websocket = new WebSocket(`ws://127.0.0.1:${address.port}/realtime`, {
      origin: `http://127.0.0.1:${address.port}`,
      headers: { cookie: sessionCookie.split(';', 1)[0] }
    });
    const ready = await new Promise<string>((resolve, reject) => {
      websocket.once('message', (data) => resolve(data.toString()));
      websocket.once('error', reject);
    });
    assert.deepEqual(JSON.parse(ready), { type: 'ready', workspaceId: httpAccess.workspace.id });
    const secondWebsocket = new WebSocket(`ws://127.0.0.1:${address.port}/realtime`, {
      origin: `http://127.0.0.1:${address.port}`,
      headers: { cookie: secondSessionCookie.split(';', 1)[0] }
    });
    const secondReady = await new Promise<string>((resolve, reject) => {
      secondWebsocket.once('message', (data) => resolve(data.toString()));
      secondWebsocket.once('error', reject);
    });
    assert.deepEqual(JSON.parse(secondReady), {
      type: 'ready',
      workspaceId: httpAccess.workspace.id
    });

    assert.ok(pilotMemberHeaders);
    assert.ok(pilotMemberUserId);
    const memberWebsocket = new WebSocket(`ws://127.0.0.1:${address.port}/realtime`, {
      origin: `http://127.0.0.1:${address.port}`,
      headers: { cookie: pilotMemberHeaders.get('cookie') ?? '' }
    });
    const memberReady = await new Promise<string>((resolve, reject) => {
      memberWebsocket.once('message', (data) => resolve(data.toString()));
      memberWebsocket.once('error', reject);
    });
    assert.deepEqual(JSON.parse(memberReady), {
      type: 'ready',
      workspaceId: httpAccess.workspace.id
    });

    const channel = await loadSharedAgentChannel(pool, httpAccess);
    for (const client of [websocket, secondWebsocket, memberWebsocket]) {
      const subscribed = new Promise<string>((resolve) => {
        client.once('message', (data) => resolve(data.toString()));
      });
      client.send(JSON.stringify({ type: 'subscribe', channelId: channel.channel.id }));
      assert.deepEqual(JSON.parse(await subscribed), {
        type: 'subscribed',
        channelId: channel.channel.id
      });
    }

    const messageWake = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Message wake-up was not delivered')), 2_000);
      memberWebsocket.once('message', (data) => {
        clearTimeout(timeout);
        resolve(data.toString());
      });
    });
    const convergedMessage = await postChannelMessage(pool, httpAccess, {
      channelId: channel.channel.id,
      body: 'Both Pilot views receive this committed Message.'
    });
    assert.deepEqual(JSON.parse(await messageWake), {
      type: 'wake',
      channelId: channel.channel.id
    });
    assert.equal(
      (await loadChannelReconciliation(pool, httpAccess, channel.channel.id, {}))
        .messages.find(({ id }) => id === convergedMessage.id)?.body,
      convergedMessage.body
    );

    const wake = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('realtime wake-up was not delivered')), 2_000);
      memberWebsocket.once('message', (data) => {
        clearTimeout(timeout);
        resolve(data.toString());
      });
    });
    const run = await pool.query<{ id: string; sequence: number }>(
      `SELECT run.id, max(event.sequence)::integer AS sequence
       FROM public.agent_run run
       JOIN public.agent_run_event event ON event.agent_run_id = run.id
       WHERE run.workspace_id = $1
       GROUP BY run.id
       ORDER BY run.created_at DESC
       LIMIT 1`,
      [httpAccess.workspace.id]
    );
    assert.ok(run.rows[0]);
    const event = await pool.query<{ id: number }>(
      `INSERT INTO public.agent_run_event (
         workspace_id, agent_run_id, sequence, event_type, status, summary
       ) VALUES ($1, $2, $3, 'run.test-wake', 'working', 'Working on the request')
       RETURNING id`,
      [httpAccess.workspace.id, run.rows[0].id, run.rows[0].sequence + 1]
    );
    await pool.query(
      `INSERT INTO public.notification_outbox (
         workspace_id, agent_run_event_id, topic, payload
       ) VALUES ($1, $2, 'agent_run.event', $3)`,
      [httpAccess.workspace.id, event.rows[0]!.id, {
        agentRunId: run.rows[0].id,
        eventType: 'run.test-wake',
        sequence: run.rows[0].sequence + 1
      }]
    );
    assert.deepEqual(JSON.parse(await wake), {
      type: 'wake',
      channelId: channel.channel.id
    });

    const crossOrigin = new WebSocket(`ws://127.0.0.1:${address.port}/realtime`, {
      origin: 'https://attacker.example',
      headers: { cookie: sessionCookie.split(';', 1)[0] }
    });
    const rejectedCrossOrigin = await new Promise<number>((resolve) => {
      crossOrigin.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
    });
    assert.equal(rejectedCrossOrigin, 401);
    const memberRealtimeClosed = new Promise<number>((resolve) => {
      memberWebsocket.once('close', (code) => resolve(code));
    });
    await revokeWorkspaceMembership(pool, httpAccess, pilotMemberUserId);
    await assert.rejects(
      authorizeWorkspaceRequest(pool, auth, pilotMemberHeaders),
      /authenticated active Workspace membership is required/
    );
    assert.equal(await memberRealtimeClosed, 1008);
    const memberSessions = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM auth.session
       WHERE "userId" = $1`,
      [pilotMemberUserId]
    );
    assert.equal(memberSessions.rows[0]?.count, 1);

    const realtimeClosed = new Promise<number>((resolve) => {
      websocket.once('close', (code) => resolve(code));
    });
    const signOutResponse = await auth.handler(new Request('http://relay.test/api/auth/sign-out', {
      method: 'POST',
      headers: {
        cookie: sessionCookie.split(';', 1)[0],
        origin: 'http://relay.test'
      }
    }));
    assert.equal(signOutResponse.status, 200);

    await assert.rejects(
      authorizeWorkspaceRequest(pool, auth, requestHeaders),
      /authenticated active Workspace membership is required/
    );

    assert.equal(await realtimeClosed, 1008);
    const secondAcknowledgement = new Promise<string>((resolve) => {
      secondWebsocket.once('message', (data) => resolve(data.toString()));
    });
    secondWebsocket.send(JSON.stringify({ type: 'subscribe', channelId: channel.channel.id }));
    assert.deepEqual(JSON.parse(await secondAcknowledgement), {
      type: 'subscribed',
      channelId: channel.channel.id
    });

    const secondRealtimeClosed = new Promise<number>((resolve) => {
      secondWebsocket.once('close', (code) => resolve(code));
    });
    const secondSignOutResponse = await auth.handler(new Request('http://relay.test/api/auth/sign-out', {
      method: 'POST',
      headers: {
        cookie: secondSessionCookie.split(';', 1)[0],
        origin: 'http://relay.test'
      }
    }));
    assert.equal(secondSignOutResponse.status, 200);
    assert.equal(await secondRealtimeClosed, 1008);
    const memberSignOutResponse = await auth.handler(new Request(
      'http://relay.test/api/auth/sign-out',
      {
        method: 'POST',
        headers: {
          cookie: pilotMemberHeaders.get('cookie') ?? '',
          origin: 'http://relay.test'
        }
      }
    ));
    assert.equal(memberSignOutResponse.status, 200);
    realtime.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });

    const remainingSessions = await pool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM auth.session'
    );
    assert.equal(remainingSessions.rows[0]?.count, 0);

    const audit = await pool.query<{ event_type: string; evidence: Record<string, unknown> }>(
      'SELECT event_type, evidence FROM public.audit_event ORDER BY id'
    );
    assert.ok(audit.rows.some(({ event_type }) => event_type === 'authentication.session.created'));
    assert.ok(audit.rows.some(({ event_type }) => event_type === 'membership.revoked'));
    assert.doesNotMatch(
      JSON.stringify(audit.rows),
      /correct horse|better-auth\.session_token|member-secret-session-token/i
    );
  });
}
