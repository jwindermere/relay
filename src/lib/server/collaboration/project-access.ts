import type { Pool, PoolClient } from 'pg';

import {
  type WorkspaceAccess,
  WorkspaceAccessError
} from '../authentication/authorization.js';

export interface ActivePilotProject {
  id: string;
  name: string;
}

export async function loadActivePilotProjects(
  pool: Pool,
  access: WorkspaceAccess
): Promise<ActivePilotProject[]> {
  const projects = await pool.query<ActivePilotProject>(
    `SELECT project.id, project.name
     FROM public.project project
     JOIN public.project_membership project_member
       ON project_member.workspace_id = project.workspace_id
      AND project_member.project_id = project.id
     JOIN public.workspace_member member
       ON member.workspace_id = project.workspace_id
      AND member.id = project_member.workspace_member_id
     JOIN public.workspace_membership membership
       ON membership.workspace_id = member.workspace_id
      AND membership.id = member.pilot_membership_id
     WHERE project.workspace_id = $1
       AND membership.id = $2
       AND membership.user_id = $3
       AND membership.revoked_at IS NULL
     ORDER BY project.created_at, project.id`,
    [access.workspace.id, access.membership.id, access.identity.userId]
  );
  return projects.rows;
}

export async function requireActivePilotProjectMembership(
  client: Pool | PoolClient,
  access: WorkspaceAccess,
  projectId: string,
  lock = false
): Promise<void> {
  const projectAccess = await client.query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM public.project project
       JOIN public.project_membership project_member
         ON project_member.workspace_id = project.workspace_id
        AND project_member.project_id = project.id
       JOIN public.workspace_member member
         ON member.workspace_id = project.workspace_id
        AND member.id = project_member.workspace_member_id
       JOIN public.workspace_membership membership
         ON membership.workspace_id = member.workspace_id
        AND membership.id = member.pilot_membership_id
       WHERE project.workspace_id = $1
         AND membership.id = $2
         AND project.id = $3
         AND membership.user_id = $4
         AND membership.revoked_at IS NULL
       ${lock ? 'FOR SHARE OF project, project_member, member, membership' : ''}
     ) AS allowed`,
    [access.workspace.id, access.membership.id, projectId, access.identity.userId]
  );
  if (!projectAccess.rows[0]?.allowed) {
    throw new WorkspaceAccessError('active Project membership is required');
  }
}
