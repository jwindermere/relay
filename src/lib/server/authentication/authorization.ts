import type { Pool, PoolClient } from 'pg';

import type { RelayAuth } from '../auth.js';
import { publishAccessRevoked } from './access-revocation.js';

export const ACTIVE_WORKSPACE_COOKIE = 'relay_workspace_id';

export interface WorkspaceAccess {
  identity: {
    userId: string;
    email: string;
    sessionId: string;
  };
  workspace: {
    id: string;
    name: string;
  };
  membership: {
    id: string;
    userId: string;
    role: 'owner' | 'member';
    joinedAt: Date;
  };
}

export class WorkspaceAccessError extends Error {
  constructor(message = 'authenticated active Workspace membership is required') {
    super(message);
    this.name = 'WorkspaceAccessError';
  }
}

export async function assertCurrentWorkspaceOwner(
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

export async function authorizeWorkspaceRequest(
  pool: Pool,
  auth: RelayAuth,
  headers: Headers
): Promise<WorkspaceAccess> {
  const authenticated = await auth.api.getSession({
    headers,
    query: { disableCookieCache: true }
  });
  if (!authenticated?.user.emailVerified) throw new WorkspaceAccessError();

  const selectedWorkspaceId = readCookie(headers, ACTIVE_WORKSPACE_COOKIE);

  const result = await pool.query<{
    membership_id: string;
    workspace_id: string;
    workspace_name: string;
    user_id: string;
    role: 'owner' | 'member';
    joined_at: Date;
  }>(
    `SELECT
       m.id AS membership_id,
       w.id AS workspace_id,
       w.name AS workspace_name,
       m.user_id,
       m.role,
       m.joined_at
     FROM public.workspace_membership m
     JOIN public.workspace w ON w.id = m.workspace_id
     WHERE m.user_id = $1 AND m.revoked_at IS NULL
     ORDER BY (m.workspace_id = $2) DESC, m.joined_at, m.workspace_id
     LIMIT 1`,
    [authenticated.user.id, selectedWorkspaceId]
  );
  const row = result.rows[0];
  if (!row) throw new WorkspaceAccessError();

  return {
    identity: {
      userId: authenticated.user.id,
      email: authenticated.user.email,
      sessionId: authenticated.session.id
    },
    workspace: { id: row.workspace_id, name: row.workspace_name },
    membership: {
      id: row.membership_id,
      userId: row.user_id,
      role: row.role,
      joinedAt: row.joined_at
    }
  };
}

function readCookie(headers: Headers, name: string): string | null {
  const cookie = headers.get('cookie');
  if (!cookie) return null;
  for (const entry of cookie.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0 || entry.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(entry.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export async function revokeWorkspaceMembership(
  pool: Pool,
  actor: WorkspaceAccess,
  targetUserId: string
): Promise<void> {
  if (actor.membership.role !== 'owner') throw new WorkspaceAccessError('Workspace owner access is required');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const currentActor = await client.query<{ role: 'owner' | 'member' }>(
      `SELECT m.role
       FROM public.workspace_membership m
       JOIN auth.session s ON s."userId" = m.user_id
       WHERE m.workspace_id = $1
         AND m.user_id = $2
         AND m.revoked_at IS NULL
         AND s.id = $3
         AND s."expiresAt" > now()
       FOR UPDATE OF m, s`,
      [actor.workspace.id, actor.identity.userId, actor.identity.sessionId]
    );
    if (currentActor.rows[0]?.role !== 'owner') {
      throw new WorkspaceAccessError('current Workspace owner access is required');
    }

    const target = await client.query<{ id: string; role: 'owner' | 'member' }>(
      `SELECT id, role
       FROM public.workspace_membership
       WHERE workspace_id = $1 AND user_id = $2 AND revoked_at IS NULL
       FOR UPDATE`,
      [actor.workspace.id, targetUserId]
    );
    if (!target.rows[0]) throw new WorkspaceAccessError('active Workspace membership was not found');
    if (target.rows[0].role === 'owner') {
      const owners = await client.query<{ count: number }>(
        `SELECT count(*)::integer AS count
         FROM public.workspace_membership
         WHERE workspace_id = $1 AND role = 'owner' AND revoked_at IS NULL`,
        [actor.workspace.id]
      );
      if (owners.rows[0]?.count === 1) {
        throw new WorkspaceAccessError('the last active Workspace owner cannot be revoked');
      }
    }

    const revoked = await client.query<{ id: string; user_id: string }>(
      `UPDATE public.workspace_membership
       SET revoked_at = now()
       WHERE workspace_id = $1 AND user_id = $2 AND revoked_at IS NULL
       RETURNING id, user_id`,
      [actor.workspace.id, targetUserId]
    );
    if (!revoked.rows[0]) throw new WorkspaceAccessError('active Workspace membership was not found');

    await client.query(
      `INSERT INTO public.audit_event (
         workspace_id, actor_user_id, actor_membership_id,
         event_type, subject_type, subject_id, evidence
       ) VALUES ($1, $2, $3, 'membership.revoked', 'workspace_membership', $4,
         jsonb_build_object('targetUserId', $5::text))`,
      [
        actor.workspace.id,
        actor.identity.userId,
        actor.membership.id,
        revoked.rows[0].id,
        targetUserId
      ]
    );
    await publishAccessRevoked(client, {
      kind: 'membership',
      membershipId: revoked.rows[0].id
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
