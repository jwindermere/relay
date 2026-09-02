import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

export interface SteeringContext {
  messageId: string;
  workspaceId: string;
  channelId: string;
  parentMessageId: string | null;
  body: string;
}

export function parseGuidanceInput(context: SteeringContext): string | null {
  if (!context.parentMessageId) return null;
  return context.body.match(/^\s*(?:steer|guidance|constraint)\s*:\s*(.+)$/isu)?.[1]?.trim() || null;
}

export async function acceptAgentRunSteering(
  client: PoolClient,
  context: SteeringContext,
  suppliedGuidance?: string
): Promise<boolean> {
  const guidance = suppliedGuidance ?? parseGuidanceInput(context);
  if (!guidance) return false;
  const run = await client.query<{
    id: string; workspace_id: string; project_id: string; member_id: string; status: string;
  }>(
    `SELECT run.id, run.workspace_id, task.project_id, author.id AS member_id, run.status
     FROM public.message steering_message
     JOIN public.workspace_member author
       ON author.id = steering_message.author_workspace_member_id
      AND author.workspace_id = steering_message.workspace_id
     JOIN public.workspace_membership membership
       ON membership.id = author.pilot_membership_id AND membership.revoked_at IS NULL
     JOIN public.message source
       ON source.channel_id = steering_message.channel_id
      AND COALESCE(source.parent_message_id, source.id) = $4
     JOIN public.task task ON task.source_message_id = source.id
     JOIN public.agent_run run ON run.task_id = task.id
     WHERE steering_message.id = $1 AND steering_message.workspace_id = $2
       AND steering_message.channel_id = $3
       AND run.status IN ('queued', 'planning', 'working', 'waiting_for_input', 'waiting_for_approval', 'recovering', 'paused')
     ORDER BY run.attempt_number DESC LIMIT 1 FOR UPDATE OF run`,
    [context.messageId, context.workspaceId, context.channelId, context.parentMessageId]
  );
  const active = run.rows[0];
  if (!active) return false;
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [active.id]);
  const inserted = await client.query(
    `INSERT INTO public.agent_run_steering (
       id, workspace_id, project_id, agent_run_id, source_message_id,
       supplied_by_workspace_member_id, guidance, ordinal
     ) VALUES ($1, $2, $3, $4, $5, $6, $7,
       COALESCE((SELECT max(ordinal) + 1 FROM public.agent_run_steering WHERE agent_run_id = $4), 1))
     ON CONFLICT (source_message_id) DO NOTHING`,
    [randomUUID(), context.workspaceId, active.project_id, active.id,
      context.messageId, active.member_id, guidance]
  );
  return inserted.rowCount === 1;
}
