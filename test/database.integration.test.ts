import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import WebSocket from 'ws';

import { createAuthDatabasePool, createRelayAuth } from '../src/lib/server/auth.js';
import {
  authorizeWorkspaceRequest,
  revokeWorkspaceMembership
} from '../src/lib/server/authentication/authorization.js';
import { bootstrapOwner } from '../src/lib/server/authentication/bootstrap.js';
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
  const createTestAuth = () => {
    const authPool = createAuthDatabasePool(connectionString);
    authPools.push(authPool);
    return createRelayAuth({
      pool: authPool,
      baseURL: 'http://relay.test',
      secret: 'test-secret-at-least-thirty-two-characters'
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
      { table_schema: 'public', table_name: 'audit_event' },
      { table_schema: 'public', table_name: 'runtime_state' },
      { table_schema: 'public', table_name: 'schema_migrations' },
      { table_schema: 'public', table_name: 'workspace' },
      { table_schema: 'public', table_name: 'workspace_membership' }
    ]);
    await assert.doesNotReject(assertCompatibleSchema(pool));
  });

  test('a runtime rejects an incompatible schema version', async () => {
    await pool.query('UPDATE public.schema_migrations SET version = 99');

    try {
      await assert.rejects(assertCompatibleSchema(pool), (error: unknown) => {
        assert.ok(error instanceof IncompatibleSchemaError);
        assert.match(error.message, /relay schema version 99 is incompatible/);
        assert.deepEqual(error.requiredVersions, REQUIRED_MIGRATION_STREAM_VERSIONS);
        return true;
      });
    } finally {
      await pool.query('UPDATE public.schema_migrations SET version = 2');
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

    await pool.query(
      `INSERT INTO auth."user" (
         id, name, email, "emailVerified", "createdAt", "updatedAt"
       ) VALUES ('pilot-member', 'Pilot member', 'member@example.com', true, now(), now())`
    );
    await pool.query(
      `INSERT INTO public.workspace_membership (workspace_id, user_id, role)
       VALUES ($1, 'pilot-member', 'member')`,
      [httpAccess.workspace.id]
    );
    await pool.query(
      `INSERT INTO auth.session (
         id, "expiresAt", token, "createdAt", "updatedAt", "userId"
       ) VALUES (
         'pilot-member-session', now() + interval '1 day', 'member-secret-session-token',
         now(), now(), 'pilot-member'
       )`
    );
    await revokeWorkspaceMembership(pool, httpAccess, 'pilot-member');

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
    assert.ok(audit.rows.some(({ event_type }) => event_type === 'authentication.session.revoked'));
    assert.ok(audit.rows.some(({ event_type }) => event_type === 'membership.revoked'));
    assert.doesNotMatch(
      JSON.stringify(audit.rows),
      /correct horse|better-auth\.session_token|member-secret-session-token/i
    );
  });
}
