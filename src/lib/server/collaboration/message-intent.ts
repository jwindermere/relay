import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import type { WorkspaceAccess } from '../authentication/authorization.js';
import {
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
}

export function decideMessageIntent(input: {
  body: string; parentMessageId: string | null; agents: RuleAgent[];
}): Omit<MessageRoutingDecision, 'correctedAt'> {
  const mentioned = input.agents.find((agent) => explicitAgentMentionPattern(agent.name).test(input.body));
  const normalized = input.body.toLocaleLowerCase();
  let intent: MessageIntent = 'ordinary_communication';
  let confidence = 1;
  let rationale = 'No eligible Agent mention or active Agent conversation was found.';
  if (/\b(?:status|progress|how(?:'s| is) (?:it|the work)|where are we)\b/u.test(normalized)) {
    intent = 'progress_request';
    confidence = 0.95;
    rationale = 'The Message asks for visible progress on existing work.';
  } else if (input.parentMessageId
    && /^(?:approve|approved|deny|denied|reject|rejected|cancel|pause|resume|yes|no)\b/iu.test(input.body.trim())) {
    intent = 'human_authority_decision';
    confidence = 0.95;
    rationale = 'The reply records an explicit Pilot-member authority decision.';
  } else if (/\b(?:coordinate|coordination|several specialists|multiple agents|multi-agent)\b/u.test(normalized)) {
    intent = 'coordination_candidate';
    confidence = mentioned ? 0.95 : 0.8;
    rationale = 'The Message asks for bounded work involving more than one specialty.';
  } else if (mentioned?.agentType === 'engineering'
    && isConcreteEngineeringRequest(input.body, mentioned.name)) {
    intent = 'engineering_delegation';
    confidence = 1;
    rationale = 'An explicit Engineering Agent mention requests a concrete repository outcome.';
  } else if (mentioned?.agentType === 'research') {
    intent = 'research_request';
    confidence = 0.9;
    rationale = 'An explicit Research Agent mention requests a research response.';
  } else if (mentioned || input.parentMessageId) {
    intent = 'conversation';
    confidence = mentioned ? 1 : 0.8;
    rationale = mentioned
      ? 'An explicit Agent mention requests a conversational response.'
      : 'The Message continues an existing Shared Agent Channel thread.';
  }
  return { intent, targetAgentId: mentioned?.id ?? null, confidence, policyVersion: POLICY_VERSION, rationale };
}

export async function correctMessageIntent(
  pool: Pool,
  access: WorkspaceAccess,
  messageId: string,
  correction: { intent: MessageIntent; targetAgentId?: string | null }
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
       WHERE member.workspace_id = $1 AND membership.id = $2
         AND membership.revoked_at IS NULL`,
      [access.workspace.id, access.membership.id]
    );
    if (!actor.rows[0]) throw new MessageIntentError('active Pilot membership is required');
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
        correction.targetAgentId ?? null]
    );
    if (updated.rowCount !== 1) throw new MessageIntentError('Message routing decision was not found');
    await client.query(
      `INSERT INTO public.audit_event (
         workspace_id, actor_user_id, actor_membership_id,
         event_type, subject_type, subject_id, evidence
       ) VALUES ($1, $2, $3, 'message.intent.corrected', 'message', $4,
         jsonb_build_object('intent', $5::text, 'targetAgentId', $6::text))`,
      [access.workspace.id, access.identity.userId, access.membership.id,
        messageId, correction.intent, correction.targetAgentId ?? null]
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
): Promise<void> {
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
  if (!projectId || surface.rows[0]?.author_kind !== 'pilot') return;

  const agents = await client.query<{
    id: string;
    name: string;
    agent_type: 'engineering' | 'research' | 'product' | 'support' | 'general';
  }>(
    `SELECT agent.id, agent.name, agent.agent_type
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
    agents: agents.rows.map((agent) => ({ id: agent.id, name: agent.name, agentType: agent.agent_type }))
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
}
