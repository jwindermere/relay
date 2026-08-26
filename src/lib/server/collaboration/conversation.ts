import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import type { AgentMentionResult } from './delegation.js';
import { explicitAgentMentionPattern } from './delegation.js';

interface ConversationContext {
  messageId: string;
  workspaceId: string;
  channelId: string;
  parentMessageId: string | null;
  body: string;
}

interface AgentCandidate {
  id: string;
  name: string;
  enabled: boolean;
  status: 'idle' | 'working' | 'waiting' | 'disabled';
}

export function isConcreteEngineeringRequest(body: string, agentName: string): boolean {
  const request = body
    .replace(explicitAgentMentionPattern(agentName), ' ')
    .trim()
    .replace(/^[\s,.:;!?-]+/u, '')
    .replace(
      /^(?:(?:hey|hi)\s+)?(?:(?:please|kindly)\s+|(?:can|could|would|will)\s+you\s+|i\s+(?:need|want)\s+you\s+to\s+|go\s+ahead\s+and\s+)*/iu,
      ''
    )
    .trim();
  return /^(?:implement|build|create|fix|change|refactor|add|remove|test|debug|investigate|inspect|document|update|write|rename|repair|cover|prove|deploy|merge|administer|destroy|truncate|delete|wipe|erase|purge|push|publish|release|force[- ]?push|git\s+)\s*\S+/iu.test(request)
    || /^run\s+(?:the\s+)?(?:tests?|checks?|build|lint|typecheck)\b/iu.test(request);
}

export async function acceptAgentConversation(
  client: PoolClient,
  context: ConversationContext
): Promise<AgentMentionResult> {
  const agents = await client.query<AgentCandidate>(
    `SELECT id, name, enabled, status
     FROM public.agent WHERE workspace_id = $1
     ORDER BY length(name) DESC, id`,
    [context.workspaceId]
  );
  const mentioned = agents.rows.find(({ name }) =>
    explicitAgentMentionPattern(name).test(context.body)
  );
  const rootMessageId = context.parentMessageId ?? context.messageId;
  const existing = context.parentMessageId
    ? await client.query<{ id: string; agent_id: string }>(
        `SELECT id, agent_id FROM public.agent_conversation
         WHERE workspace_id = $1 AND channel_id = $2 AND root_message_id = $3`,
        [context.workspaceId, context.channelId, rootMessageId]
      )
    : { rows: [] as Array<{ id: string; agent_id: string }> };
  const inherited = existing.rows[0]
    ? agents.rows.find(({ id }) => id === existing.rows[0]!.agent_id)
    : undefined;
  const agent = mentioned ?? inherited;
  if (!agent) return null;
  if (mentioned && isConcreteEngineeringRequest(context.body, agent.name)) return null;

  const readiness = await client.query<{
    author_is_active_pilot: boolean;
    author_is_project_member: boolean;
    agent_is_project_member: boolean;
    provider_connection_id: string | null;
    provider_status: string | null;
  }>(
    `SELECT
       (author.kind = 'pilot' AND membership.revoked_at IS NULL) AS author_is_active_pilot,
       EXISTS (
         SELECT 1 FROM public.project_membership author_project
         WHERE author_project.project_id = channel.project_id
           AND author_project.workspace_member_id = author.id
       ) AS author_is_project_member,
       EXISTS (
         SELECT 1 FROM public.workspace_member agent_member
         JOIN public.project_membership agent_project
           ON agent_project.workspace_member_id = agent_member.id
         WHERE agent_member.agent_id = $4 AND agent_project.project_id = channel.project_id
       ) AS agent_is_project_member,
       provider.id AS provider_connection_id, provider.status AS provider_status
     FROM public.message message
     JOIN public.channel channel ON channel.id = message.channel_id
     JOIN public.workspace_member author ON author.id = message.author_workspace_member_id
     LEFT JOIN public.workspace_membership membership ON membership.id = author.pilot_membership_id
     LEFT JOIN public.provider_connection provider ON provider.workspace_id = message.workspace_id
     WHERE message.id = $1 AND message.workspace_id = $2 AND channel.id = $3`,
    [context.messageId, context.workspaceId, context.channelId, agent.id]
  );
  const ready = readiness.rows[0];
  const rejection = !ready?.author_is_active_pilot
    ? 'Active Pilot member access is required.'
    : !ready.author_is_project_member
      ? 'This Channel is not eligible for Agent conversation.'
      : !ready.agent_is_project_member
        ? `${agent.name} is not a member of this Project.`
        : !agent.enabled || agent.status === 'disabled'
          ? `${agent.name} is disabled and cannot respond.`
          : ready.provider_status !== 'ready' || !ready.provider_connection_id
            ? 'A ready Codex Provider connection is required before Agent conversation.'
            : undefined;
  if (rejection) {
    await client.query(
      `UPDATE public.message
       SET agent_mention_status = 'rejected', mentioned_agent_id = $2,
           agent_mention_reason = $3
       WHERE id = $1`,
      [context.messageId, agent.id, rejection]
    );
    return { status: 'rejected', agentId: agent.id, reason: rejection };
  }

  const conversationId = existing.rows[0]?.id ?? randomUUID();
  if (!existing.rows[0]) {
    await client.query(
      `INSERT INTO public.agent_conversation (
         id, workspace_id, channel_id, root_message_id, agent_id, provider_connection_id
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (root_message_id, agent_id) DO NOTHING`,
      [
        conversationId,
        context.workspaceId,
        context.channelId,
        rootMessageId,
        agent.id,
        ready.provider_connection_id
      ]
    );
  }
  const storedConversation = await client.query<{ id: string }>(
    `SELECT id FROM public.agent_conversation
     WHERE workspace_id = $1 AND root_message_id = $2 AND agent_id = $3`,
    [context.workspaceId, rootMessageId, agent.id]
  );
  const storedConversationId = storedConversation.rows[0]?.id;
  if (!storedConversationId) throw new Error('Agent conversation could not be created');

  const turnId = randomUUID();
  const turn = await client.query<{ id: string }>(
    `INSERT INTO public.agent_conversation_turn (
       id, workspace_id, conversation_id, request_message_id,
       requested_by_workspace_member_id, status
     )
     SELECT $1, $2, $3, message.id, message.author_workspace_member_id, 'queued'
     FROM public.message message WHERE message.id = $4 AND message.workspace_id = $2
     ON CONFLICT (request_message_id) DO NOTHING
     RETURNING id`,
    [turnId, context.workspaceId, storedConversationId, context.messageId]
  );
  const storedTurnId = turn.rows[0]?.id ?? (await client.query<{ id: string }>(
    'SELECT id FROM public.agent_conversation_turn WHERE request_message_id = $1',
    [context.messageId]
  )).rows[0]?.id;
  if (!storedTurnId) throw new Error('Agent conversation turn could not be created');
  await client.query(
    `UPDATE public.message
     SET agent_mention_status = 'conversation', mentioned_agent_id = $2
     WHERE id = $1`,
    [context.messageId, agent.id]
  );
  return {
    status: 'conversation',
    agentId: agent.id,
    conversationTurnId: storedTurnId,
    turnStatus: 'queued'
  };
}
