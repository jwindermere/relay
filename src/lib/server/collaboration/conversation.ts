import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import type { AgentMentionResult } from './delegation.js';
import type { AgentExpectedResultShape } from './agent-templates.js';
import { matchesAmbientTriggers, selectAmbientTarget } from './ambient-target.js';
import { loadChannelContextBeforeMessage } from './channel-context.js';
import {
  explicitAgentMentionPattern,
  isConcreteEngineeringRequest,
  resolveMessageAgentTarget
} from './delegation.js';

export { isConcreteEngineeringRequest } from './delegation.js';

interface ConversationContext {
  messageId: string;
  workspaceId: string;
  channelId: string;
  parentMessageId: string | null;
  body: string;
  targetAgentId?: string | null;
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
  configuration_version: number;
  template_expected_result_shapes: AgentExpectedResultShape[];
}

function handoffQuestion(body: string, agentName: string): string {
  return body
    .replace(explicitAgentMentionPattern(agentName), ' ')
    .trim()
    .replace(/^[\s,.:;!?-]+/u, '')
    .trim();
}

function requestsBoundedSpecialistInput(body: string, agentName: string): boolean {
  const request = handoffQuestion(body, agentName);
  const asksForInput = /^(?:what|which|who|whose|when|where|why|how|whether)\b/iu.test(request)
    || /^(?:is|are|do|does|did|has|have|should|would|can|could)\s+(?!you\b)/iu.test(request)
    || /^(?:(?:please|could\s+you|would\s+you|can\s+you)\s+)?(?:explain|identify|clarify|assess|advise|recommend|compare|summarize|describe|outline|tell\s+me)\b/iu.test(request);
  const addsAnotherClause = /[.,;:!?]\s+\S|\b(?:and|then|also|afterwards)\b/iu.test(request);
  const directsSecondPersonAction = /\byou\s+(?!(?:think|recommend|advise|suggest|know|believe|expect|consider|explain|identify|clarify|assess|compare|summarize|describe|outline|tell)\b)/iu.test(request);
  return asksForInput && !addsAnotherClause && !directsSecondPersonAction;
}

export { matchesAmbientTriggers } from './ambient-target.js';

export async function acceptAgentConversation(
  client: PoolClient,
  context: ConversationContext
): Promise<AgentMentionResult> {
  const agents = await client.query<AgentCandidate>(
    `SELECT id, name, agent_type, role_label, instructions, participation_mode,
            ambient_triggers, reply_mode, enabled, status, configuration_version,
            COALESCE(template_snapshot -> 'expectedResultShapes', '[]'::jsonb)
              AS template_expected_result_shapes
     FROM public.agent WHERE workspace_id = $1
     ORDER BY length(name) DESC, id`,
    [context.workspaceId]
  );
  const mentioned = agents.rows.find(({ name }) => explicitAgentMentionPattern(name).test(context.body));
  const targetAgent = resolveMessageAgentTarget(agents.rows, context.body, context.targetAgentId);
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
  if (agentAuthored && !targetAgent) return null;
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
  let agent = targetAgent ?? inherited;
  if (agent && !mentioned && !inherited
    && agent.participation_mode === 'ambient'
    && matchesAmbientTriggers(context.body, agent.ambient_triggers)) {
    ambient = true;
  }
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
    ) ?? selectAmbientTarget(context.body, ambientCandidates.map((candidate) => ({
      candidate,
      id: candidate.id,
      triggers: candidate.ambient_triggers
    })));
    ambient = Boolean(agent);
  }
  if (!agent) return null;
  if (agentAuthored && !requestsBoundedSpecialistInput(context.body, agent.name)) return null;
  if (targetAgent && (
    (agent.agent_type === 'engineering' && isConcreteEngineeringRequest(context.body, agent.name))
  )) return null;

  const readiness = await client.query<{
    author_is_active_pilot: boolean;
    valid_agent_handoff: boolean;
    handoff_depth: number;
    project_id: string | null;
    source_agent_id: string | null;
    originating_pilot_member_id: string | null;
    source_turn_id: string | null;
    source_request_message_id: string | null;
    source_request_body: string | null;
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
       source_request.id AS source_request_message_id,
       source_request.body AS source_request_body,
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
     LEFT JOIN public.message source_request
       ON source_request.id = source_turn.request_message_id
      AND source_request.workspace_id = source_turn.workspace_id
     WHERE message.id = $1 AND message.workspace_id = $2 AND channel.id = $3`,
    [context.messageId, context.workspaceId, context.channelId, agent.id]
  );
  const routingContext = readiness.rows[0];
  if (agentAuthored && !routingContext?.valid_agent_handoff) return null;
  const rejection = !routingContext?.author_is_active_pilot && !routingContext?.valid_agent_handoff
    ? 'Active Pilot member access is required.'
    : !routingContext.author_is_project_member
      ? 'This Channel is not eligible for Agent conversation.'
      : !routingContext.agent_is_project_member
        ? `${agent.name} is not a member of this Project.`
        : !agent.enabled || agent.status === 'disabled'
          ? `${agent.name} is disabled and cannot respond.`
          : routingContext.provider_status !== 'ready' || !routingContext.provider_connection_id
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

  const selectedConversation = existing.rows[0]?.agent_id === agent.id
    ? existing.rows[0]
    : undefined;
  const conversationId = selectedConversation?.id ?? randomUUID();
  if (!selectedConversation) {
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
        routingContext.provider_connection_id
      ]
    );
  }
  const storedConversationId = selectedConversation?.id ?? (await client.query<{ id: string }>(
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
      responsePlacement, responseParentMessageId, ambient, routingContext.handoff_depth
    ]
  );
  const storedTurnId = turn.rows[0]?.id ?? (await client.query<{ id: string }>(
    'SELECT id FROM public.agent_conversation_turn WHERE request_message_id = $1',
    [context.messageId]
  )).rows[0]?.id;
  if (!storedTurnId) throw new Error('Agent conversation turn could not be created');
  if (!turn.rows[0]) {
    const retargeted = await client.query(
      `UPDATE public.agent_conversation_turn
       SET conversation_id = $2, response_placement = $3,
           response_parent_message_id = $4, ambient = $5,
           agent_configuration_version = $6, agent_type_snapshot = $7,
           updated_at = now()
       WHERE id = $1 AND status = 'queued'`,
      [storedTurnId, storedConversationId, responsePlacement, responseParentMessageId,
        ambient, agent.configuration_version, agent.agent_type]
    );
    if (retargeted.rowCount !== 1) {
      throw new Error('Agent conversation cannot be retargeted after execution starts');
    }
  }
  if (agentAuthored) {
    if (!routingContext.project_id || !routingContext.source_agent_id
      || !routingContext.originating_pilot_member_id || !routingContext.source_turn_id) {
      throw new Error('Agent handoff provenance could not be established');
    }
    const question = handoffQuestion(context.body, agent.name);
    if (!question) throw new Error('Agent handoff must contain a concrete question');
    const suppliedArtifacts = await client.query<{
      id: string;
      kind: string;
      result_message_id: string;
      url: string;
    }>(
      `SELECT artifact.id, artifact.kind, artifact.result_message_id, artifact.url
       FROM public.artifact artifact
       WHERE artifact.workspace_id = $1 AND artifact.project_id = $2
         AND (
           strpos($3, artifact.id) > 0
           OR strpos($3, artifact.url) > 0
           OR strpos($3, artifact.result_message_id) > 0
           OR strpos(COALESCE($4, ''), artifact.id) > 0
           OR strpos(COALESCE($4, ''), artifact.url) > 0
           OR strpos(COALESCE($4, ''), artifact.result_message_id) > 0
         )
       ORDER BY artifact.created_at, artifact.id`,
      [
        context.workspaceId,
        routingContext.project_id,
        context.body,
        routingContext.source_request_body
      ]
    );
    const artifactReferences = suppliedArtifacts.rows.map((artifact) => ({
      artifactId: artifact.id,
      kind: artifact.kind,
      resultMessageId: artifact.result_message_id,
      url: artifact.url
    }));
    const expectedResponseShape = agent.agent_type === 'research'
      || agent.template_expected_result_shapes.includes('structured_finding')
      ? 'structured_finding'
      : 'concise_text';
    const suppliedContext = await loadChannelContextBeforeMessage(
      client,
      context.messageId,
      context.workspaceId
    );
    await client.query(
      `INSERT INTO public.agent_handoff (
         id, workspace_id, project_id, originating_pilot_member_id,
         source_agent_id, target_agent_id, source_message_id, receiving_turn_id,
         question, context_snapshot, artifact_references, expected_response_shape
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (source_message_id) DO NOTHING`,
      [
        randomUUID(), context.workspaceId, routingContext.project_id,
        routingContext.originating_pilot_member_id, routingContext.source_agent_id, agent.id,
        context.messageId, storedTurnId, question,
        {
          channelId: context.channelId,
          projectId: routingContext.project_id,
          sourceConversationTurnId: routingContext.source_turn_id,
          sourceMessageId: context.messageId,
          suppliedChannelContext: suppliedContext,
          originatingRequest: {
            messageId: routingContext.source_request_message_id,
            body: routingContext.source_request_body
          }
        },
        JSON.stringify(artifactReferences),
        expectedResponseShape
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
