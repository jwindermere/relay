import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import type { WorkspaceAccess } from '../authentication/authorization.js';
import type { GitHubRepositoryGateway } from '../github/connection.js';
import { selectAmbientTarget } from './ambient-target.js';
import { handleWaitingAgentRunReply } from './clarifications.js';
import { acceptAgentConversation } from './conversation.js';
import { recordCollaborationEvaluationEvent } from './evaluation.js';
import { handleConfirmedMessageControl } from './message-control.js';
import {
  acceptEligibleAgentMention,
  explicitAgentMentionPattern,
  isConcreteEngineeringRequest
} from './delegation.js';

export type MessageIntent =
  | 'ordinary_communication'
  | 'conversation'
  | 'research_request'
  | 'engineering_delegation'
  | 'progress_request'
  | 'human_authority_decision'
  | 'coordination_candidate';

export interface MessageRoutingDecision {
  intent: MessageIntent;
  targetAgentId: string | null;
  confidence: number;
  policyVersion: string;
  rationale: string;
  requiresConfirmation: boolean;
  correctedAt: string | null;
}

interface IntentContext {
  messageId: string;
  workspaceId: string;
  channelId: string;
  parentMessageId: string | null;
  body: string;
}

const POLICY_VERSION = 'rules-v1';
const INTENTS = new Set<MessageIntent>([
  'ordinary_communication', 'conversation', 'research_request',
  'engineering_delegation', 'progress_request', 'human_authority_decision',
  'coordination_candidate'
]);

export class MessageIntentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageIntentError';
  }
}

interface RuleAgent {
  id: string;
  name: string;
  agentType: 'engineering' | 'research' | 'product' | 'support' | 'general';
  participationMode?: 'reactive' | 'ambient';
  ambientTriggers?: string[];
}

function isAmbiguousConsequentialRequest(body: string, agent: RuleAgent): boolean {
  if (agent.agentType !== 'engineering') return false;
  const request = body.replace(explicitAgentMentionPattern(agent.name), ' ').trim();
  return /\b(?:maybe|perhaps|possibly|might|not sure|unsure)\b/iu.test(request)
    && /\b(?:implement|build|create|fix|change|refactor|add|remove|debug|deploy|merge|delete|destroy|push|publish|release)\b/iu.test(request);
}

function isResearchRequest(body: string, agentName: string): boolean {
  const request = body.replace(explicitAgentMentionPattern(agentName), ' ').trim();
  return /\b(?:research|investigate|analyse|analyze|compare|summarise|summarize|evidence|sources?|find out|look into)\b/iu.test(request);
}

export function isAgentConversationIntent(intent: MessageIntent): boolean {
  return intent === 'conversation' || intent === 'research_request'
    || intent === 'coordination_candidate';
}

export function requiresPilotMemberConfirmation(
  intent: MessageIntent,
  confidence = 1,
  body = ''
): boolean {
  return (intent === 'conversation' && confidence <= 0.6)
    || intent === 'engineering_delegation' || intent === 'research_request'
    || intent === 'coordination_candidate'
    || (intent === 'human_authority_decision'
      && /^(?:(?:guidance|steer|constraint)\s*:|resume\b)/iu.test(body.trim()));
}

export function decideMessageIntent(input: {
  body: string; parentMessageId: string | null; agents: RuleAgent[];
}): Omit<MessageRoutingDecision, 'correctedAt'> {
  const mentioned = input.agents
    .map((agent) => ({ agent, match: explicitAgentMentionPattern(agent.name).exec(input.body) }))
    .filter((candidate): candidate is { agent: RuleAgent; match: RegExpExecArray } =>
      candidate.match !== null)
    .sort((left, right) => left.match.index - right.match.index
      || right.match[0].length - left.match[0].length
      || left.agent.id.localeCompare(right.agent.id))[0]
    ?.agent;
  const normalized = input.body.toLocaleLowerCase();
  const engineeringAgents = input.agents.filter(({ agentType }) => agentType === 'engineering');
  const researchAgents = input.agents.filter(({ agentType }) => agentType === 'research');
  const soleEngineeringAgent = engineeringAgents.length === 1
    ? engineeringAgents[0]
    : undefined;
  const soleResearchAgent = researchAgents.length === 1
    ? researchAgents[0]
    : undefined;
  const engineeringTarget = mentioned?.agentType === 'engineering'
    ? mentioned
    : mentioned ? undefined : soleEngineeringAgent;
  const researchTarget = mentioned?.agentType === 'research'
    ? mentioned
    : mentioned ? undefined : soleResearchAgent;
  const engineeringCandidate = engineeringTarget
    ?? (mentioned ? undefined : engineeringAgents[0]);
  const researchCandidate = researchTarget
    ?? (mentioned ? undefined : researchAgents[0]);
  const ambientTarget = mentioned ? undefined : selectAmbientTarget(input.body, input.agents
    .filter(({ participationMode }) => participationMode === 'ambient')
    .map((agent) => ({
      candidate: agent,
      id: agent.id,
      triggers: agent.ambientTriggers ?? []
    })));
  let intent: MessageIntent = 'ordinary_communication';
  let confidence = 1;
  let rationale = 'No eligible Agent mention or active Agent conversation was found.';
  let targetAgent: RuleAgent | undefined = mentioned ?? ambientTarget;
  if (input.parentMessageId
    && /^(?:(?:guidance|steer|constraint)\s*:|(?:approve|approved|deny|denied|reject|rejected|cancel|pause|resume|yes|no)\b)/iu.test(input.body.trim())) {
    intent = 'human_authority_decision';
    confidence = 0.95;
    rationale = 'The reply records an explicit Pilot-member authority decision.';
  } else if (/\b(?:coordinate|coordination|several specialists|multiple agents|multi-agent)\b/u.test(normalized)) {
    intent = 'coordination_candidate';
    confidence = mentioned ? 0.95 : 0.8;
    rationale = 'The Message asks for bounded work involving more than one specialty.';
  } else if (engineeringCandidate
    && isConcreteEngineeringRequest(input.body, engineeringCandidate.name)) {
    intent = 'engineering_delegation';
    targetAgent = engineeringTarget;
    confidence = mentioned ? 1 : engineeringTarget ? 0.75 : 0.6;
    rationale = mentioned
      ? 'An explicit Engineering Agent mention requests a concrete repository outcome.'
      : engineeringTarget
        ? 'A concrete repository outcome matches the only eligible Engineering Agent.'
        : 'A concrete repository outcome needs Pilot member clarification of the target Agent.';
  } else if (researchCandidate && isResearchRequest(input.body, researchCandidate.name)) {
    intent = 'research_request';
    targetAgent = researchTarget;
    confidence = mentioned ? 0.9 : researchTarget ? 0.75 : 0.6;
    rationale = mentioned
      ? 'An explicit Research Agent mention requests a research response.'
      : researchTarget
        ? 'A research request matches the only eligible Research Agent.'
        : 'A research request needs Pilot member clarification of the target Agent.';
  } else if (engineeringCandidate
    && isAmbiguousConsequentialRequest(input.body, engineeringCandidate)) {
    intent = 'conversation';
    targetAgent = engineeringTarget;
    confidence = 0.6;
    rationale = 'The Message may request repository-affecting work, so Pilot member clarification is required.';
  } else if (/\b(?:status|progress|how(?:'s| is) (?:it|the work)|where are we)\b/u.test(normalized)) {
    intent = 'progress_request';
    confidence = 0.95;
    rationale = 'The Message asks for visible progress on existing work.';
  } else if (mentioned || ambientTarget || input.parentMessageId) {
    intent = 'conversation';
    const ambiguousConsequentialRequest = mentioned
      ? isAmbiguousConsequentialRequest(input.body, mentioned)
      : false;
    confidence = ambiguousConsequentialRequest ? 0.6 : mentioned ? 1 : 0.8;
    rationale = ambiguousConsequentialRequest
      ? 'The Message may request repository-affecting work, so Pilot member clarification is required.'
      : mentioned
        ? 'An explicit Agent mention requests a conversational response.'
        : ambientTarget
          ? 'One ambient Agent matches the Message topic.'
        : 'The Message continues an existing Shared Agent Channel thread.';
  }
  return {
    intent,
    targetAgentId: targetAgent?.id ?? null,
    confidence,
    policyVersion: POLICY_VERSION,
    rationale,
    requiresConfirmation: requiresPilotMemberConfirmation(intent, confidence, input.body)
  };
}

export async function correctMessageIntent(
  pool: Pool,
  access: WorkspaceAccess,
  messageId: string,
  correction: { intent: MessageIntent; targetAgentId?: string | null },
  dependencies: { getRepositoryGateway?: () => GitHubRepositoryGateway } = {}
): Promise<void> {
  if (!INTENTS.has(correction.intent)) throw new MessageIntentError('Message intent is invalid');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const actor = await client.query<{ id: string }>(
      `SELECT member.id
       FROM public.workspace_member member
       JOIN public.workspace_membership membership
         ON membership.id = member.pilot_membership_id
        AND membership.workspace_id = member.workspace_id
       JOIN public.message message ON message.id = $3 AND message.workspace_id = member.workspace_id
       JOIN public.channel channel ON channel.id = message.channel_id
       JOIN public.project_membership project_member
         ON project_member.project_id = channel.project_id
        AND project_member.workspace_member_id = member.id
       WHERE member.workspace_id = $1 AND membership.id = $2
         AND membership.revoked_at IS NULL`,
      [access.workspace.id, access.membership.id, messageId]
    );
    if (!actor.rows[0]) throw new MessageIntentError('active Pilot membership is required');
    const messageContext = await client.query<{
      channel_id: string; parent_message_id: string | null; body: string;
      target_agent_id: string | null;
    }>(
      `SELECT message.channel_id, message.parent_message_id, message.body,
              COALESCE(decision.corrected_target_agent_id, decision.target_agent_id)
                AS target_agent_id
       FROM public.message message
       LEFT JOIN public.message_intent_decision decision
         ON decision.message_id = message.id AND decision.workspace_id = message.workspace_id
       WHERE message.id = $1 AND message.workspace_id = $2`,
      [messageId, access.workspace.id]
    );
    if (!messageContext.rows[0]) throw new MessageIntentError('Message routing decision was not found');
    let correctedTargetAgentId = correction.targetAgentId === undefined
      ? messageContext.rows[0].target_agent_id
      : correction.targetAgentId;
    if (correction.intent === 'engineering_delegation' || correction.intent === 'research_request') {
      const expectedAgentType = correction.intent === 'engineering_delegation'
        ? 'engineering'
        : 'research';
      const eligibleTargets = await client.query<{ id: string }>(
        `SELECT agent.id
         FROM public.agent agent
         JOIN public.workspace_member member ON member.agent_id = agent.id
         JOIN public.project_membership project_member
           ON project_member.workspace_member_id = member.id
         JOIN public.message message ON message.id = $2
         JOIN public.channel channel ON channel.id = message.channel_id
         WHERE agent.workspace_id = $1 AND agent.agent_type = $3
           AND agent.enabled AND agent.status <> 'disabled'
           AND project_member.project_id = channel.project_id
         ORDER BY agent.id`,
        [access.workspace.id, messageId, expectedAgentType]
      );
      if (correction.targetAgentId === undefined
        && !eligibleTargets.rows.some(({ id }) => id === correctedTargetAgentId)
        && eligibleTargets.rows.length === 1) {
        correctedTargetAgentId = eligibleTargets.rows[0]!.id;
      }
      if (!eligibleTargets.rows.some(({ id }) => id === correctedTargetAgentId)) {
        throw new MessageIntentError(`Corrected ${expectedAgentType} Agent is unavailable`);
      }
    }
    const existingWork = await client.query<{
      task_id: string; run_id: string; run_status: string; assigned_agent_id: string;
      project_id: string; routing_policy_version: string | null; agent_configuration_version: number;
      agent_type_snapshot: string;
    }>(
      `SELECT task.id AS task_id, run.id AS run_id, run.status AS run_status,
              task.assigned_agent_id, task.project_id,
              decision.policy_version AS routing_policy_version,
              run.agent_configuration_version, run.agent_type_snapshot
       FROM public.task task JOIN public.agent_run run ON run.task_id = task.id
       LEFT JOIN public.message_intent_decision decision ON decision.message_id = task.source_message_id
       WHERE task.source_message_id = $1 AND task.workspace_id = $2
       ORDER BY run.attempt_number DESC LIMIT 1 FOR UPDATE OF task, run`,
      [messageId, access.workspace.id]
    );
    const routed = existingWork.rows[0];
    const existingConversationWork = await client.query<{
      turn_id: string; turn_status: 'queued' | 'working' | 'completed' | 'failed';
      agent_id: string;
    }>(
      `SELECT turn.id AS turn_id, turn.status AS turn_status, conversation.agent_id
       FROM public.agent_conversation_turn turn
       JOIN public.agent_conversation conversation ON conversation.id = turn.conversation_id
       WHERE turn.request_message_id = $1 AND turn.workspace_id = $2
       FOR UPDATE OF turn`,
      [messageId, access.workspace.id]
    );
    const conversationWork = existingConversationWork.rows[0];
    const correctedConversationIntent = isAgentConversationIntent(correction.intent);
    const changesConversationRoute = conversationWork && (
      !correctedConversationIntent || correctedTargetAgentId !== conversationWork.agent_id
    );
    if (changesConversationRoute && conversationWork.turn_status !== 'queued') {
      throw new MessageIntentError('Message intent cannot be corrected after Agent conversation starts');
    }
    if (changesConversationRoute && !correctedConversationIntent) {
      await client.query(
        `UPDATE public.agent_conversation_turn
         SET status = 'failed', completed_at = now(), error_code = 'routing_corrected',
             updated_at = now()
         WHERE id = $1 AND status = 'queued'`,
        [conversationWork.turn_id]
      );
      await client.query(
        `UPDATE public.message SET agent_mention_status = 'communication',
           mentioned_agent_id = NULL, agent_mention_reason = NULL
         WHERE id = $1`,
        [messageId]
      );
    }
    const changesEngineeringRoute = routed && (
      correction.intent !== 'engineering_delegation'
      || correctedTargetAgentId !== routed.assigned_agent_id
    );
    if (changesEngineeringRoute && routed.run_status !== 'queued') {
      throw new MessageIntentError('Message intent cannot be corrected after repository execution starts');
    }
    if (changesEngineeringRoute && correction.intent === 'engineering_delegation') {
      await client.query(`UPDATE public.task SET assigned_agent_id = $2, updated_at = now() WHERE id = $1`,
        [routed.task_id, correctedTargetAgentId]);
      await client.query(`UPDATE public.agent_run SET agent_id = $2, updated_at = now() WHERE id = $1`,
        [routed.run_id, correctedTargetAgentId]);
      await client.query(`UPDATE public.message SET mentioned_agent_id = $2 WHERE id = $1`,
        [messageId, correctedTargetAgentId]);
    } else if (changesEngineeringRoute) {
      await client.query(
        `UPDATE public.agent_run SET status = 'cancelled', completed_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'queued'`, [routed.run_id]
      );
      await client.query(`UPDATE public.task SET status = 'cancelled', updated_at = now() WHERE id = $1`,
        [routed.task_id]);
      await client.query(
        `UPDATE public.message SET agent_mention_status = 'communication',
           mentioned_agent_id = NULL, agent_mention_reason = NULL
         WHERE id = $1`, [messageId]
      );
      await recordCollaborationEvaluationEvent(client, {
        workspaceId: access.workspace.id, projectId: routed.project_id,
        eventType: 'outcome.cancelled', agentId: routed.assigned_agent_id,
        routingPolicyVersion: routed.routing_policy_version,
        agentConfigurationVersion: `agent-config-${routed.agent_configuration_version}`,
        agentType: routed.agent_type_snapshot,
        promptVersion: 'engineering-run-v1',
        permissionPolicyVersion: 'mvp-engineering-autonomy-v1',
        outcomeType: 'agent_run', outcomeId: routed.run_id,
        evidence: { status: 'cancelled', reason: 'routing_corrected' }
      });
    }
    const updated = await client.query(
      `UPDATE public.message_intent_decision decision
       SET corrected_intent = $4,
           corrected_target_agent_id = $5,
           corrected_by_workspace_member_id = $3,
           corrected_at = now()
       FROM public.message message
       WHERE decision.message_id = $1 AND decision.workspace_id = $2
         AND message.id = decision.message_id AND message.workspace_id = decision.workspace_id
         AND ($5::text IS NULL OR EXISTS (
           SELECT 1 FROM public.agent agent
           WHERE agent.id = $5 AND agent.workspace_id = decision.workspace_id
         ))`,
      [messageId, access.workspace.id, actor.rows[0].id, correction.intent,
        correctedTargetAgentId]
    );
    if (updated.rowCount !== 1) throw new MessageIntentError('Message routing decision was not found');
    await client.query(
      `INSERT INTO public.audit_event (
         workspace_id, actor_user_id, actor_membership_id,
         event_type, subject_type, subject_id, evidence
       ) VALUES ($1, $2, $3, 'message.intent.corrected', 'message', $4,
         jsonb_build_object('intent', $5::text, 'targetAgentId', $6::text))`,
      [access.workspace.id, access.identity.userId, access.membership.id,
        messageId, correction.intent, correctedTargetAgentId]
    );
    await client.query(
      `INSERT INTO public.collaboration_evaluation_event (
         id, workspace_id, project_id, event_type, agent_id,
         routing_policy_version, permission_policy_version, outcome_type, outcome_id, evidence
       )
       SELECT $1, decision.workspace_id, decision.project_id, 'pilot.override',
              COALESCE(decision.corrected_target_agent_id, decision.target_agent_id),
              decision.policy_version, 'pilot-authority-v1', 'message', decision.message_id,
              jsonb_build_object('selectedIntent', decision.selected_intent,
                                 'correctedIntent', decision.corrected_intent)
       FROM public.message_intent_decision decision
       WHERE decision.message_id = $2 AND decision.workspace_id = $3`,
      [randomUUID(), messageId, access.workspace.id]
    );
    if (!routed) {
      const context = {
        messageId, workspaceId: access.workspace.id,
        channelId: messageContext.rows[0].channel_id,
        parentMessageId: messageContext.rows[0].parent_message_id,
        body: messageContext.rows[0].body,
        targetAgentId: correctedTargetAgentId
      };
      const controlHandled = correction.intent === 'human_authority_decision'
        || correction.intent === 'progress_request'
        ? await handleConfirmedMessageControl(client, context)
        : correction.intent === 'conversation' && context.parentMessageId
          ? await handleWaitingAgentRunReply(client, {
              ...context,
              parentMessageId: context.parentMessageId
            })
          : false;
      if (!controlHandled && correction.intent === 'engineering_delegation') {
        await acceptEligibleAgentMention(client, {
          ...context, getRepositoryGateway: dependencies.getRepositoryGateway
        });
      } else if (!controlHandled && correctedConversationIntent
        && (!conversationWork || changesConversationRoute)) {
        await acceptAgentConversation(client, context);
      }
    }
    await client.query(
      `INSERT INTO public.collaboration_evaluation_event (
         id, workspace_id, project_id, event_type, agent_id,
         routing_policy_version, permission_policy_version, outcome_type, outcome_id, evidence
       ) SELECT $1, decision.workspace_id, decision.project_id, 'routing.disagreement',
                COALESCE(decision.corrected_target_agent_id, decision.target_agent_id),
                decision.policy_version, 'pilot-authority-v1', 'message', decision.message_id,
                jsonb_build_object('selectedIntent', decision.selected_intent,
                                   'correctedIntent', decision.corrected_intent)
         FROM public.message_intent_decision decision
        WHERE decision.message_id = $2 AND decision.workspace_id = $3
          AND decision.corrected_intent <> decision.selected_intent`,
      [randomUUID(), messageId, access.workspace.id]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function classifyMessageIntent(
  client: PoolClient,
  context: IntentContext
): Promise<Omit<MessageRoutingDecision, 'correctedAt'> | null> {
  const surface = await client.query<{
    project_id: string;
    author_kind: 'pilot' | 'agent';
  }>(
    `SELECT channel.project_id, author.kind AS author_kind
     FROM public.message message
     JOIN public.channel channel
       ON channel.id = message.channel_id AND channel.workspace_id = message.workspace_id
     JOIN public.workspace_member author
       ON author.id = message.author_workspace_member_id
      AND author.workspace_id = message.workspace_id
     WHERE message.id = $1 AND message.workspace_id = $2`,
    [context.messageId, context.workspaceId]
  );
  const projectId = surface.rows[0]?.project_id;
  if (!projectId || surface.rows[0]?.author_kind !== 'pilot') return null;

  const agents = await client.query<{
    id: string;
    name: string;
    agent_type: 'engineering' | 'research' | 'product' | 'support' | 'general';
    participation_mode: 'reactive' | 'ambient';
    ambient_triggers: string[];
  }>(
    `SELECT agent.id, agent.name, agent.agent_type,
            agent.participation_mode, agent.ambient_triggers
     FROM public.agent agent
     JOIN public.workspace_member member ON member.agent_id = agent.id
     JOIN public.project_membership project_member
       ON project_member.workspace_member_id = member.id AND project_member.project_id = $2
     WHERE agent.workspace_id = $1 AND agent.enabled AND agent.status <> 'disabled'
     ORDER BY length(agent.name) DESC, agent.id`,
    [context.workspaceId, projectId]
  );
  const decision = decideMessageIntent({
    body: context.body,
    parentMessageId: context.parentMessageId,
    agents: agents.rows.map((agent) => ({
      id: agent.id,
      name: agent.name,
      agentType: agent.agent_type,
      participationMode: agent.participation_mode,
      ambientTriggers: agent.ambient_triggers
    }))
  });

  await client.query(
    `INSERT INTO public.message_intent_decision (
       id, workspace_id, project_id, message_id, selected_intent,
       target_agent_id, confidence, policy_version, rationale
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (message_id) DO NOTHING`,
    [
      randomUUID(), context.workspaceId, projectId, context.messageId, decision.intent,
      decision.targetAgentId, decision.confidence, decision.policyVersion, decision.rationale
    ]
  );
  await client.query(
    `INSERT INTO public.collaboration_evaluation_event (
       id, workspace_id, project_id, event_type, agent_id,
       routing_policy_version, permission_policy_version, outcome_type, outcome_id, evidence
     ) VALUES ($1, $2, $3, 'routing.decision', $4, $5, 'pilot-authority-v1',
       'message', $6, jsonb_build_object('intent', $7::text, 'confidence', $8::numeric))`,
    [randomUUID(), context.workspaceId, projectId, decision.targetAgentId,
      decision.policyVersion, context.messageId, decision.intent, decision.confidence]
  );
  return decision;
}
