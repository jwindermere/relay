import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import {
  WorkspaceAccessError,
  type WorkspaceAccess
} from '../authentication/authorization.js';

export type ProviderConnectionState =
  | 'not_connected'
  | 'connecting'
  | 'ready'
  | 'disabled'
  | 'disconnecting';

export interface SafeProviderConnection {
  provider: 'codex';
  state: ProviderConnectionState;
  readyForExecution: boolean;
  canManage: boolean;
}

export interface ManagedLoginCompletion {
  success: boolean;
  authMode?: string;
  error?: string;
}

export interface ManagedCodexRuntime {
  startManagedLogin(input: {
    credentialStoreReference: string;
    loginType: 'chatgptDeviceCode';
    onCompleted: (completion: ManagedLoginCompletion) => Promise<void>;
  }): Promise<{
    loginId: string;
    verificationUrl: string;
    userCode: string;
  }>;
  logout(input: { credentialStoreReference: string }): Promise<void>;
}

export class ProviderConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderConnectionError';
  }
}

interface ProviderConnectionRow {
  id: string;
  credential_store_reference: string;
  status: 'connecting' | 'ready' | 'disabled' | 'disconnecting' | 'disconnected';
}

function safeConnection(
  status: ProviderConnectionRow['status'] | undefined,
  canManage: boolean
): SafeProviderConnection {
  const state = status === 'disconnected' || status === undefined ? 'not_connected' : status;
  return {
    provider: 'codex',
    state,
    readyForExecution: state === 'ready',
    canManage
  };
}

async function assertCurrentOwner(
  client: PoolClient,
  access: WorkspaceAccess
): Promise<void> {
  const current = await client.query<{ role: 'owner' | 'member' }>(
    `SELECT membership.role
     FROM public.workspace_membership membership
     JOIN auth.session session ON session."userId" = membership.user_id
     WHERE membership.workspace_id = $1
       AND membership.id = $2
       AND membership.user_id = $3
       AND membership.revoked_at IS NULL
       AND session.id = $4
       AND session."expiresAt" > now()
     FOR UPDATE OF membership, session`,
    [
      access.workspace.id,
      access.membership.id,
      access.identity.userId,
      access.identity.sessionId
    ]
  );
  if (current.rows[0]?.role !== 'owner') {
    throw new WorkspaceAccessError('current Workspace owner access is required');
  }
}

async function readConnection(
  client: Pick<Pool, 'query'> | PoolClient,
  workspaceId: string
): Promise<ProviderConnectionRow | undefined> {
  const result = await client.query<ProviderConnectionRow>(
    `SELECT id, credential_store_reference, status
     FROM public.provider_connection
     WHERE workspace_id = $1`,
    [workspaceId]
  );
  return result.rows[0];
}

export async function loadProviderConnection(
  pool: Pool,
  access: WorkspaceAccess
): Promise<SafeProviderConnection> {
  const connection = await readConnection(pool, access.workspace.id);
  return safeConnection(connection?.status, access.membership.role === 'owner');
}

export async function requireReadyProviderConnection(
  pool: Pool,
  workspaceId: string
): Promise<{ connectionId: string; credentialStoreReference: string }> {
  const connection = await readConnection(pool, workspaceId);
  if (connection?.status !== 'ready') {
    throw new ProviderConnectionError('a ready Codex Provider connection is required');
  }
  return {
    connectionId: connection.id,
    credentialStoreReference: connection.credential_store_reference
  };
}

async function finishProviderLogin(
  pool: Pool,
  input: {
    workspaceId: string;
    connectionId: string;
    loginAttemptId: string;
    completion: ManagedLoginCompletion;
  }
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const connection = await client.query<{
      owner_membership_id: string;
      status_before_login: 'ready' | 'disabled' | 'disconnected' | null;
    }>(
      `SELECT owner_membership_id, status_before_login
       FROM public.provider_connection
       WHERE id = $1
         AND workspace_id = $2
         AND status = 'connecting'
         AND login_attempt_id = $3
       FOR UPDATE`,
      [input.connectionId, input.workspaceId, input.loginAttemptId]
    );
    const pending = connection.rows[0];
    if (!pending) {
      await client.query('ROLLBACK');
      return;
    }

    const managedChatGptLogin = input.completion.success && input.completion.authMode === 'chatgpt';
    const nextStatus = managedChatGptLogin
      ? 'ready'
      : (pending.status_before_login ?? 'disconnected');
    await client.query(
      `UPDATE public.provider_connection
       SET status = $4,
           status_before_login = NULL,
           login_attempt_id = NULL,
           provider_login_id = CASE WHEN $4 = 'ready' THEN provider_login_id ELSE NULL END,
           connected_at = CASE WHEN $4 = 'ready' THEN now() ELSE connected_at END,
           disconnected_at = CASE WHEN $4 = 'disconnected' THEN now() ELSE disconnected_at END,
           updated_at = now()
       WHERE id = $1 AND workspace_id = $2 AND login_attempt_id = $3`,
      [input.connectionId, input.workspaceId, input.loginAttemptId, nextStatus]
    );
    await client.query(
      `INSERT INTO public.audit_event (
         workspace_id, actor_membership_id, event_type, subject_type, subject_id, evidence
       ) VALUES ($1, $2, $3, 'provider_connection', $4,
         jsonb_build_object('provider', 'codex', 'state', $5::text))`,
      [
        input.workspaceId,
        pending.owner_membership_id,
        managedChatGptLogin ? 'provider.connection.connected' : 'provider.connection.login_failed',
        input.connectionId,
        nextStatus
      ]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function beginProviderConnectionLogin(
  pool: Pool,
  access: WorkspaceAccess,
  runtime: ManagedCodexRuntime
): Promise<{
  connection: SafeProviderConnection;
  login: { verificationUrl: string; userCode: string };
}> {
  const client = await pool.connect();
  const loginAttemptId = randomUUID();
  let connectionId: string = randomUUID();
  let credentialStoreReference = `codex:${connectionId}`;

  try {
    await client.query('BEGIN');
    await assertCurrentOwner(client, access);
    const existing = await readConnection(client, access.workspace.id);
    if (existing) {
      if (existing.status === 'disconnecting') {
        throw new ProviderConnectionError('the Codex Provider connection is disconnecting');
      }
      connectionId = existing.id;
      credentialStoreReference = existing.credential_store_reference;
    }
    await client.query(
      `INSERT INTO public.provider_connection (
         id, workspace_id, owner_membership_id, status, status_before_login,
         credential_store_reference, login_attempt_id
       ) VALUES ($1, $2, $3, 'connecting', 'disconnected', $4, $5)
       ON CONFLICT (workspace_id) DO UPDATE
       SET owner_membership_id = EXCLUDED.owner_membership_id,
           status_before_login = CASE
             WHEN provider_connection.status = 'connecting'
               THEN COALESCE(provider_connection.status_before_login, 'disconnected')
             ELSE provider_connection.status
           END,
           status = 'connecting',
           login_attempt_id = EXCLUDED.login_attempt_id,
           provider_login_id = NULL,
           updated_at = now()`,
      [
        connectionId,
        access.workspace.id,
        access.membership.id,
        credentialStoreReference,
        loginAttemptId
      ]
    );
    await client.query(
      `INSERT INTO public.audit_event (
         workspace_id, actor_user_id, actor_membership_id,
         event_type, subject_type, subject_id, evidence
       ) VALUES ($1, $2, $3, 'provider.connection.login_started',
         'provider_connection', $4, jsonb_build_object('provider', 'codex'))`,
      [access.workspace.id, access.identity.userId, access.membership.id, connectionId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  let started;
  try {
    started = await runtime.startManagedLogin({
      credentialStoreReference,
      loginType: 'chatgptDeviceCode',
      onCompleted: (completion) => finishProviderLogin(pool, {
        workspaceId: access.workspace.id,
        connectionId,
        loginAttemptId,
        completion
      })
    });
  } catch (error) {
    await finishProviderLogin(pool, {
      workspaceId: access.workspace.id,
      connectionId,
      loginAttemptId,
      completion: { success: false, error: 'managed login could not start' }
    });
    throw new ProviderConnectionError('managed Codex login could not be started');
  }

  const recorded = await pool.query(
    `UPDATE public.provider_connection
     SET provider_login_id = $4, updated_at = now()
     WHERE id = $1 AND workspace_id = $2 AND login_attempt_id = $3`,
    [connectionId, access.workspace.id, loginAttemptId, started.loginId]
  );
  if (recorded.rowCount !== 1) {
    throw new ProviderConnectionError('managed Codex login is no longer current');
  }

  return {
    connection: safeConnection('connecting', true),
    login: {
      verificationUrl: started.verificationUrl,
      userCode: started.userCode
    }
  };
}

export async function disableProviderConnection(
  pool: Pool,
  access: WorkspaceAccess
): Promise<SafeProviderConnection> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertCurrentOwner(client, access);
    const disabled = await client.query<{ id: string }>(
      `UPDATE public.provider_connection
       SET status = 'disabled', status_before_login = NULL,
           login_attempt_id = NULL, provider_login_id = NULL, updated_at = now()
       WHERE workspace_id = $1 AND status IN ('connecting', 'ready')
       RETURNING id`,
      [access.workspace.id]
    );
    const row = disabled.rows[0];
    if (!row) throw new ProviderConnectionError('a connected Codex Provider connection is required');
    await client.query(
      `INSERT INTO public.audit_event (
         workspace_id, actor_user_id, actor_membership_id,
         event_type, subject_type, subject_id, evidence
       ) VALUES ($1, $2, $3, 'provider.connection.disabled',
         'provider_connection', $4, jsonb_build_object('provider', 'codex'))`,
      [access.workspace.id, access.identity.userId, access.membership.id, row.id]
    );
    await client.query('COMMIT');
    return safeConnection('disabled', true);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function disconnectProviderConnection(
  pool: Pool,
  access: WorkspaceAccess,
  runtime: ManagedCodexRuntime
): Promise<SafeProviderConnection> {
  const client = await pool.connect();
  let connection: ProviderConnectionRow | undefined;
  try {
    await client.query('BEGIN');
    await assertCurrentOwner(client, access);
    connection = await readConnection(client, access.workspace.id);
    if (!connection || connection.status === 'disconnected') {
      throw new ProviderConnectionError('a Codex Provider connection is required');
    }
    if (connection.status !== 'disconnecting') {
      await client.query(
        `UPDATE public.provider_connection
         SET status = 'disconnecting', status_before_login = NULL,
             login_attempt_id = NULL, updated_at = now()
         WHERE id = $1`,
        [connection.id]
      );
      await client.query(
        `INSERT INTO public.audit_event (
           workspace_id, actor_user_id, actor_membership_id,
           event_type, subject_type, subject_id, evidence
         ) VALUES ($1, $2, $3, 'provider.connection.disconnect_started',
           'provider_connection', $4, jsonb_build_object('provider', 'codex'))`,
        [access.workspace.id, access.identity.userId, access.membership.id, connection.id]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  try {
    await runtime.logout({ credentialStoreReference: connection.credential_store_reference });
  } catch {
    await pool.query(
      `WITH restored AS (
         UPDATE public.provider_connection
         SET status = 'disabled', updated_at = now()
         WHERE id = $1 AND workspace_id = $2 AND status = 'disconnecting'
         RETURNING owner_membership_id
       )
       INSERT INTO public.audit_event (
         workspace_id, actor_membership_id, event_type, subject_type, subject_id, evidence
       )
       SELECT $2, owner_membership_id, 'provider.connection.disconnect_failed',
         'provider_connection', $1, jsonb_build_object('provider', 'codex')
       FROM restored`,
      [connection.id, access.workspace.id]
    );
    throw new ProviderConnectionError(
      'local Codex logout failed; the Provider connection remains disabled and can be retried'
    );
  }
  await pool.query(
    `WITH disconnected AS (
       UPDATE public.provider_connection
       SET status = 'disconnected', provider_login_id = NULL,
           disconnected_at = now(), updated_at = now()
       WHERE id = $1 AND workspace_id = $2 AND status = 'disconnecting'
       RETURNING owner_membership_id
     )
     INSERT INTO public.audit_event (
       workspace_id, actor_membership_id, event_type, subject_type, subject_id, evidence
     )
     SELECT $2, owner_membership_id, 'provider.connection.disconnected',
       'provider_connection', $1, jsonb_build_object('provider', 'codex')
     FROM disconnected`,
    [connection.id, access.workspace.id]
  );
  return safeConnection('disconnected', true);
}
