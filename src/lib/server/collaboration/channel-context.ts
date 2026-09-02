import type { Pool, PoolClient } from 'pg';

export interface SuppliedChannelContextMessage {
  author_name: string;
  body: string;
}

export async function loadChannelContextBeforeMessage(
  database: Pool | PoolClient,
  messageId: string,
  workspaceId: string
): Promise<SuppliedChannelContextMessage[]> {
  const context = await database.query<SuppliedChannelContextMessage>(
    `SELECT memory.author_name, memory.body
     FROM (
       SELECT COALESCE(pilot_user.name, context_agent.name) AS author_name,
              message.body, message.created_at, message.id
       FROM public.message request
       JOIN public.message message ON message.channel_id = request.channel_id
         AND message.workspace_id = request.workspace_id
         AND (message.created_at, message.id) < (request.created_at, request.id)
       JOIN public.workspace_member author ON author.id = message.author_workspace_member_id
       LEFT JOIN public.workspace_membership pilot ON pilot.id = author.pilot_membership_id
       LEFT JOIN auth."user" pilot_user ON pilot_user.id = pilot.user_id
       LEFT JOIN public.agent context_agent ON context_agent.id = author.agent_id
       WHERE request.id = $1 AND request.workspace_id = $2
       ORDER BY message.created_at DESC, message.id DESC
       LIMIT 30
     ) memory
     ORDER BY memory.created_at, memory.id`,
    [messageId, workspaceId]
  );
  return context.rows;
}
