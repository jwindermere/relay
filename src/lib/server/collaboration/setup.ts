import type { PoolClient } from 'pg';

export const pilotCollaborationIds = (workspaceId: string) => ({
  projectId: `${workspaceId}:relay-mvp`,
  channelId: `${workspaceId}:agent-work`,
  agentId: `${workspaceId}:alex`,
  agentIds: {
    engineering: `${workspaceId}:alex`,
    product: `${workspaceId}:maya`,
    research: `${workspaceId}:riley`
  }
});

export async function createPilotCollaborationSurface(
  client: PoolClient,
  workspaceId: string,
  ownerMembershipId: string
): Promise<void> {
  const { projectId, channelId, agentIds } = pilotCollaborationIds(workspaceId);
  await client.query(
    `INSERT INTO public.project (id, workspace_id, name) VALUES ($1, $2, 'Relay MVP')`,
    [projectId, workspaceId]
  );
  await client.query(
    `INSERT INTO public.agent (
       id, workspace_id, name, agent_type, role_label, instructions, ambient_triggers
     ) VALUES
       ($1, $4, 'Alex', 'engineering', 'Engineering agent',
        'Own software delivery, code investigation, testing, and reviewable repository changes.',
        ARRAY['code', 'engineering', 'repository', 'github', 'bug', 'test']),
       ($2, $4, 'Maya', 'product', 'Product manager',
        'Clarify outcomes, priorities, requirements, trade-offs, and coordinate specialist input.',
        ARRAY['product', 'priority', 'roadmap', 'requirement', 'customer', 'coordination']),
       ($3, $4, 'Riley', 'research', 'Research agent',
        'Investigate questions, assess evidence and sources, and return concise findings.',
        ARRAY['research', 'evidence', 'source', 'market', 'competitor', 'investigate'])`,
    [agentIds.engineering, agentIds.product, agentIds.research, workspaceId]
  );
  await client.query(
    `INSERT INTO public.channel (id, workspace_id, project_id, name)
     VALUES ($1, $2, $3, 'agent-work')`,
    [channelId, workspaceId, projectId]
  );
  await client.query(
    `INSERT INTO public.workspace_member (id, workspace_id, kind, pilot_membership_id)
     VALUES ($1, $2, 'pilot', $1)`,
    [ownerMembershipId, workspaceId]
  );
  await client.query(
    `INSERT INTO public.workspace_member (id, workspace_id, kind, agent_id)
     SELECT agent.id || ':member', agent.workspace_id, 'agent', agent.id
     FROM public.agent agent
     WHERE agent.id = ANY($1::text[])`,
    [[agentIds.engineering, agentIds.product, agentIds.research]]
  );
  await client.query(
    `INSERT INTO public.project_membership (workspace_id, project_id, workspace_member_id)
     VALUES ($1, $2, $3)`,
    [workspaceId, projectId, ownerMembershipId]
  );
  await client.query(
    `INSERT INTO public.project_membership (workspace_id, project_id, workspace_member_id)
     SELECT $1, $2, member.id
     FROM public.workspace_member member
     WHERE member.agent_id = ANY($3::text[])`,
    [workspaceId, projectId, [agentIds.engineering, agentIds.product, agentIds.research]]
  );
}

export async function addPilotToCollaborationProject(
  client: PoolClient,
  workspaceId: string,
  membershipId: string
): Promise<void> {
  const { projectId } = pilotCollaborationIds(workspaceId);
  await client.query(
    `WITH member AS (
       INSERT INTO public.workspace_member (id, workspace_id, kind, pilot_membership_id)
       VALUES ($3, $1, 'pilot', $3)
       RETURNING id
     )
     INSERT INTO public.project_membership (workspace_id, project_id, workspace_member_id)
     SELECT $1, $2, id FROM member`,
    [workspaceId, projectId, membershipId]
  );
}
