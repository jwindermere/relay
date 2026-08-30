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
  agent_type: 'engineering' | 'research' | 'product' | 'support' | 'general';
  role_label: string;
  instructions: string;
  participation_mode: 'reactive' | 'ambient';
  ambient_triggers: string[];
  reply_mode: 'adaptive' | 'channel' | 'thread';
  enabled: boolean;
  status: 'idle' | 'working' | 'waiting' | 'disabled';
}

function ambientTriggerMatches(normalizedBody: string, trigger: string): boolean {
  const normalized = trigger.trim().toLocaleLowerCase();
  if (!normalized) return false;
  if (/^[\p{L}\p{N}_-]+$/u.test(normalized)) {
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}_-])${escaped}($|[^\\p{L}\\p{N}_-])`, 'u')
      .test(normalizedBody);
  }
  return normalizedBody.includes(normalized);
}

function handoffQuestion(body: string, agentName: string): string {
  return body
    .replace(explicitAgentMentionPattern(agentName), ' ')
    .trim()
    .replace(/^[\s,.:;!?-]+/u, '')
    .trim();
}

export function matchesAmbientTriggers(body: string, triggers: string[]): boolean {
  const normalizedBody = body.toLocaleLowerCase();
  return triggers.some((trigger) => ambientTriggerMatches(normalizedBody, trigger));
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
    `SELECT id, name, agent_type, role_label, instructions, participation_mode,
            ambient_triggers, reply_mode, enabled, status
     FROM public.agent WHERE workspace_id = $1
     ORDER BY length(name) DESC, id`,
    [context.workspaceId]
  );
  const mentioned = agents.rows.find(({ name }) =>
    explicitAgentMentionPattern(name).test(context.body)
  );
  const requestAuthor = await client.query<{
    kind: 'pilot' | 'agent';
    agent_id: string | null;
  }>(
    `SELECT author.kind, author.agent_id
     FROM public.message message
     JOIN public.workspace_member author
       ON author.id = message.author_workspace_member_id
      AND author.workspace_id = message.workspace_id
     WHERE message.id = $1 AND message.workspace_id = $2`,
    [context.messageId, context.workspaceId]
  );
  const agentAuthored = requestAuthor.rows[0]?.kind === 'agent';
  // Agent output is only routable as an explicit, bounded handoff. In particular,
  // a reply in an existing Thread must not implicitly wake the same Agent again.
  if (agentAuthored && !mentioned) return null;
  const rootMessageId = context.parentMessageId ?? context.messageId;
  const existing = context.parentMessageId
    ? await client.query<{ id: string; agent_id: string }>(
        `SELECT conversation.id, conversation.agent_id
         FROM public.agent_conversation conversation
         WHERE conversation.workspace_id = $1 AND conversation.channel_id = $2
           AND (
             conversation.root_message_id = $3
             OR EXISTS (
               SELECT 1 FROM public.agent_conversation_turn turn
               WHERE turn.conversation_id = conversation.id
                 AND turn.response_message_id = $3
             )
           )
         ORDER BY conversation.updated_at DESC, conversation.id
         LIMIT 1`,
        [context.workspaceId, context.channelId, rootMessageId]
      )
    : { rows: [] as Array<{ id: string; agent_id: string }> };
  const inherited = existing.rows[0]
    ? agents.rows.find(({ id }) => id === existing.rows[0]!.agent_id)
    : undefined;
  let ambient = false;
  let agent = mentioned ?? inherited;
  if (!agent) {
    const taskOwner = context.parentMessageId
      ? await client.query<{ assigned_agent_id: string }>(
          `SELECT task.assigned_agent_id
           FROM public.task task
           JOIN public.message source ON source.id = task.source_message_id
           WHERE source.workspace_id = $1 AND source.channel_id = $2
             AND COALESCE(source.parent_message_id, source.id) = $3
           ORDER BY task.created_at DESC, task.id
           LIMIT 1`,
          [context.workspaceId, context.channelId, rootMessageId]
        )
      : { rows: [] as Array<{ assigned_agent_id: string }> };
    const ambientCandidates = agents.rows.filter((candidate) =>
      candidate.participation_mode === 'ambient'
      && candidate.enabled
      && candidate.status !== 'disabled'
    );
    agent = ambientCandidates.find((candidate) =>
      candidate.id === taskOwner.rows[0]?.assigned_agent_id
    ) ?? ambientCandidates
      .map((candidate) => ({
        candidate,
        score: candidate.ambient_triggers.reduce(
          (score, trigger) => score + (ambientTriggerMatches(context.body.toLocaleLowerCase(), trigger)
            ? trigger.trim().length
            : 0),
          0
        )
      }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || left.candidate.id.localeCompare(right.candidate.id))[0]
      ?.candidate;
    ambient = Boolean(agent);
  }
  if (!agent) return null;
  if (mentioned && agent.agent_type === 'engineering'
    && isConcreteEngineeringRequest(context.body, agent.name)) return null;

  const readiness = await client.query<{
    author_is_active_pilot: boolean;
    valid_agent_handoff: boolean;
    handoff_depth: number;
    project_id: string | null;
    source_agent_id: string | null;
    originating_pilot_member_id: string | null;
    source_turn_id: string | null;
    author_is_project_member: boolean;
    agent_is_project_member: boolean;
    provider_connection_id: string | null;
    provider_status: string | null;
  }>(
    `SELECT
       (author.kind = 'pilot' AND membership.revoked_at IS NULL) AS author_is_active_pilot,
       (author.kind = 'agent'
         AND author.agent_id <> $4
         AND source_turn.id IS NOT NULL
         AND source_turn.handoff_depth = 0
         AND source_requester.kind = 'pilot') AS valid_agent_handoff,
       CASE WHEN author.kind = 'agent' THEN COALESCE(source_turn.handoff_depth + 1, 2)
            ELSE 0 END AS handoff_depth,
       channel.project_id,
       author.agent_id AS source_agent_id,
       source_turn.requested_by_workspace_member_id AS originating_pilot_member_id,
       source_turn.id AS source_turn_id,
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
     LEFT JOIN public.agent_conversation_turn source_turn
       ON source_turn.response_message_id = message.id
      AND source_turn.workspace_id = message.workspace_id
     LEFT JOIN public.workspace_member source_requester
       ON source_requester.id = source_turn.requested_by_workspace_member_id
      AND source_requester.workspace_id = source_turn.workspace_id
     WHERE message.id = $1 AND message.workspace_id = $2 AND channel.id = $3`,
    [context.messageId, context.workspaceId, context.channelId, agent.id]
  );
  const ready = readiness.rows[0];
  if (agentAuthored && !ready?.valid_agent_handoff) return null;
  const rejection = !ready?.author_is_active_pilot && !ready?.valid_agent_handoff
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
    if (ambient) return null;
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
  const storedConversationId = existing.rows[0]?.id ?? (await client.query<{ id: string }>(
    `SELECT id FROM public.agent_conversation
     WHERE workspace_id = $1 AND root_message_id = $2 AND agent_id = $3`,
    [context.workspaceId, rootMessageId, agent.id]
  )).rows[0]?.id;
  if (!storedConversationId) throw new Error('Agent conversation could not be created');

  const turnId = randomUUID();
  const responsePlacement = agent.reply_mode === 'thread'
    ? 'thread'
    : agent.reply_mode === 'channel'
      ? 'channel'
      : context.parentMessageId ? 'thread' : 'channel';
  const responseParentMessageId = responsePlacement === 'thread'
    ? (context.parentMessageId ?? context.messageId)
    : null;
  const turn = await client.query<{ id: string }>(
    `INSERT INTO public.agent_conversation_turn (
       id, workspace_id, conversation_id, request_message_id,
       requested_by_workspace_member_id, status, response_placement,
       response_parent_message_id, ambient, handoff_depth
     )
     SELECT $1, $2, $3, message.id, message.author_workspace_member_id, 'queued', $5, $6, $7, $8
     FROM public.message message WHERE message.id = $4 AND message.workspace_id = $2
     ON CONFLICT (request_message_id) DO NOTHING
     RETURNING id`,
    [
      turnId, context.workspaceId, storedConversationId, context.messageId,
      responsePlacement, responseParentMessageId, ambient, ready.handoff_depth
    ]
  );
  const storedTurnId = turn.rows[0]?.id ?? (await client.query<{ id: string }>(
    'SELECT id FROM public.agent_conversation_turn WHERE request_message_id = $1',
    [context.messageId]
  )).rows[0]?.id;
  if (!storedTurnId) throw new Error('Agent conversation turn could not be created');
  if (agentAuthored) {
    if (!ready.project_id || !ready.source_agent_id
      || !ready.originating_pilot_member_id || !ready.source_turn_id) {
      throw new Error('Agent handoff provenance could not be established');
    }
    const question = handoffQuestion(context.body, agent.name);
    if (!question) throw new Error('Agent handoff must contain a concrete question');
    await client.query(
      `INSERT INTO public.agent_handoff (
         id, workspace_id, project_id, originating_pilot_member_id,
         source_agent_id, target_agent_id, source_message_id, receiving_turn_id,
         question, context_snapshot, artifact_references, expected_response_shape
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '[]'::jsonb, 'concise_text')
       ON CONFLICT (source_message_id) DO NOTHING`,
      [
        randomUUID(), context.workspaceId, ready.project_id,
        ready.originating_pilot_member_id, ready.source_agent_id, agent.id,
        context.messageId, storedTurnId, question,
        {
          channelId: context.channelId,
          sourceConversationTurnId: ready.source_turn_id,
          sourceMessageId: context.messageId
        }
      ]
    );
  }
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
