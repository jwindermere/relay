import type { Pool } from 'pg';

import type { WorkspaceAccess } from '../authentication/authorization.js';

export async function hasActivePilotChannelAccess(
  pool: Pool,
  access: WorkspaceAccess,
  channelId: string
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1
     FROM public.channel channel
     JOIN public.project_membership project_member
       ON project_member.project_id = channel.project_id
     JOIN public.workspace_member member
       ON member.id = project_member.workspace_member_id
     JOIN public.workspace_membership pilot
       ON pilot.id = member.pilot_membership_id
     WHERE channel.id = $1
       AND channel.workspace_id = $2
       AND pilot.id = $3
       AND pilot.user_id = $4
       AND pilot.revoked_at IS NULL`,
    [
      channelId,
      access.workspace.id,
      access.membership.id,
      access.identity.userId
    ]
  );
  return Boolean(result.rowCount);
}
