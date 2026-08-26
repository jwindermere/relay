import type { Pool } from 'pg';

import type { RelayAuth } from '../auth.js';

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

  const result = await pool.query<{
    workspace_id: string;
    workspace_name: string;
    user_id: string;
    role: 'owner' | 'member';
    joined_at: Date;
  }>(
    `SELECT
       w.id AS workspace_id,
       w.name AS workspace_name,
       m.user_id,
       m.role,
       m.joined_at
     FROM public.workspace_membership m
     JOIN public.workspace w ON w.id = m.workspace_id
     WHERE m.user_id = $1 AND m.revoked_at IS NULL
     ORDER BY m.joined_at
     LIMIT 1`,
    [authenticated.user.id]
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
    membership: { userId: row.user_id, role: row.role, joinedAt: row.joined_at }
  };
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
    const target = await client.query<{ role: 'owner' | 'member' }>(
      `SELECT role
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

    const revoked = await client.query<{ user_id: string }>(
      `UPDATE public.workspace_membership
       SET revoked_at = now()
       WHERE workspace_id = $1 AND user_id = $2 AND revoked_at IS NULL
       RETURNING user_id`,
      [actor.workspace.id, targetUserId]
    );
    if (!revoked.rows[0]) throw new WorkspaceAccessError('active Workspace membership was not found');

    await client.query('DELETE FROM auth.session WHERE "userId" = $1', [targetUserId]);
    await client.query(
      `INSERT INTO public.audit_event (
         workspace_id, actor_user_id, event_type, subject_type, subject_id, evidence
       ) VALUES ($1, $2, 'membership.revoked', 'workspace_membership', $3,
         jsonb_build_object('targetUserId', $3::text, 'sessionsRevoked', true))`,
      [actor.workspace.id, actor.identity.userId, targetUserId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
