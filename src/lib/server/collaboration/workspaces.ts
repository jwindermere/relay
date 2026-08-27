import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import type { WorkspaceAccess } from '../authentication/authorization.js';
import { WorkspaceAccessError } from '../authentication/authorization.js';
import { createPilotCollaborationSurface } from './setup.js';

export interface AvailableWorkspace {
  id: string;
  name: string;
  role: 'owner' | 'member';
}

export class WorkspaceConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceConfigurationError';
  }
}

export async function loadAvailableWorkspaces(
  pool: Pool,
  access: WorkspaceAccess
): Promise<AvailableWorkspace[]> {
  const result = await pool.query<AvailableWorkspace>(
    `SELECT workspace.id, workspace.name, membership.role
     FROM public.workspace_membership membership
     JOIN public.workspace workspace ON workspace.id = membership.workspace_id
     WHERE membership.user_id = $1 AND membership.revoked_at IS NULL
     ORDER BY membership.joined_at, workspace.id`,
    [access.identity.userId]
  );
  return result.rows;
}

export async function createWorkspace(
  pool: Pool,
  access: WorkspaceAccess,
  input: { name: string }
): Promise<AvailableWorkspace> {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 120) {
    throw new WorkspaceConfigurationError('Workspace name must contain 1 to 120 characters');
  }
  const workspaceId = randomUUID();
  const membershipId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const identity = await client.query(
      `SELECT 1 FROM public.workspace_membership
       WHERE id = $1 AND workspace_id = $2 AND user_id = $3 AND revoked_at IS NULL
       FOR SHARE`,
      [access.membership.id, access.workspace.id, access.identity.userId]
    );
    if (!identity.rows[0]) throw new WorkspaceAccessError();
    await client.query('INSERT INTO public.workspace (id, name) VALUES ($1, $2)', [
      workspaceId,
      name
    ]);
    await client.query(
      `INSERT INTO public.workspace_membership (id, workspace_id, user_id, role)
       VALUES ($1, $2, $3, 'owner')`,
      [membershipId, workspaceId, access.identity.userId]
    );
    await createPilotCollaborationSurface(client, workspaceId, membershipId);
    await client.query(
      `INSERT INTO public.audit_event (
         workspace_id, actor_user_id, actor_membership_id,
         event_type, subject_type, subject_id, evidence
       ) VALUES ($1, $2, $3, 'workspace.created', 'workspace', $1,
         jsonb_build_object('sourceWorkspaceId', $4::text))`,
      [workspaceId, access.identity.userId, membershipId, access.workspace.id]
    );
    await client.query('COMMIT');
    return { id: workspaceId, name, role: 'owner' };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function renameWorkspace(
  pool: Pool,
  access: WorkspaceAccess,
  workspaceId: string,
  input: { name: string }
): Promise<AvailableWorkspace> {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 120) {
    throw new WorkspaceConfigurationError('Workspace name must contain 1 to 120 characters');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{ id: string; name: string; membership_id: string }>(
      `SELECT workspace.id, workspace.name, membership.id AS membership_id
       FROM public.workspace_membership membership
       JOIN public.workspace workspace ON workspace.id = membership.workspace_id
       WHERE membership.workspace_id = $1
         AND membership.user_id = $2
         AND membership.role = 'owner'
         AND membership.revoked_at IS NULL
       FOR UPDATE OF workspace, membership`,
      [workspaceId, access.identity.userId]
    );
    const workspace = current.rows[0];
    if (!workspace) throw new WorkspaceAccessError('Workspace owner access is required');
    if (workspace.name !== name) {
      await client.query(
        'UPDATE public.workspace SET name = $1, updated_at = now() WHERE id = $2',
        [name, workspaceId]
      );
      await client.query(
        `INSERT INTO public.audit_event (
           workspace_id, actor_user_id, actor_membership_id,
           event_type, subject_type, subject_id, evidence
         ) VALUES ($1, $2, $3, 'workspace.renamed', 'workspace', $1,
           jsonb_build_object('previousName', $4::text, 'name', $5::text))`,
        [workspaceId, access.identity.userId, workspace.membership_id, workspace.name, name]
      );
    }
    await client.query('COMMIT');
    return { id: workspaceId, name, role: 'owner' };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function requireAvailableWorkspace(
  pool: Pool,
  access: WorkspaceAccess,
  workspaceId: string
): Promise<void> {
  const available = await pool.query(
    `SELECT 1 FROM public.workspace_membership
     WHERE workspace_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [workspaceId, access.identity.userId]
  );
  if (!available.rows[0]) throw new WorkspaceAccessError('Active Workspace membership is required');
}
