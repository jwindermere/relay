import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import type { AgentRunStatus } from '../provider/agent-run.js';
import { explicitAgentMentionPattern } from './delegation.js';

interface ProgressMessageContext {
  messageId: string;
  workspaceId: string;
  channelId: string;
  parentMessageId: string | null;
  body: string;
}

export async function answerAgentProgressRequest(
  client: PoolClient,
  context: ProgressMessageContext
): Promise<boolean> {
  const agents = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM public.agent WHERE workspace_id = $1 ORDER BY length(name) DESC, id`,
    [context.workspaceId]
  );
  const agent = agents.rows.find(({ name }) => explicitAgentMentionPattern(name).test(context.body));
  if (!agent || !isProgressRequest(context.body, agent.name)) return false;

  const agentMember = await client.query<{ id: string }>(
    `SELECT id FROM public.workspace_member
     WHERE workspace_id = $1 AND agent_id = $2`,
    [context.workspaceId, agent.id]
  );
  if (!agentMember.rows[0]) return false;

  const active = await client.query<{ id: string; status: AgentRunStatus }>(
    `SELECT run.id, run.status
     FROM public.agent_run run
     JOIN public.task task ON task.id = run.task_id
     JOIN public.message source ON source.id = task.source_message_id
     WHERE run.workspace_id = $1
       AND run.agent_id = $2
       AND source.channel_id = $3
       AND run.status NOT IN ('completed', 'failed', 'cancelled')
     ORDER BY run.updated_at DESC, run.id
     LIMIT 1
     FOR UPDATE OF run`,
    [context.workspaceId, agent.id, context.channelId]
  );

  const responseMessageId = randomUUID();
  await client.query(
    `INSERT INTO public.message (
       id, workspace_id, channel_id, author_workspace_member_id, parent_message_id, body
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      responseMessageId,
      context.workspaceId,
      context.channelId,
      agentMember.rows[0].id,
      context.parentMessageId ?? context.messageId,
      visibleProgressResponse(active.rows[0]?.status)
    ]
  );
  await client.query(
    `INSERT INTO public.notification_outbox (
       workspace_id, message_id, topic, payload
     ) VALUES ($1, $2, 'channel.message', $3)`,
    [context.workspaceId, responseMessageId, { messageId: responseMessageId }]
  );
  return true;
}

function isProgressRequest(body: string, agentName: string): boolean {
  const request = body
    .replace(explicitAgentMentionPattern(agentName), ' ')
    .trim()
    .replace(/^[\s,.:;!?-]+/u, '')
    .replace(/^(?:(?:hey|hi)\s*[,!]?\s+)?/iu, '')
    .replace(/^(?:please\s+|(?:can|could|would|will)\s+you\s+|could\s+i\s+get\s+|please\s+let\s+me\s+know\s+|let\s+me\s+know\s+|(?:give|send|show|tell)\s+me\s+)+/iu, '')
    .trim();
  if (/^(?:implement|build|create|fix|change|refactor|add|remove|test|debug|investigate|document)\b/iu.test(request)) {
    return false;
  }
  return /^(?:(?:any|a|an|the|current|quick|our|your)\s+)*(?:progress|status)(?:\s+(?:update|report))?[?.!\s]*$/iu.test(request)
    || /^(?:what(?:'s|\s+is)\s+(?:the\s+)?(?:progress|status)|how(?:'s|\s+is)\s+(?:it|the\s+(?:work|task)|that|this)|where\s+are\s+we)(?:\s+(?:going|up\s+to))?[?.!\s]*$/iu.test(request);
}

function visibleProgressResponse(status: AgentRunStatus | undefined): string {
  const summaries: Record<AgentRunStatus | 'idle', string> = {
    queued: 'The engineering request is queued.',
    planning: 'I am planning the engineering request.',
    working: 'I am working on the engineering request.',
    waiting_for_input: 'I am waiting for a Pilot member to answer the clarification in this thread.',
    waiting_for_approval: 'I am waiting for approval before continuing.',
    recovering: 'I am reconnecting to the existing work.',
    paused: 'The engineering request needs review before it can continue.',
    completed: 'The engineering request is complete.',
    failed: 'The engineering request failed.',
    cancelled: 'The engineering request was cancelled.',
    idle: 'There is no active engineering request.'
  };
  return `Current progress: ${summaries[status ?? 'idle']}`;
}
