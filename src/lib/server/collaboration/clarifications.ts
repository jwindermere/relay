import type { PoolClient } from 'pg';

import type { AgentRunStatus } from '../provider/agent-run.js';
import { appendAgentRunEvent } from '../provider/agent-run-events.js';

interface WaitingAgentRunReplyContext {
  messageId: string;
  workspaceId: string;
  channelId: string;
  parentMessageId: string;
  body: string;
}

interface ThreadClarification {
  id: string;
  agent_run_id: string;
  run_status: AgentRunStatus;
  questions: Array<{ id: string }>;
  author_workspace_member_id: string;
  has_live_lease: boolean;
}

export async function handleWaitingAgentRunReply(
  client: PoolClient,
  context: WaitingAgentRunReplyContext
): Promise<boolean> {
  const clarification = await findThreadClarification(client, context);
  if (!clarification) return false;
  const answers = Object.fromEntries(
    clarification.questions.map(({ id }) => [id, [context.body]])
  );
  const answered = await client.query(
    `UPDATE public.agent_run_clarification
     SET status = 'answered', answers = $2, answer_message_id = $3,
         answered_by_workspace_member_id = $4, answered_at = now()
     WHERE id = $1 AND status = 'pending'`,
    [
      clarification.id,
      JSON.stringify(answers),
      context.messageId,
      clarification.author_workspace_member_id
    ]
  );
  if (answered.rowCount !== 1) return true;

  const nextStatus: AgentRunStatus = clarification.run_status === 'recovering'
    ? 'recovering'
    : clarification.has_live_lease ? 'working' : 'queued';
  await appendAgentRunEvent(client, {
    id: clarification.agent_run_id,
    workspaceId: context.workspaceId
  }, {
    eventType: 'run.clarification_answered',
    status: nextStatus,
    summary: 'Clarification received; continuing the request',
    evidence: { clarificationId: clarification.id, answerMessageId: context.messageId },
    clearActiveTurn: nextStatus === 'queued',
    releaseLease: nextStatus === 'queued'
  });
  return true;
}

async function findThreadClarification(
  client: PoolClient,
  context: WaitingAgentRunReplyContext
): Promise<ThreadClarification | undefined> {
  const result = await client.query<ThreadClarification>(
    `SELECT clarification.id, run.id AS agent_run_id,
            run.status AS run_status, clarification.questions,
            reply.author_workspace_member_id,
            (run.lease_owner IS NOT NULL AND run.lease_expires_at > now()) AS has_live_lease
     FROM public.agent_run_clarification clarification
     JOIN public.agent_run run ON run.id = clarification.agent_run_id
     JOIN public.task task ON task.id = run.task_id
     JOIN public.message source ON source.id = task.source_message_id
     JOIN public.message request ON request.id = clarification.request_message_id
     JOIN public.message reply ON reply.id = $1
     WHERE clarification.workspace_id = $2
       AND source.channel_id = $3
       AND COALESCE(source.parent_message_id, source.id) = $4
       AND (reply.created_at, reply.id) > (request.created_at, request.id)
       AND (clarification.status = 'pending'
         OR run.status NOT IN ('completed', 'failed', 'cancelled'))
     ORDER BY (clarification.status = 'pending') DESC,
              clarification.created_at DESC, clarification.id DESC
     LIMIT 1
     FOR UPDATE OF clarification, run`,
    [context.messageId, context.workspaceId, context.channelId, context.parentMessageId]
  );
  return result.rows[0];
}
