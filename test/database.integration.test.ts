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
import {
  endChannelCall,
  joinChannelCall,
  loadActiveChannelCall,
  startChannelCall
} from '../src/lib/server/collaboration/calls.js';
import { loadChannelReconciliation } from '../src/lib/server/collaboration/reconciliation.js';
import { correctMessageIntent } from '../src/lib/server/collaboration/message-intent.js';
import { deleteChannelMessage } from '../src/lib/server/collaboration/messages.js';
import {
  createWorkspace,
  loadAvailableWorkspaces,
  renameWorkspace,
  requireAvailableWorkspace
} from '../src/lib/server/collaboration/workspaces.js';
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
import { issueRealtimeTicket } from '../src/lib/server/realtime-ticket.js';
import { observePilotJourney } from '../src/lib/server/pilot-journey.js';

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
      { table_schema: 'public', table_name: 'agent_conversation' },
      { table_schema: 'public', table_name: 'agent_conversation_turn' },
      { table_schema: 'public', table_name: 'agent_finding' },
      { table_schema: 'public', table_name: 'agent_handoff' },
      { table_schema: 'public', table_name: 'agent_run' },
      { table_schema: 'public', table_name: 'agent_run_cancellation_request' },
      { table_schema: 'public', table_name: 'agent_run_clarification' },
      { table_schema: 'public', table_name: 'agent_run_event' },
      { table_schema: 'public', table_name: 'agent_run_steering' },
      { table_schema: 'public', table_name: 'approval' },
      { table_schema: 'public', table_name: 'artifact' },
      { table_schema: 'public', table_name: 'audit_event' },
      { table_schema: 'public', table_name: 'channel' },
      { table_schema: 'public', table_name: 'channel_call' },
      { table_schema: 'public', table_name: 'channel_call_participant' },
      { table_schema: 'public', table_name: 'collaboration_evaluation_event' },
      { table_schema: 'public', table_name: 'collaboration_feedback' },
      { table_schema: 'public', table_name: 'coordination_budget_reservation' },
      { table_schema: 'public', table_name: 'coordination_plan' },
      { table_schema: 'public', table_name: 'coordination_plan_constraint' },
      { table_schema: 'public', table_name: 'coordination_plan_step' },
      { table_schema: 'public', table_name: 'finding_evidence' },
      { table_schema: 'public', table_name: 'github_broker_decision' },
      { table_schema: 'public', table_name: 'github_connection' },
      { table_schema: 'public', table_name: 'github_webhook_delivery' },
      { table_schema: 'public', table_name: 'linked_repository' },
      { table_schema: 'public', table_name: 'message' },
      { table_schema: 'public', table_name: 'message_intent_decision' },
      { table_schema: 'public', table_name: 'notification_outbox' },
      { table_schema: 'public', table_name: 'project' },
      { table_schema: 'public', table_name: 'project_membership' },
      { table_schema: 'public', table_name: 'project_memory' },
      { table_schema: 'public', table_name: 'provider_connection' },
      { table_schema: 'public', table_name: 'runtime_state' },
      { table_schema: 'public', table_name: 'schema_migrations' },
      { table_schema: 'public', table_name: 'task' },
      { table_schema: 'public', table_name: 'workspace' },
      { table_schema: 'public', table_name: 'workspace_collaboration_evaluation_policy' },
      { table_schema: 'public', table_name: 'workspace_coordination_policy' },
      { table_schema: 'public', table_name: 'workspace_invitation' },
      { table_schema: 'public', table_name: 'workspace_member' },
      { table_schema: 'public', table_name: 'workspace_membership' }
    ]);
    const evaluationColumns = await pool.query<{ column_name: string; is_nullable: string }>(`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'collaboration_evaluation_event'
        AND column_name IN (
          'agent_type', 'routing_policy_version', 'prompt_version',
          'permission_policy_version', 'agent_configuration_version',
          'outcome_type', 'outcome_id', 'expires_at'
        )
      ORDER BY column_name
    `);
    assert.deepEqual(evaluationColumns.rows, [
      { column_name: 'agent_configuration_version', is_nullable: 'NO' },
      { column_name: 'agent_type', is_nullable: 'NO' },
      { column_name: 'expires_at', is_nullable: 'NO' },
      { column_name: 'outcome_id', is_nullable: 'NO' },
      { column_name: 'outcome_type', is_nullable: 'NO' },
      { column_name: 'permission_policy_version', is_nullable: 'NO' },
      { column_name: 'prompt_version', is_nullable: 'NO' },
      { column_name: 'routing_policy_version', is_nullable: 'NO' }
    ]);
    const evaluationSourceColumns = await pool.query<{
      table_name: string; column_name: string; is_nullable: string;
    }>(`
      SELECT table_name, column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN (
          'agent_run', 'agent_conversation_turn', 'coordination_plan'
        )
        AND column_name IN ('agent_configuration_version', 'agent_type_snapshot')
      ORDER BY table_name, column_name
    `);
    assert.deepEqual(evaluationSourceColumns.rows, [
      { table_name: 'agent_conversation_turn', column_name: 'agent_configuration_version', is_nullable: 'NO' },
      { table_name: 'agent_conversation_turn', column_name: 'agent_type_snapshot', is_nullable: 'NO' },
      { table_name: 'agent_run', column_name: 'agent_configuration_version', is_nullable: 'NO' },
      { table_name: 'agent_run', column_name: 'agent_type_snapshot', is_nullable: 'NO' },
      { table_name: 'coordination_plan', column_name: 'agent_configuration_version', is_nullable: 'NO' },
      { table_name: 'coordination_plan', column_name: 'agent_type_snapshot', is_nullable: 'NO' }
    ]);
    await assert.doesNotReject(assertCompatibleSchema(pool));
  });

  test('Agent handoff schema enforces lifecycle, retry, provenance, and loop boundaries', async () => {
    const constraints = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(constraint_row.oid) AS definition
       FROM pg_constraint constraint_row
       JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
       JOIN pg_namespace schema_row ON schema_row.oid = table_row.relnamespace
       WHERE schema_row.nspname = 'public' AND table_row.relname = 'agent_handoff'
       ORDER BY constraint_row.conname`
    );
    const contract = constraints.rows.map(({ definition }) => definition).join('\n');
    assert.match(
      contract,
      /status.*queued.*working.*completed.*failed.*cancelled.*expired/is
    );
    assert.match(contract, /UNIQUE \(source_message_id\)/i);
    assert.match(contract, /UNIQUE \(receiving_turn_id\)/i);
    assert.match(contract, /FOREIGN KEY \(project_id, workspace_id\)/i);
    assert.match(contract, /FOREIGN KEY \(originating_pilot_member_id, workspace_id\)/i);
    assert.match(contract, /FOREIGN KEY \(source_agent_id, workspace_id\)/i);
    assert.match(contract, /FOREIGN KEY \(target_agent_id, workspace_id\)/i);
    assert.match(contract, /source_agent_id <> target_agent_id/i);
    assert.match(contract, /status = 'completed'.*result_message_id IS NOT NULL/is);
    assert.match(contract, /status = 'working'.*started_at IS NOT NULL/is);
  });

  test('a runtime accepts additive mixed-version schemas and rejects unsafe contracts', async () => {
    const compatibleVersion = REQUIRED_MIGRATION_STREAM_VERSIONS.relay + 1;
    const incompatibleVersion = compatibleVersion + 1;
    await pool.query(
      `INSERT INTO public.schema_migrations (version, name, minimum_runtime_version)
       VALUES ($1, $2, $3)`,
      [compatibleVersion, `${compatibleVersion}_expand_only.sql`, REQUIRED_MIGRATION_STREAM_VERSIONS.relay]
    );
    await assert.doesNotReject(assertCompatibleSchema(pool));

    await pool.query(
      `INSERT INTO public.schema_migrations (version, name, minimum_runtime_version)
       VALUES ($1, $2, $3)`,
      [incompatibleVersion, `${incompatibleVersion}_contract.sql`, incompatibleVersion]
    );

    try {
      await assert.rejects(assertCompatibleSchema(pool), (error: unknown) => {
        assert.ok(error instanceof IncompatibleSchemaError);
        assert.equal(
          error.message,
          `relay schema version ${incompatibleVersion} requires runtime schema interface ${incompatibleVersion}`
        );
        assert.deepEqual(error.requiredVersions, REQUIRED_MIGRATION_STREAM_VERSIONS);
        return true;
      });
    } finally {
      await pool.query('DELETE FROM public.schema_migrations WHERE version = ANY($1)', [
        [compatibleVersion, incompatibleVersion]
      ]);
    }
  });

  test('the migrator refuses renamed or modified applied migrations', async () => {
    const original = await pool.query<{ checksum: string; name: string }>(
      'SELECT name, checksum FROM public.schema_migrations WHERE version = 14'
    );
    assert.ok(original.rows[0]);
    try {
      await pool.query(
        `UPDATE public.schema_migrations SET name = '0014_renamed.sql' WHERE version = 14`
      );
      await assert.rejects(migrateDatabase(pool), /does not match the versioned migration set/);
      await pool.query(
        'UPDATE public.schema_migrations SET name = $1, checksum = $2 WHERE version = 14',
        [original.rows[0].name, '0'.repeat(64)]
      );
      await assert.rejects(migrateDatabase(pool), /has been modified/);
    } finally {
      await pool.query(
        'UPDATE public.schema_migrations SET name = $1, checksum = $2 WHERE version = 14',
        [original.rows[0].name, original.rows[0].checksum]
      );
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

    const thirdInvitation = await issueWorkspaceInvitation(pool, ownerAccess, {
      email: 'third@example.com'
    });
    const fourthInvitation = await issueWorkspaceInvitation(pool, ownerAccess, {
      email: 'fourth@example.com'
    });
    assert.equal(thirdInvitation.email, 'third@example.com');
    assert.equal(fourthInvitation.email, 'fourth@example.com');
    await assert.rejects(
      issueWorkspaceInvitation(pool, ownerAccess, { email: 'third@example.com' }),
      /already has an active invitation/
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
        { name: 'Maya', kind: 'agent' },
        { name: 'Pilot member', kind: 'pilot' },
        { name: 'Relay Owner', kind: 'pilot' },
        { name: 'Riley', kind: 'agent' }
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
    assert.deepEqual(message.routingDecision, {
      intent: 'ordinary_communication',
      targetAgentId: null,
      confidence: 1,
      policyVersion: 'rules-v1',
      rationale: 'No eligible Agent mention or active Agent conversation was found.',
      correctedAt: null
    });

    const reloaded = await loadSharedAgentChannel(pool, memberAccess);
    assert.deepEqual(
      reloaded.messages.find(({ id }) => id === message.id)?.routingDecision,
      message.routingDecision
    );
    await correctMessageIntent(pool, memberAccess, message.id, {
      intent: 'conversation',
      targetAgentId: `${memberAccess.workspace.id}:alex`
    });
    const corrected = await loadSharedAgentChannel(pool, memberAccess);
    assert.deepEqual(
      corrected.messages.find(({ id }) => id === message.id)?.routingDecision,
      {
        ...message.routingDecision,
        intent: 'conversation',
        targetAgentId: `${memberAccess.workspace.id}:alex`,
        correctedAt: corrected.messages.find(({ id }) => id === message.id)
          ?.routingDecision?.correctedAt
      }
    );

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
    assert.equal(message.agentMention, null);
    await correctMessageIntent(pool, memberAccess, message.id, { intent: 'engineering_delegation' });
    const confirmed = (await loadSharedAgentChannel(pool, memberAccess))
      .messages.find(({ id }) => id === message.id);
    assert.equal(confirmed?.agentMention?.status, 'rejected');
    assert.match(
      confirmed?.agentMention?.status === 'rejected' ? confirmed.agentMention.reason : '',
      /ready Codex Provider connection/
    );
    const persisted = await loadSharedAgentChannel(pool, memberAccess);
    assert.deepEqual(
      persisted.messages.find(({ id }) => id === message.id)?.agentMention,
      confirmed?.agentMention
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
    const preservedBefore = await pool.query<{ agent_rows: number; message_rows: number }>(
      `SELECT
         (SELECT count(*)::integer FROM public.agent WHERE workspace_id = $1) AS agent_rows,
         (SELECT count(*)::integer FROM public.message WHERE workspace_id = $1) AS message_rows`,
      [ownerAccess.workspace.id]
    );
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
    assert.deepEqual(preserved.rows[0], {
      provider_rows: 1,
      agent_rows: preservedBefore.rows[0]?.agent_rows,
      message_rows: preservedBefore.rows[0]?.message_rows
    });

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

  test('Agent handoff persistence rejects retries, invalid lifecycle changes, and broken provenance', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const fixture = await client.query<{
        workspace_id: string; project_id: string; channel_id: string;
        pilot_member_id: string; source_agent_id: string; source_member_id: string;
        target_agent_id: string; provider_connection_id: string;
      }>(
        `SELECT workspace.id AS workspace_id, project.id AS project_id,
                channel.id AS channel_id, pilot_member.id AS pilot_member_id,
                source_agent.id AS source_agent_id, source_member.id AS source_member_id,
                target_agent.id AS target_agent_id, provider.id AS provider_connection_id
         FROM public.workspace workspace
         JOIN public.project project ON project.workspace_id = workspace.id
         JOIN public.channel channel ON channel.project_id = project.id
         JOIN public.workspace_member pilot_member
           ON pilot_member.workspace_id = workspace.id AND pilot_member.kind = 'pilot'
         JOIN public.agent source_agent
           ON source_agent.workspace_id = workspace.id AND source_agent.name = 'Alex'
         JOIN public.workspace_member source_member ON source_member.agent_id = source_agent.id
         JOIN public.agent target_agent
           ON target_agent.workspace_id = workspace.id AND target_agent.name = 'Maya'
         JOIN public.provider_connection provider ON provider.workspace_id = workspace.id
         ORDER BY project.created_at, pilot_member.created_at
         LIMIT 1`
      );
      const context = fixture.rows[0]!;
      await client.query(
        `INSERT INTO public.message (
           id, workspace_id, channel_id, author_workspace_member_id, body
         ) VALUES ('database-handoff-source', $1, $2, $3, '@Maya Which outcome matters?')`,
        [context.workspace_id, context.channel_id, context.source_member_id]
      );
      await client.query(
        `INSERT INTO public.agent_conversation (
           id, workspace_id, channel_id, root_message_id, agent_id, provider_connection_id
         ) VALUES ('database-handoff-conversation', $1, $2, 'database-handoff-source', $3, $4)`,
        [context.workspace_id, context.channel_id, context.target_agent_id,
          context.provider_connection_id]
      );
      await client.query(
        `INSERT INTO public.agent_conversation_turn (
           id, workspace_id, conversation_id, request_message_id,
           requested_by_workspace_member_id, status, handoff_depth
         ) VALUES (
           'database-handoff-turn', $1, 'database-handoff-conversation',
           'database-handoff-source', $2, 'queued', 1
         )`,
        [context.workspace_id, context.source_member_id]
      );
      const handoffValues = [context.workspace_id, context.project_id,
        context.pilot_member_id, context.source_agent_id, context.target_agent_id];
      const insertHandoff = (id: string) => client.query(
        `INSERT INTO public.agent_handoff (
           id, workspace_id, project_id, originating_pilot_member_id,
           source_agent_id, target_agent_id, source_message_id, receiving_turn_id, question
         ) VALUES ($6, $1, $2, $3, $4, $5,
           'database-handoff-source', 'database-handoff-turn', 'Which outcome matters?')`,
        [...handoffValues, id]
      );
      await insertHandoff('database-handoff');

      const rejected = async (name: string, operation: () => Promise<unknown>) => {
        await client.query(`SAVEPOINT ${name}`);
        await assert.rejects(operation());
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      };
      await rejected('duplicate_retry', () => insertHandoff('database-handoff-retry'));
      await rejected('self_handoff', () => client.query(
        `UPDATE public.agent_handoff SET target_agent_id = source_agent_id
         WHERE id = 'database-handoff'`
      ));
      await rejected('cross_project', () => client.query(
        `UPDATE public.agent_handoff SET project_id = 'missing-project'
         WHERE id = 'database-handoff'`
      ));
      await rejected('invalid_lifecycle', () => client.query(
        `UPDATE public.agent_handoff SET status = 'completed'
         WHERE id = 'database-handoff'`
      ));

      await client.query(
        `UPDATE public.agent_handoff SET status = 'working', started_at = now()
         WHERE id = 'database-handoff'`
      );
      await client.query(
        `UPDATE public.agent_handoff
         SET status = 'failed', completed_at = now(), error_code = 'provider_failed'
         WHERE id = 'database-handoff'`
      );
      const completed = await client.query<{ status: string; error_code: string }>(
        `SELECT status, error_code FROM public.agent_handoff WHERE id = 'database-handoff'`
      );
      assert.deepEqual(completed.rows[0], {
        status: 'failed', error_code: 'provider_failed'
      });
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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
    evidence.branches[0]!.rulesets[0]!.bypassActorAppIds = undefined;
    evidence.branches[0]!.rulesets[0]!.updatedAt = '2026-08-26T19:00:00Z';
    const verified = await verifyLinkedRepository(
      pool,
      ownerAccess,
      gateway,
      { confirmNoAppBypass: true }
    );
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
    evidence.branches[0]!.rulesets[0]!.updatedAt = '2026-08-26T20:00:00Z';
    await assert.rejects(
      requireAutonomousLinkedRepository(pool, ownerAccess.workspace.id, gateway),
      /verified Linked pilot repository is required/
    );
    assert.equal((await loadLinkedRepository(pool, ownerAccess)).readyForAutonomousWork, false);
    assert.equal(
      (await verifyLinkedRepository(
        pool,
        ownerAccess,
        gateway,
        { confirmNoAppBypass: true }
      )).readyForAutonomousWork,
      true
    );

    evidence = structuredClone(evidence);
    evidence.branches[0]!.rulesets[0]!.bypassActorAppIds = [17];
    await assert.rejects(
      requireAutonomousLinkedRepository(pool, ownerAccess.workspace.id, gateway),
      /verified Linked pilot repository is required/
    );
    assert.equal((await loadLinkedRepository(pool, ownerAccess)).readyForAutonomousWork, false);
    evidence = structuredClone(evidence);
    evidence.branches[0]!.rulesets[0]!.bypassActorAppIds = undefined;
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
    assert.equal(inspected.length, 8);

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
    await correctMessageIntent(pool, memberAccess, unsafeRepository.id,
      { intent: 'engineering_delegation' }, mentionDependencies);
    const unsafeRepositoryAfterConfirmation = (await loadSharedAgentChannel(pool, memberAccess))
      .messages.find(({ id }) => id === unsafeRepository.id);
    assert.equal(unsafeRepositoryAfterConfirmation?.agentMention?.status, 'rejected');
    assert.match(
      unsafeRepositoryAfterConfirmation?.agentMention?.status === 'rejected'
        ? unsafeRepositoryAfterConfirmation.agentMention.reason
        : '',
      /Current repository permissions and protected-branch controls/
    );
    repositoryEvidence = protectedRepositoryEvidence();

    const unsafe = await postChannelMessage(pool, memberAccess, {
      channelId: channel.channel.id,
      body: '@Alex please deploy this directly to production.'
    }, mentionDependencies);
    await correctMessageIntent(pool, memberAccess, unsafe.id,
      { intent: 'engineering_delegation' }, mentionDependencies);
    const unsafeAfterConfirmation = (await loadSharedAgentChannel(pool, memberAccess))
      .messages.find(({ id }) => id === unsafe.id);
    assert.equal(unsafeAfterConfirmation?.agentMention?.status, 'rejected');
    assert.match(
      unsafeAfterConfirmation?.agentMention?.status === 'rejected' ? unsafeAfterConfirmation.agentMention.reason : '',
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
      await correctMessageIntent(pool, memberAccess, rejected.id,
        { intent: 'engineering_delegation' }, mentionDependencies);
      const rejectedAfterConfirmation = (await loadSharedAgentChannel(pool, memberAccess))
        .messages.find(({ id }) => id === rejected.id);
      assert.equal(rejectedAfterConfirmation?.agentMention?.status, 'rejected', forbiddenRequest);
    }

    await pool.query(
      `UPDATE public.agent SET status = 'working' WHERE workspace_id = $1`,
      [memberAccess.workspace.id]
    );
    const atCapacity = await postChannelMessage(pool, memberAccess, {
      channelId: channel.channel.id,
      body: '@Alex investigate another reconnect failure.'
    }, mentionDependencies);
    await correctMessageIntent(pool, memberAccess, atCapacity.id,
      { intent: 'engineering_delegation' }, mentionDependencies);
    const atCapacityAfterConfirmation = (await loadSharedAgentChannel(pool, memberAccess))
      .messages.find(({ id }) => id === atCapacity.id);
    assert.equal(atCapacityAfterConfirmation?.agentMention?.status, 'rejected');
    assert.match(
      atCapacityAfterConfirmation?.agentMention?.status === 'rejected' ? atCapacityAfterConfirmation.agentMention.reason : '',
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
        body: request,
        submissionId
      }, mentionDependencies)
    ]);
    assert.equal(first.id, retry.id);
    assert.equal(first.body, retry.body);
    assert.equal(first.routingDecision?.intent, 'engineering_delegation');
    assert.equal(first.agentMention, null);
    assert.deepEqual(first.agentMention, retry.agentMention);
    const conflictingRetry = await postChannelMessage(pool, memberAccess, {
      channelId: channel.channel.id,
      body: '@Alex this retry must not retarget the accepted work.',
      submissionId
    }, mentionDependencies);
    assert.equal(conflictingRetry.id, first.id);
    assert.equal(conflictingRetry.body, request);
    await correctMessageIntent(pool, memberAccess, first.id,
      { intent: 'engineering_delegation' }, mentionDependencies);
    const confirmed = (await loadSharedAgentChannel(pool, memberAccess))
      .messages.find(({ id }) => id === first.id);
    assert.equal(confirmed?.agentMention?.status, 'accepted');
    const confirmedAgentId = confirmed?.agentMention?.status === 'accepted'
      ? confirmed.agentMention.agentId : undefined;

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
      attemptNumber: 1,
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
      id: confirmedAgentId,
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

  test('the pilot verifier observes durable Shared agent channel evidence', async () => {
    const observation = await observePilotJourney(pool);

    assert.equal(observation.workspace.name, 'MVP pilot workspace');
    assert.deepEqual(
      observation.pilotMembers
        .map(({ name, active }) => ({ name, active }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      [
        { name: 'Pilot member', active: true },
        { name: 'Relay Owner', active: true }
      ]
    );
    assert.ok(observation.acceptedMentions >= 1);
    assert.ok(observation.rejectedMentions >= 1);
    assert.equal(observation.duplicateTasks, 0);
    assert.equal(observation.duplicateTerminalEvents, 0);
    assert.equal(observation.duplicateArtifacts, 0);
    assert.equal(observation.artifactResultAnomalies, 0);

    const future = await observePilotJourney(pool, { since: new Date('2999-01-01T00:00:00Z') });
    assert.equal(future.acceptedMentions, 0);
    assert.equal(future.rejectedMentions, 0);
    assert.equal(future.crossMemberCollaborativeRuns, 0);
    assert.equal(future.cancelledRunsWithRequest, 0);
    assert.equal(future.failedRuns, 0);
    assert.equal(future.pausedRecoveries, 0);
    assert.equal(future.pullRequestArtifacts.length, 0);
    assert.equal(future.pilotMembers.every(({ acceptedDelegations }) =>
      acceptedDelegations === 0), true);
  });

  test('either Pilot member can answer one visible clarification while progress stays conversational', async () => {
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
    const channel = await loadSharedAgentChannel(pool, memberAccess);
    const taskBefore = await pool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM public.task WHERE workspace_id = $1',
      [memberAccess.workspace.id]
    );
    const active = await pool.query<{
      run_id: string;
      root_message_id: string;
      agent_id: string;
      agent_member_id: string;
    }>(
      `SELECT run.id AS run_id, COALESCE(source.parent_message_id, source.id) AS root_message_id,
              run.agent_id, agent_member.id AS agent_member_id
       FROM public.agent_run run
       JOIN public.task task ON task.id = run.task_id
       JOIN public.message source ON source.id = task.source_message_id
       JOIN public.workspace_member agent_member ON agent_member.agent_id = run.agent_id
       WHERE run.workspace_id = $1 AND task.request_snapshot = $2`,
      [memberAccess.workspace.id, '@Alex investigate why the app failed to deploy to production.']
    );
    assert.ok(active.rows[0]);
    const clarificationId = randomUUID();
    const requestMessageId = randomUUID();
    const setupClient = await pool.connect();
    await setupClient.query('BEGIN');
    try {
      await setupClient.query(
        `UPDATE public.agent_run
         SET status = 'waiting_for_input', provider_thread_id = 'thread-channel-clarification',
             active_turn_id = 'turn-channel-clarification',
             lease_owner = 'worker-channel-clarification',
             lease_token = 'lease-channel-clarification',
             lease_expires_at = now() + interval '5 minutes', updated_at = now()
         WHERE id = $1`,
        [active.rows[0].run_id]
      );
      await setupClient.query(
        `UPDATE public.agent SET status = 'waiting' WHERE id = $1`,
        [active.rows[0].agent_id]
      );
      await setupClient.query(
        `INSERT INTO public.message (
           id, workspace_id, channel_id, author_workspace_member_id, parent_message_id, body
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          requestMessageId,
          memberAccess.workspace.id,
          channel.channel.id,
          active.rows[0].agent_member_id,
          active.rows[0].root_message_id,
          'Quick clarification: Coverage: should the regression cover a complete web-process restart? Reply in this thread to continue.'
        ]
      );
      await setupClient.query(
        `INSERT INTO public.agent_run_clarification (
           id, workspace_id, agent_run_id, provider_request_id, provider_turn_id,
           provider_item_id, questions, request_message_id
         ) VALUES ($1, $2, $3, 'request-channel-clarification',
           'turn-channel-clarification', 'item-channel-clarification', $4, $5)`,
        [
          clarificationId,
          memberAccess.workspace.id,
          active.rows[0].run_id,
          JSON.stringify([{
            id: 'coverage',
            header: 'Coverage',
            question: 'Should the regression cover a complete web-process restart?',
            options: null
          }]),
          requestMessageId
        ]
      );
      const waitingEvent = await setupClient.query<{ id: number }>(
        `INSERT INTO public.agent_run_event (
           workspace_id, agent_run_id, sequence, event_type, status, summary
         ) VALUES ($1, $2, 2, 'run.clarification_requested', 'waiting_for_input',
           'Waiting for a Pilot member to clarify the request') RETURNING id`,
        [memberAccess.workspace.id, active.rows[0].run_id]
      );
      await setupClient.query(
        `INSERT INTO public.notification_outbox (
           workspace_id, message_id, topic, payload
         ) VALUES ($1, $2, 'channel.message', $3)`,
        [memberAccess.workspace.id, requestMessageId, { messageId: requestMessageId }]
      );
      await setupClient.query(
        `INSERT INTO public.notification_outbox (
           workspace_id, agent_run_event_id, topic, payload
         ) VALUES ($1, $2, 'agent_run.event', $3)`,
        [memberAccess.workspace.id, waitingEvent.rows[0]!.id, {
          agentRunId: active.rows[0].run_id,
          eventType: 'run.clarification_requested',
          sequence: 2
        }]
      );
      await setupClient.query('COMMIT');
    } catch (error) {
      await setupClient.query('ROLLBACK');
      throw error;
    } finally {
      setupClient.release();
    }

    const waitingProjection = await loadChannelReconciliation(
      pool, ownerAccess, channel.channel.id, {}
    );
    assert.equal(
      waitingProjection.runs.find(({ id }) => id === active.rows[0].run_id)?.summary,
      'Waiting for a reply'
    );
    const visibleRequest = waitingProjection.messages.find(({ id }) => id === requestMessageId);
    assert.equal(visibleRequest?.author.kind, 'agent');
    assert.match(visibleRequest?.body ?? '', /complete web-process restart/);

    const progress = await postChannelMessage(pool, ownerAccess, {
      channelId: channel.channel.id,
      body: '@Alex could I get a status update?'
    });
    assert.equal(progress.agentMention, null);
    const afterProgress = await loadSharedAgentChannel(pool, memberAccess);
    const progressResponse = afterProgress.messages.find(
      ({ parentMessageId, author }) => parentMessageId === progress.id && author.kind === 'agent'
    );
    assert.equal(
      progressResponse?.body,
      'Current progress: I am waiting for a Pilot member to answer the clarification in this thread.'
    );
    assert.doesNotMatch(progressResponse?.body ?? '', /thread-channel|turn-channel|sequence|worker/i);

    const repeatedSubmissionId = randomUUID();
    const [memberAnswer, memberRetry, ownerAnswer] = await Promise.all([
      postChannelMessage(pool, memberAccess, {
        channelId: channel.channel.id,
        parentMessageId: active.rows[0].root_message_id,
        body: 'Yes, cover a complete web-process restart.',
        submissionId: repeatedSubmissionId
      }),
      postChannelMessage(pool, memberAccess, {
        channelId: channel.channel.id,
        parentMessageId: active.rows[0].root_message_id,
        body: 'This retry must not replace the original answer.',
        submissionId: repeatedSubmissionId
      }),
      postChannelMessage(pool, ownerAccess, {
        channelId: channel.channel.id,
        parentMessageId: active.rows[0].root_message_id,
        body: '@Alex cover both the dropped wake-up and full restart.'
      })
    ]);
    assert.equal(memberAnswer.id, memberRetry.id);
    assert.equal(memberAnswer.body, memberRetry.body);
    assert.equal(ownerAnswer.agentMention, null);

    const answered = await pool.query<{
      answer_message_id: string;
      answered_by_workspace_member_id: string;
      answers: Record<string, string[]>;
      status: string;
    }>(
      `SELECT answer_message_id, answered_by_workspace_member_id, answers, status
       FROM public.agent_run_clarification WHERE id = $1`,
      [clarificationId]
    );
    assert.equal(answered.rows[0]?.status, 'answered');
    const candidates = new Map([
      [memberAnswer.id, {
        membershipId: memberAccess.membership.id,
        answer: memberAnswer.body
      }],
      [ownerAnswer.id, {
        membershipId: ownerAccess.membership.id,
        answer: ownerAnswer.body
      }]
    ]);
    const winner = candidates.get(answered.rows[0]!.answer_message_id);
    assert.ok(winner);
    assert.equal(answered.rows[0]?.answered_by_workspace_member_id, winner.membershipId);
    assert.deepEqual(answered.rows[0]?.answers, { coverage: [winner.answer] });

    const durable = await pool.query<{
      tasks: number;
      runs: number;
      answered_events: number;
      status: string;
      provider_thread_id: string;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM public.task WHERE workspace_id = $1) AS tasks,
         (SELECT count(*)::integer FROM public.agent_run WHERE id = $2) AS runs,
         (SELECT count(*)::integer FROM public.agent_run_event
          WHERE agent_run_id = $2 AND event_type = 'run.clarification_answered') AS answered_events,
         run.status, run.provider_thread_id
       FROM public.agent_run run WHERE run.id = $2`,
      [memberAccess.workspace.id, active.rows[0].run_id]
    );
    assert.equal(durable.rows[0]?.tasks, taskBefore.rows[0]?.count);
    assert.deepEqual({
      runs: durable.rows[0]?.runs,
      answeredEvents: durable.rows[0]?.answered_events,
      status: durable.rows[0]?.status,
      providerThreadId: durable.rows[0]?.provider_thread_id
    }, {
      runs: 1,
      answeredEvents: 1,
      status: 'working',
      providerThreadId: 'thread-channel-clarification'
    });

    await pool.query(
      `UPDATE public.agent_run
       SET status = 'completed', completed_at = now(), active_turn_id = NULL,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1`,
      [active.rows[0].run_id]
    );
    await pool.query('UPDATE public.agent SET status = \'idle\' WHERE id = $1', [
      active.rows[0].agent_id
    ]);
    const idleProgress = await postChannelMessage(pool, memberAccess, {
      channelId: channel.channel.id,
      body: '@Alex please let me know the progress'
    });
    const idleResponse = (await loadSharedAgentChannel(pool, ownerAccess)).messages.find(
      ({ parentMessageId, author }) => parentMessageId === idleProgress.id && author.kind === 'agent'
    );
    assert.equal(idleResponse?.body, 'Current progress: There is no active engineering request.');
    const taskAfterIdleProgress = await pool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM public.task WHERE workspace_id = $1',
      [memberAccess.workspace.id]
    );
    assert.equal(taskAfterIdleProgress.rows[0]?.count, taskBefore.rows[0]?.count);
  });

  test('Channel Calls use one durable Jitsi room and retain participant history', async () => {
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
    assert.ok(ownerCookie);
    const ownerAccess = await authorizeWorkspaceRequest(
      pool,
      auth,
      new Headers({ cookie: ownerCookie.split(';', 1)[0] })
    );
    const memberAccess = await authorizeWorkspaceRequest(pool, auth, pilotMemberHeaders);
    const channel = await loadSharedAgentChannel(pool, ownerAccess);

    assert.equal(await loadActiveChannelCall(pool, ownerAccess, channel.channel.id), null);
    const started = await startChannelCall(pool, ownerAccess, channel.channel.id);
    assert.match(started.url, /^https:\/\/meet\.jit\.si\/relay-[a-f0-9]{32}$/);
    assert.equal(started.startedBy.name, 'Relay Owner');
    assert.equal(started.participants.length, 1);
    assert.equal(started.canEnd, true);
    assert.equal((await startChannelCall(pool, memberAccess, channel.channel.id)).id, started.id);

    const joined = await joinChannelCall(pool, memberAccess, channel.channel.id);
    assert.equal(joined.id, started.id);
    assert.equal(joined.participants.length, 2);
    assert.equal(joined.canEnd, false);
    await assert.rejects(
      endChannelCall(pool, memberAccess, channel.channel.id),
      /Only the Call starter or a Workspace owner/
    );

    await endChannelCall(pool, ownerAccess, channel.channel.id);
    assert.equal(await loadActiveChannelCall(pool, memberAccess, channel.channel.id), null);
    const history = await pool.query<{
      status: string;
      participant_count: number;
      notification_count: number;
    }>(
      `SELECT call.status,
              count(DISTINCT participant.workspace_member_id)::integer AS participant_count,
              count(DISTINCT outbox.id)::integer AS notification_count
       FROM public.channel_call call
       LEFT JOIN public.channel_call_participant participant ON participant.channel_call_id = call.id
       LEFT JOIN public.notification_outbox outbox ON outbox.channel_call_id = call.id
       WHERE call.id = $1
       GROUP BY call.id`,
      [started.id]
    );
    assert.deepEqual(history.rows[0], {
      status: 'ended',
      participant_count: 2,
      notification_count: 3
    });
  });

  test('Message redaction preserves threads and Workspace selection remains isolated', async () => {
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
    assert.ok(ownerCookie);
    const ownerHeaders = new Headers({ cookie: ownerCookie.split(';', 1)[0] });
    const ownerAccess = await authorizeWorkspaceRequest(pool, auth, ownerHeaders);
    const memberAccess = await authorizeWorkspaceRequest(pool, auth, pilotMemberHeaders);
    const channel = await loadSharedAgentChannel(pool, ownerAccess);
    const root = await postChannelMessage(pool, ownerAccess, {
      channelId: channel.channel.id,
      body: 'A removable root with a durable thread.',
      submissionId: 'deletion-root'
    });
    const reply = await postChannelMessage(pool, memberAccess, {
      channelId: channel.channel.id,
      parentMessageId: root.id,
      body: 'A removable reply.',
      submissionId: 'deletion-reply'
    });

    await assert.rejects(
      deleteChannelMessage(pool, memberAccess, root.id),
      /Only the Message author or a Workspace owner/
    );
    await deleteChannelMessage(pool, memberAccess, reply.id);
    await deleteChannelMessage(pool, ownerAccess, root.id);
    const messageNotifications = await pool.query<{ message_id: string; notifications: number }>(
      `SELECT message_id, count(*)::integer AS notifications
       FROM public.notification_outbox
       WHERE message_id = ANY($1::text[])
       GROUP BY message_id ORDER BY message_id`,
      [[root.id, reply.id]]
    );
    assert.deepEqual(messageNotifications.rows, [root.id, reply.id]
      .sort()
      .map((message_id) => ({ message_id, notifications: 2 })));
    const redacted = await loadSharedAgentChannel(pool, ownerAccess);
    assert.deepEqual(
      redacted.messages
        .filter(({ id }) => id === root.id || id === reply.id)
        .map(({ id, parentMessageId, body, deletedAt }) => ({
          id, parentMessageId, body, deleted: Boolean(deletedAt)
        })),
      [
        { id: root.id, parentMessageId: null, body: 'Message deleted', deleted: true },
        { id: reply.id, parentMessageId: root.id, body: 'Message deleted', deleted: true }
      ]
    );

    const secondWorkspace = await createWorkspace(pool, ownerAccess, { name: 'Second Workspace' });
    assert.equal((await loadAvailableWorkspaces(pool, ownerAccess)).length, 2);
    await assert.rejects(
      renameWorkspace(pool, memberAccess, ownerAccess.workspace.id, { name: 'Not allowed' }),
      /Workspace owner access is required/
    );
    const renamedWorkspace = await renameWorkspace(pool, ownerAccess, secondWorkspace.id, {
      name: 'Renamed Workspace'
    });
    assert.equal(renamedWorkspace.name, 'Renamed Workspace');
    assert.equal(
      (await loadAvailableWorkspaces(pool, ownerAccess)).find(({ id }) => id === secondWorkspace.id)?.name,
      'Renamed Workspace'
    );
    const selectedHeaders = new Headers({
      cookie: `${ownerCookie.split(';', 1)[0]}; relay_workspace_id=${secondWorkspace.id}`
    });
    const selectedAccess = await authorizeWorkspaceRequest(pool, auth, selectedHeaders);
    assert.equal(selectedAccess.workspace.id, secondWorkspace.id);
    assert.equal(selectedAccess.workspace.name, 'Renamed Workspace');
    assert.equal((await loadSharedAgentChannel(pool, selectedAccess)).messages.length, 0);
    await assert.rejects(
      requireAvailableWorkspace(pool, memberAccess, secondWorkspace.id),
      /Active Workspace membership is required/
    );

    const audit = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM public.audit_event
       WHERE subject_id = ANY($1::text[]) ORDER BY id`,
      [[root.id, reply.id, secondWorkspace.id]]
    );
    assert.deepEqual(audit.rows.map(({ event_type }) => event_type), [
      'message.deleted',
      'message.deleted',
      'workspace.created',
      'workspace.renamed'
    ]);
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

    const ticketSecret = 'database-integration-realtime-secret';
    const server = createServer();
    const realtime = attachAuthenticatedRealtime(server, pool, auth, ticketSecret);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const openRealtime = (sessionId: string, cookie: string, origin?: string) => new WebSocket(
      `ws://127.0.0.1:${address.port}/realtime?ticket=${issueRealtimeTicket(sessionId, ticketSecret)}`,
      {
        origin: origin ?? `http://127.0.0.1:${address.port}`,
        headers: { cookie }
      }
    );
    const websocket = openRealtime(
      httpAccess.identity.sessionId,
      sessionCookie.split(';', 1)[0]
    );
    const ready = await new Promise<string>((resolve, reject) => {
      websocket.once('message', (data) => resolve(data.toString()));
      websocket.once('error', reject);
    });
    assert.deepEqual(JSON.parse(ready), { type: 'ready', workspaceId: httpAccess.workspace.id });
    const secondHeaders = new Headers({ cookie: secondSessionCookie.split(';', 1)[0] });
    const secondAccess = await authorizeWorkspaceRequest(pool, auth, secondHeaders);
    const secondWebsocket = openRealtime(
      secondAccess.identity.sessionId,
      secondSessionCookie.split(';', 1)[0]
    );
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
    const pilotAccess = await authorizeWorkspaceRequest(pool, auth, pilotMemberHeaders);
    const memberWebsocket = openRealtime(
      pilotAccess.identity.sessionId,
      pilotMemberHeaders.get('cookie') ?? ''
    );
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

    const typingUpdate = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('typing update was not delivered')), 2_000);
      memberWebsocket.once('message', (data) => {
        clearTimeout(timeout);
        resolve(data.toString());
      });
    });
    websocket.send(JSON.stringify({
      type: 'typing',
      channelId: channel.channel.id,
      active: true
    }));
    assert.deepEqual(JSON.parse(await typingUpdate), {
      type: 'typing',
      channelId: channel.channel.id,
      memberId: channel.viewerWorkspaceMemberId,
      memberName: channel.members.find(({ id }) => id === channel.viewerWorkspaceMemberId)?.name,
      active: true
    });

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

    const crossOrigin = openRealtime(
      httpAccess.identity.sessionId,
      sessionCookie.split(';', 1)[0],
      'https://attacker.example'
    );
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
      `SELECT count(*)::integer AS count
       FROM auth.session
       WHERE id = ANY($1::text[])`,
      [[
        httpAccess.identity.sessionId,
        secondAccess.identity.sessionId,
        pilotAccess.identity.sessionId
      ]]
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
