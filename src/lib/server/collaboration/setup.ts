import type { PoolClient } from 'pg';

export const pilotCollaborationIds = (workspaceId: string) => ({
  projectId: `${workspaceId}:relay-mvp`,
  channelId: `${workspaceId}:agent-work`,
  agentId: `${workspaceId}:alex`
});

export async function createPilotCollaborationSurface(
  client: PoolClient,
  workspaceId: string,
  ownerMembershipId: string
): Promise<void> {
  const { projectId, channelId, agentId } = pilotCollaborationIds(workspaceId);
  await client.query(
    `INSERT INTO public.project (id, workspace_id, name) VALUES ($1, $2, 'Relay MVP')`,
    [projectId, workspaceId]
  );
  await client.query(
    `INSERT INTO public.agent (id, workspace_id, name, role_label)
     VALUES ($1, $2, 'Alex', 'Engineering agent')`,
    [agentId, workspaceId]
  );
  await client.query(
    `INSERT INTO public.channel (id, workspace_id, project_id, name)
     VALUES ($1, $2, $3, 'agent-work')`,
    [channelId, workspaceId, projectId]
  );
  await client.query(
    `INSERT INTO public.project_membership (workspace_id, project_id, workspace_membership_id)
     VALUES ($1, $2, $3)`,
    [workspaceId, projectId, ownerMembershipId]
  );
  await client.query(
    `INSERT INTO public.project_membership (workspace_id, project_id, agent_id)
     VALUES ($1, $2, $3)`,
    [workspaceId, projectId, agentId]
  );
}

export async function addPilotToCollaborationProject(
  client: PoolClient,
  workspaceId: string,
  membershipId: string
): Promise<void> {
  const { projectId } = pilotCollaborationIds(workspaceId);
  await client.query(
    `INSERT INTO public.project_membership (workspace_id, project_id, workspace_membership_id)
     VALUES ($1, $2, $3)`,
    [workspaceId, projectId, membershipId]
  );
}
