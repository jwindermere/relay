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
  beginProviderConnectionLogin,
  disableProviderConnection,
  disconnectProviderConnection,
  loadProviderConnection,
  requireReadyProviderConnection,
  type ManagedCodexRuntime,
  type ManagedLoginCompletion
} from '../src/lib/server/provider/connection.js';
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
      { table_schema: 'public', table_name: 'audit_event' },
      { table_schema: 'public', table_name: 'channel' },
      { table_schema: 'public', table_name: 'message' },
      { table_schema: 'public', table_name: 'project' },
      { table_schema: 'public', table_name: 'project_membership' },
      { table_schema: 'public', table_name: 'provider_connection' },
      { table_schema: 'public', table_name: 'runtime_state' },
      { table_schema: 'public', table_name: 'schema_migrations' },
      { table_schema: 'public', table_name: 'workspace' },
      { table_schema: 'public', table_name: 'workspace_invitation' },
      { table_schema: 'public', table_name: 'workspace_member' },
      { table_schema: 'public', table_name: 'workspace_membership' }
    ]);
    await assert.doesNotReject(assertCompatibleSchema(pool));
  });

  test('a runtime rejects an incompatible schema version', async () => {
    await pool.query('UPDATE public.schema_migrations SET version = 99 WHERE version = 5');

    try {
      await assert.rejects(assertCompatibleSchema(pool), (error: unknown) => {
        assert.ok(error instanceof IncompatibleSchemaError);
        assert.match(error.message, /relay schema version 99 is incompatible/);
        assert.deepEqual(error.requiredVersions, REQUIRED_MIGRATION_STREAM_VERSIONS);
        return true;
      });
    } finally {
      await pool.query('UPDATE public.schema_migrations SET version = 5 WHERE version = 99');
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
      headers: { cookie: sessionCookie.split(';', 1)[0] }
    });
    const ready = await new Promise<string>((resolve, reject) => {
      websocket.once('message', (data) => resolve(data.toString()));
      websocket.once('error', reject);
    });
    assert.deepEqual(JSON.parse(ready), { type: 'ready', workspaceId: httpAccess.workspace.id });
    const secondWebsocket = new WebSocket(`ws://127.0.0.1:${address.port}/realtime`, {
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
    secondWebsocket.send('still authorised');
    assert.deepEqual(JSON.parse(await secondAcknowledgement), { type: 'ack' });

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
