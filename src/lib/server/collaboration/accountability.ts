import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import type { WorkspaceAccess } from '../authentication/authorization.js';

export class AccountabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountabilityError';
  }
}

type CollaborationSignalType =
  | 'recursive_handoff_attempt'
  | 'duplicate_investigation'
  | 'unsupported_certainty'
  | 'routing_disagreement';

type EvaluationOutcome = 'completed' | 'failed' | 'cancelled' | 'expired' | 'rejected';
type FeedbackRating = 'useful' | 'incorrect' | 'incomplete' | 'unnecessarily_delegated';

export interface CollaborationEvaluationAttribution {
  agentType: string;
  routingPolicyVersion: string;
  promptVersion: string;
  permissionPolicyVersion: string;
  agentConfigurationVersion: string;
}

interface CollaborationEvaluationAttributionRow {
  agent_type: string;
  routing_policy_version: string;
  prompt_version: string;
  permission_policy_version: string;
  agent_configuration_version: string;
}

function mapCollaborationEvaluationAttribution(
  row: CollaborationEvaluationAttributionRow
): CollaborationEvaluationAttribution {
  return {
    agentType: row.agent_type,
    routingPolicyVersion: row.routing_policy_version,
    promptVersion: row.prompt_version,
    permissionPolicyVersion: row.permission_policy_version,
    agentConfigurationVersion: row.agent_configuration_version
  };
}

export interface CollaborationEvaluationFixture {
  id: string;
  attribution: CollaborationEvaluationAttribution;
  handoffDepths: number[];
  findings: Array<{ id: string; summary: string; confidence: number; evidenceReferences: string[] }>;
  routingDecisions: Array<{ id: string; selectedIntent: string; correctedIntent: string | null }>;
  outcomes: readonly EvaluationOutcome[];
  pilotFeedback: readonly FeedbackRating[];
}

const RESTRICTED_EVALUATION_MATERIAL = [
  /"(?:authorization|api[ _-]?key|password|secret|token|credential|private[ _-]?key|encrypted_reasoning|provider(?: event)? trace)"\s*:/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\b(?:sk|ghp)_[A-Za-z0-9_-]{12,}\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{12,}\b/u,
  /\bAKIA[A-Z0-9]{16}\b/u,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/iu,
  /\bauthorization\s*:\s*(?:basic|bearer)\s+\S+/iu,
  /\b(?:api[ _-]?key|password|secret|token)\s*[:=]\s*\S{8,}/iu,
  /\b(?:credentialStoreReference|providerEventId|encrypted_reasoning)\b/u,
  /\b(?:chain[ -]of[ -]thought|private reasoning|hidden reasoning)\b/iu
];

export function normalizeCollaborationEvaluationText(value: string): string {
  const normalized = value.trim();
  if (RESTRICTED_EVALUATION_MATERIAL.some((pattern) => pattern.test(normalized))) {
    throw new AccountabilityError('Evaluation data must not contain credentials or private reasoning');
  }
  return normalized;
}

export function normalizeCollaborationEvaluationEvidence(
  evidence: Record<string, unknown>
): Record<string, unknown> {
  if (!evidence || Array.isArray(evidence) || Object.getPrototypeOf(evidence) !== Object.prototype) {
    throw new AccountabilityError('Evaluation evidence must be an object');
  }
  let encoded: string;
  try { encoded = JSON.stringify(evidence); } catch {
    throw new AccountabilityError('Evaluation evidence must be JSON serializable');
  }
  if (encoded.length > 16_000) throw new AccountabilityError('Evaluation evidence exceeds its safe limit');
  if (RESTRICTED_EVALUATION_MATERIAL.some((pattern) => pattern.test(encoded))) {
    throw new AccountabilityError('Evaluation evidence must not contain credentials or private reasoning');
  }
  return structuredClone(evidence);
}

function countValues<T extends string>(values: readonly T[]): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function deltas<T extends string>(
  baseline: Partial<Record<T, number>>,
  candidate: Partial<Record<T, number>>,
  order: readonly T[]
): Partial<Record<T, number>> {
  const result: Partial<Record<T, number>> = {};
  for (const key of order) {
    const delta = (candidate[key] ?? 0) - (baseline[key] ?? 0);
    if (delta !== 0) result[key] = delta;
  }
  return result;
}

export function compareCollaborationEvaluationFixtures(
  baseline: CollaborationEvaluationFixture,
  candidate: CollaborationEvaluationFixture
) {
  const baselineSignals = countValues(detectCollaborationQualitySignals(baseline).map(({ type }) => type));
  const candidateSignals = countValues(detectCollaborationQualitySignals(candidate).map(({ type }) => type));
  return {
    baselineFixtureId: baseline.id,
    candidateFixtureId: candidate.id,
    baselineAttribution: baseline.attribution,
    candidateAttribution: candidate.attribution,
    deltas: {
      automatedSignals: deltas<CollaborationSignalType>(baselineSignals, candidateSignals, [
        'recursive_handoff_attempt', 'duplicate_investigation',
        'unsupported_certainty', 'routing_disagreement'
      ]),
      completionOutcomes: deltas<EvaluationOutcome>(
        countValues(baseline.outcomes), countValues(candidate.outcomes),
        ['completed', 'failed', 'cancelled', 'expired', 'rejected']
      ),
      pilotFeedback: deltas<FeedbackRating>(
        countValues(baseline.pilotFeedback), countValues(candidate.pilotFeedback),
        ['useful', 'incorrect', 'incomplete', 'unnecessarily_delegated']
      )
    }
  };
}

export function detectCollaborationQualitySignals(input: {
  handoffDepths: number[];
  findings: Array<{ id: string; summary: string; confidence: number; evidenceReferences: string[] }>;
  routingDecisions: Array<{ id: string; selectedIntent: string; correctedIntent: string | null }>;
}): Array<{ type: CollaborationSignalType; outcomeId: string }> {
  const signals: Array<{ type: CollaborationSignalType; outcomeId: string }> = [];
  if (input.handoffDepths.some((depth) => depth > 1)) {
    signals.push({ type: 'recursive_handoff_attempt', outcomeId: 'handoff-policy' });
  }
  const seen = new Map<string, string>();
  for (const finding of input.findings) {
    const key = finding.summary.trim().toLocaleLowerCase();
    if (seen.has(key)) signals.push({ type: 'duplicate_investigation', outcomeId: finding.id });
    else seen.set(key, finding.id);
  }
  const unsupported = input.findings.find((finding) =>
    finding.confidence >= 0.8 && finding.evidenceReferences.length === 0
  );
  if (unsupported) signals.push({ type: 'unsupported_certainty', outcomeId: unsupported.id });
  const disagreement = input.routingDecisions.find((decision) =>
    decision.correctedIntent !== null && decision.correctedIntent !== decision.selectedIntent
  );
  if (disagreement) signals.push({ type: 'routing_disagreement', outcomeId: disagreement.id });
  return signals;
}

export interface AgentInboxItem {
  id: string;
  agentId: string;
  agentName: string;
  state: 'queued' | 'active' | 'waiting' | 'blocked' | 'review_ready' | 'completed';
  kind: 'task' | 'handoff' | 'coordination_step';
  sourceMessageId: string;
  relatedId: string;
  summary: string;
  requiresHumanAction: boolean;
  urgency: 'high' | 'normal' | 'low';
}

interface VisibleCoordinationStep {
  id: string;
  key: string;
  agentId: string;
  agentName: string;
  instruction: string;
  dependencies: string[];
  expectedOutput: 'concise_text' | 'structured_finding' | 'artifact';
  status: string;
  resultMessageId: string | null;
  artifactId: string | null;
}

export async function loadCollaborationAccountability(
  pool: Pool,
  access: WorkspaceAccess,
  projectId: string
) {
  const membership = await pool.query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM public.workspace_member member
       JOIN public.workspace_membership membership ON membership.id = member.pilot_membership_id
       JOIN public.project_membership project_member ON project_member.workspace_member_id = member.id
       WHERE member.workspace_id = $1 AND membership.id = $2
         AND membership.revoked_at IS NULL AND project_member.project_id = $3
     ) AS allowed`,
    [access.workspace.id, access.membership.id, projectId]
  );
  if (!membership.rows[0]?.allowed) throw new AccountabilityError('active Project membership is required');
  await purgeExpiredCollaborationEvaluation(pool, access.workspace.id, projectId);

  const [steering, memory, plans, findings, inbox, capacity, evaluation] = await Promise.all([
    pool.query<{
      id: string; agent_run_id: string; source_message_id: string; guidance: string;
      ordinal: number; status: 'pending' | 'delivered' | 'cancelled'; supplied_by: string;
      created_at: Date;
    }>(
      `SELECT steering.id, steering.agent_run_id, steering.source_message_id,
              steering.guidance, steering.ordinal, steering.status,
              pilot_user.name AS supplied_by, steering.created_at
       FROM public.agent_run_steering steering
       JOIN public.workspace_member member ON member.id = steering.supplied_by_workspace_member_id
       JOIN public.workspace_membership membership ON membership.id = member.pilot_membership_id
       JOIN auth."user" pilot_user ON pilot_user.id = membership.user_id
       WHERE steering.workspace_id = $1 AND steering.project_id = $2
       ORDER BY steering.created_at, steering.id`,
      [access.workspace.id, projectId]
    ),
    pool.query<{
      id: string; memory_type: string; statement: string; source_references: string[];
      lifecycle: string; supersedes_id: string | null; author_name: string; created_at: Date;
    }>(
      `SELECT memory.id, memory.memory_type, memory.statement, memory.source_references,
              memory.lifecycle, memory.supersedes_id,
              COALESCE(pilot_user.name, agent.name) AS author_name, memory.created_at
       FROM public.project_memory memory
       JOIN public.workspace_member author ON author.id = memory.author_workspace_member_id
       LEFT JOIN public.workspace_membership pilot ON pilot.id = author.pilot_membership_id
       LEFT JOIN auth."user" pilot_user ON pilot_user.id = pilot.user_id
       LEFT JOIN public.agent agent ON agent.id = author.agent_id
       WHERE memory.workspace_id = $1 AND memory.project_id = $2
       ORDER BY memory.created_at, memory.id`,
      [access.workspace.id, projectId]
    ),
    pool.query<{
      id: string; source_message_id: string; goal: string; constraints: string[]; status: string; allow_parallel: boolean;
      max_participants: number; max_handoffs: number; max_depth: number; max_agent_runs: number;
      max_elapsed_seconds: number; provider_usage_limit: string | null;
      provider_usage_consumed: string | null; provider_usage_known: boolean;
      steps: VisibleCoordinationStep[]; consumed_handoffs: number;
      constraint_inputs: Array<{
        id: string; sourceMessageId: string; guidance: string; ordinal: number;
        status: 'pending' | 'delivered'; deliveryConversationTurnId: string | null;
        suppliedBy: string; createdAt: string;
      }>;
    }>(
      `SELECT plan.id, plan.source_message_id, plan.goal, plan.constraints, plan.status, plan.allow_parallel,
              plan.max_participants, plan.max_handoffs, plan.max_depth, plan.max_agent_runs,
              plan.max_elapsed_seconds, plan.provider_usage_limit,
              plan.provider_usage_consumed, plan.provider_usage_known,
              COALESCE(jsonb_agg(jsonb_build_object(
                'id', step.id, 'key', step.step_key, 'agentId', step.target_agent_id,
                'agentName', agent.name, 'instruction', step.instruction,
                'dependencies', step.dependencies, 'expectedOutput', step.expected_output,
                'status', step.status, 'resultMessageId', step.result_message_id,
                'artifactId', step.artifact_id
              ) ORDER BY step.position, step.id) FILTER (WHERE step.id IS NOT NULL), '[]') AS steps,
              (SELECT count(*)::integer FROM public.coordination_budget_reservation reservation
               WHERE reservation.plan_id = plan.id AND reservation.reservation_kind = 'handoff') AS consumed_handoffs,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'id', constraint_input.id,
                  'sourceMessageId', constraint_input.source_message_id,
                  'guidance', constraint_input.guidance,
                  'ordinal', constraint_input.ordinal,
                  'status', constraint_input.status,
                  'deliveryConversationTurnId', constraint_input.delivery_conversation_turn_id,
                  'suppliedBy', pilot_user.name,
                  'createdAt', constraint_input.created_at
                ) ORDER BY constraint_input.ordinal)
                FROM public.coordination_plan_constraint constraint_input
                JOIN public.workspace_member supplied_by
                  ON supplied_by.id = constraint_input.supplied_by_workspace_member_id
                JOIN public.workspace_membership pilot
                  ON pilot.id = supplied_by.pilot_membership_id
                JOIN auth."user" pilot_user ON pilot_user.id = pilot.user_id
                WHERE constraint_input.plan_id = plan.id
              ), '[]') AS constraint_inputs
       FROM public.coordination_plan plan
       LEFT JOIN public.coordination_plan_step step ON step.plan_id = plan.id
       LEFT JOIN public.agent agent ON agent.id = step.target_agent_id
       WHERE plan.workspace_id = $1 AND plan.project_id = $2
       GROUP BY plan.id ORDER BY plan.created_at, plan.id`,
      [access.workspace.id, projectId]
    ),
    pool.query<{
      id: string; result_message_id: string | null; source_handoff_id: string | null;
      summary: string; confidence: string; observed_evidence: string[]; inferences: string[];
      assumptions: string[]; open_questions: string[]; evidence_count: number;
      evidence: Array<{ type: string; stableReference: string; title: string; retrievedAt: string; claim: string; accessible: boolean }>;
    }>(
      `SELECT finding.id, finding.result_message_id, finding.source_handoff_id,
              finding.summary, finding.confidence, finding.observed_evidence,
              finding.inferences, finding.assumptions, finding.open_questions,
              count(evidence.id)::integer AS evidence_count,
              COALESCE(jsonb_agg(jsonb_build_object(
                'type', evidence.evidence_type, 'stableReference', evidence.stable_reference,
                'title', evidence.title, 'retrievedAt', evidence.retrieved_at,
                'claim', evidence.claim, 'accessible', evidence.accessible
              ) ORDER BY evidence.created_at, evidence.id)
                FILTER (WHERE evidence.id IS NOT NULL), '[]') AS evidence
       FROM public.agent_finding finding
       LEFT JOIN public.finding_evidence evidence ON evidence.finding_id = finding.id
       WHERE finding.workspace_id = $1 AND finding.project_id = $2
       GROUP BY finding.id ORDER BY finding.created_at, finding.id`,
      [access.workspace.id, projectId]
    ),
    pool.query<{
      id: string; agent_id: string; agent_name: string; state: AgentInboxItem['state'];
      kind: AgentInboxItem['kind']; source_message_id: string; related_id: string;
      summary: string; requires_human_action: boolean;
    }>(
      `SELECT * FROM (
         SELECT run.id, task.assigned_agent_id AS agent_id, agent.name AS agent_name,
           CASE WHEN run.status = 'queued' THEN 'queued'
                WHEN run.status IN ('planning', 'working', 'recovering') THEN 'active'
                WHEN run.status IN ('waiting_for_input', 'waiting_for_approval', 'paused') THEN 'waiting'
                WHEN run.status = 'completed' THEN 'review_ready'
                ELSE 'completed' END AS state,
           'task'::text AS kind, task.source_message_id, task.id AS related_id,
           task.request_snapshot AS summary,
           run.status IN ('waiting_for_input', 'waiting_for_approval', 'paused') AS requires_human_action,
           run.created_at
         FROM public.task task JOIN public.agent_run run ON run.task_id = task.id
         JOIN public.agent agent ON agent.id = task.assigned_agent_id
         WHERE task.workspace_id = $1 AND task.project_id = $2
         UNION ALL
         SELECT handoff.id, handoff.target_agent_id, agent.name,
           CASE WHEN handoff.status = 'queued' THEN 'queued' WHEN handoff.status = 'working' THEN 'active'
                WHEN handoff.status = 'completed' THEN 'completed' ELSE 'blocked' END,
           'handoff', handoff.source_message_id, handoff.id, handoff.question,
           handoff.status IN ('failed', 'expired'), handoff.created_at
         FROM public.agent_handoff handoff JOIN public.agent agent ON agent.id = handoff.target_agent_id
         WHERE handoff.workspace_id = $1 AND handoff.project_id = $2
         UNION ALL
         SELECT step.id, step.target_agent_id, agent.name,
           CASE WHEN step.status IN ('pending', 'ready') THEN 'queued'
                WHEN step.status = 'active' THEN 'active'
                WHEN step.status = 'completed' THEN 'completed' ELSE 'blocked' END,
           'coordination_step', plan.source_message_id, step.plan_id, step.instruction,
           plan.status IN ('proposed', 'paused') OR step.status IN ('blocked', 'failed'), step.created_at
         FROM public.coordination_plan_step step
         JOIN public.coordination_plan plan ON plan.id = step.plan_id
         JOIN public.agent agent ON agent.id = step.target_agent_id
         WHERE step.workspace_id = $1 AND step.project_id = $2
       ) items ORDER BY created_at, id`,
      [access.workspace.id, projectId]
    ),
    pool.query<{
      agent_id: string; active_work: number; enabled: boolean; provider_ready: boolean;
    }>(
      `SELECT agent.id AS agent_id,
              count(*) FILTER (WHERE work.active)::integer AS active_work,
              agent.enabled AND agent.status <> 'disabled' AS enabled,
              COALESCE(bool_or(provider.status = 'ready'), false) AS provider_ready
       FROM public.agent agent
       LEFT JOIN public.provider_connection provider ON provider.workspace_id = agent.workspace_id
       LEFT JOIN LATERAL (
         SELECT true AS active FROM public.agent_run run
         WHERE run.agent_id = agent.id AND run.status NOT IN ('completed', 'failed', 'cancelled')
         UNION ALL
         SELECT true FROM public.agent_conversation conversation
         JOIN public.agent_conversation_turn turn ON turn.conversation_id = conversation.id
         WHERE conversation.agent_id = agent.id AND turn.status IN ('queued', 'working')
       ) work ON true
       WHERE agent.workspace_id = $1
         AND EXISTS (
           SELECT 1 FROM public.workspace_member member
           JOIN public.project_membership project_member ON project_member.workspace_member_id = member.id
           WHERE member.agent_id = agent.id AND project_member.project_id = $2
         )
       GROUP BY agent.id, agent.enabled, agent.status
       ORDER BY agent.id`,
      [access.workspace.id, projectId]
    ),
    pool.query<CollaborationEvaluationAttributionRow & {
      event_count: number; policy_rejections: number; overrides: number;
      recursive_handoff_attempts: number; duplicate_investigations: number;
      unsupported_certainty: number; routing_disagreements: number;
      completed_outcomes: number; failed_outcomes: number; cancelled_outcomes: number;
      expired_outcomes: number; rejected_outcomes: number;
      useful: number; incorrect: number; incomplete: number; unnecessarily_delegated: number;
    }>(
      `WITH event_rollup AS (
         SELECT event.agent_type,
                event.routing_policy_version, event.prompt_version,
                event.permission_policy_version, event.agent_configuration_version,
                count(*)::integer AS event_count,
                count(*) FILTER (WHERE event.event_type = 'policy.rejected')::integer AS policy_rejections,
                count(*) FILTER (WHERE event.event_type = 'pilot.override')::integer AS overrides,
                count(*) FILTER (WHERE event.event_type = 'recursive.handoff_attempt')::integer AS recursive_handoff_attempts,
                count(*) FILTER (WHERE event.event_type = 'duplicate.investigation')::integer AS duplicate_investigations,
                count(*) FILTER (WHERE event.event_type = 'unsupported.certainty')::integer AS unsupported_certainty,
                count(*) FILTER (WHERE event.event_type = 'routing.disagreement')::integer AS routing_disagreements,
                count(*) FILTER (WHERE event.event_type = 'outcome.completed')::integer AS completed_outcomes,
                count(*) FILTER (WHERE event.event_type = 'outcome.failed')::integer AS failed_outcomes,
                count(*) FILTER (WHERE event.event_type = 'outcome.cancelled')::integer AS cancelled_outcomes,
                count(*) FILTER (WHERE event.event_type = 'outcome.expired')::integer AS expired_outcomes,
                count(*) FILTER (WHERE event.event_type = 'outcome.rejected')::integer AS rejected_outcomes
         FROM public.collaboration_evaluation_event event
         WHERE event.workspace_id = $1 AND event.project_id = $2 AND event.expires_at > now()
         GROUP BY event.agent_type, event.routing_policy_version, event.prompt_version,
                  event.permission_policy_version, event.agent_configuration_version
       ), feedback_rollup AS (
         SELECT feedback.agent_type,
                feedback.routing_policy_version, feedback.prompt_version,
                feedback.permission_policy_version, feedback.agent_configuration_version,
                count(*) FILTER (WHERE feedback.rating = 'useful')::integer AS useful,
                count(*) FILTER (WHERE feedback.rating = 'incorrect')::integer AS incorrect,
                count(*) FILTER (WHERE feedback.rating = 'incomplete')::integer AS incomplete,
                count(*) FILTER (WHERE feedback.rating = 'unnecessarily_delegated')::integer AS unnecessarily_delegated
         FROM public.collaboration_feedback feedback
         WHERE feedback.workspace_id = $1 AND feedback.project_id = $2 AND feedback.expires_at > now()
         GROUP BY feedback.agent_type, feedback.routing_policy_version, feedback.prompt_version,
                  feedback.permission_policy_version, feedback.agent_configuration_version
       ), report_keys AS (
         SELECT agent_type, routing_policy_version, prompt_version,
                permission_policy_version, agent_configuration_version FROM event_rollup
         UNION
         SELECT agent_type, routing_policy_version, prompt_version,
                permission_policy_version, agent_configuration_version FROM feedback_rollup
       )
       SELECT report_keys.*,
              COALESCE(event.event_count, 0)::integer AS event_count,
              COALESCE(event.policy_rejections, 0)::integer AS policy_rejections,
              COALESCE(event.overrides, 0)::integer AS overrides,
              COALESCE(event.recursive_handoff_attempts, 0)::integer AS recursive_handoff_attempts,
              COALESCE(event.duplicate_investigations, 0)::integer AS duplicate_investigations,
              COALESCE(event.unsupported_certainty, 0)::integer AS unsupported_certainty,
              COALESCE(event.routing_disagreements, 0)::integer AS routing_disagreements,
              COALESCE(event.completed_outcomes, 0)::integer AS completed_outcomes,
              COALESCE(event.failed_outcomes, 0)::integer AS failed_outcomes,
              COALESCE(event.cancelled_outcomes, 0)::integer AS cancelled_outcomes,
              COALESCE(event.expired_outcomes, 0)::integer AS expired_outcomes,
              COALESCE(event.rejected_outcomes, 0)::integer AS rejected_outcomes,
              COALESCE(feedback.useful, 0)::integer AS useful,
              COALESCE(feedback.incorrect, 0)::integer AS incorrect,
              COALESCE(feedback.incomplete, 0)::integer AS incomplete,
              COALESCE(feedback.unnecessarily_delegated, 0)::integer AS unnecessarily_delegated
       FROM report_keys
       LEFT JOIN event_rollup event USING (
         agent_type, routing_policy_version, prompt_version,
         permission_policy_version, agent_configuration_version
       )
       LEFT JOIN feedback_rollup feedback USING (
         agent_type, routing_policy_version, prompt_version,
         permission_policy_version, agent_configuration_version
       )
       ORDER BY agent_type, routing_policy_version, prompt_version,
                permission_policy_version, agent_configuration_version`,
      [access.workspace.id, projectId]
    )
  ]);

  return {
    steering: steering.rows.map((row) => ({
      id: row.id, agentRunId: row.agent_run_id, sourceMessageId: row.source_message_id,
      guidance: row.guidance, ordinal: row.ordinal, status: row.status,
      suppliedBy: row.supplied_by, createdAt: row.created_at.toISOString()
    })),
    plans: plans.rows.map((row) => ({
      id: row.id, sourceMessageId: row.source_message_id, goal: row.goal,
      constraints: row.constraints, status: row.status, allowParallel: row.allow_parallel, steps: row.steps,
      constraintInputs: row.constraint_inputs,
      budget: {
        maxParticipants: row.max_participants, maxHandoffs: row.max_handoffs,
        consumedHandoffs: row.consumed_handoffs, maxDepth: row.max_depth,
        maxAgentRuns: row.max_agent_runs, maxElapsedSeconds: row.max_elapsed_seconds,
        providerUsage: row.provider_usage_known
          ? { known: true, consumed: Number(row.provider_usage_consumed), limit: row.provider_usage_limit === null ? null : Number(row.provider_usage_limit) }
          : { known: false, consumed: null, limit: row.provider_usage_limit === null ? null : Number(row.provider_usage_limit) }
      }
    })),
    findings: findings.rows.map((row) => ({
      id: row.id, resultMessageId: row.result_message_id, sourceHandoffId: row.source_handoff_id,
      summary: row.summary, confidence: Number(row.confidence), observedEvidence: row.observed_evidence,
      inferences: row.inferences, assumptions: row.assumptions, openQuestions: row.open_questions,
      evidence: row.evidence, evidenceCount: row.evidence_count,
      evidenceStrength: row.evidence_count === 0 ? 'missing' : 'supported'
    })),
    memory: memory.rows.map((row) => ({
      id: row.id, type: row.memory_type, statement: row.statement,
      sourceReferences: row.source_references, lifecycle: row.lifecycle,
      supersedesId: row.supersedes_id, authorName: row.author_name,
      createdAt: row.created_at.toISOString()
    })),
    inbox: inbox.rows.map((row): AgentInboxItem => ({
      id: row.id, agentId: row.agent_id, agentName: row.agent_name, state: row.state,
      kind: row.kind, sourceMessageId: row.source_message_id, relatedId: row.related_id,
      summary: row.summary, requiresHumanAction: row.requires_human_action,
      urgency: row.requires_human_action ? 'high'
        : ['queued', 'active', 'blocked', 'review_ready'].includes(row.state) ? 'normal' : 'low'
    })),
    capacity: capacity.rows.map((row) => ({
      agentId: row.agent_id,
      activeWork: row.active_work,
      available: row.enabled && row.provider_ready && row.active_work === 0,
      reason: !row.enabled ? 'disabled' : !row.provider_ready ? 'provider_unavailable'
        : row.active_work > 0 ? 'occupied' : 'available'
    })),
    evaluation: evaluation.rows.map((row) => ({
      ...mapCollaborationEvaluationAttribution(row),
      eventCount: row.event_count, policyRejections: row.policy_rejections, overrides: row.overrides,
      automatedChecks: {
        recursiveHandoffAttempts: row.recursive_handoff_attempts,
        duplicateInvestigations: row.duplicate_investigations,
        unsupportedCertainty: row.unsupported_certainty,
        routingDisagreements: row.routing_disagreements
      },
      completionOutcomes: {
        completed: row.completed_outcomes, failed: row.failed_outcomes,
        cancelled: row.cancelled_outcomes, expired: row.expired_outcomes, rejected: row.rejected_outcomes
      },
      pilotFeedback: {
        useful: row.useful, incorrect: row.incorrect, incomplete: row.incomplete,
        unnecessarilyDelegated: row.unnecessarily_delegated
      }
    }))
  };
}

export async function purgeExpiredCollaborationEvaluation(
  pool: Pool,
  workspaceId: string,
  projectId: string
): Promise<void> {
  await pool.query(
    'SELECT public.purge_expired_collaboration_evaluation($1, $2)',
    [workspaceId, projectId]
  );
}

export async function submitCollaborationFeedback(
  pool: Pool,
  access: WorkspaceAccess,
  input: {
    projectId: string; outcomeType: 'message' | 'handoff' | 'agent_run' | 'finding' | 'coordination_plan';
    outcomeId: string; rating: 'useful' | 'incorrect' | 'incomplete' | 'unnecessarily_delegated';
    reason?: string;
  }
): Promise<void> {
  if (!['message', 'handoff', 'agent_run', 'finding', 'coordination_plan'].includes(input.outcomeType)
    || !['useful', 'incorrect', 'incomplete', 'unnecessarily_delegated'].includes(input.rating)) {
    throw new AccountabilityError('Feedback target or rating is invalid');
  }
  const reason = input.reason ? normalizeCollaborationEvaluationText(input.reason) || null : null;
  if (reason && reason.length > 1000) throw new AccountabilityError('Feedback reason is too long');
  const actor = await pool.query<{ id: string }>(
    `SELECT member.id FROM public.workspace_member member
     JOIN public.workspace_membership membership ON membership.id = member.pilot_membership_id
     JOIN public.project_membership project_member ON project_member.workspace_member_id = member.id
     WHERE member.workspace_id = $1 AND membership.id = $2 AND membership.revoked_at IS NULL
       AND project_member.project_id = $3`,
    [access.workspace.id, access.membership.id, input.projectId]
  );
  if (!actor.rows[0]) throw new AccountabilityError('active Project membership is required');
  const targetTable = {
    message: `public.message target JOIN public.channel target_channel ON target_channel.id = target.channel_id`,
    handoff: 'public.agent_handoff target', agent_run: 'public.agent_run target JOIN public.task target_task ON target_task.id = target.task_id',
    finding: 'public.agent_finding target', coordination_plan: 'public.coordination_plan target'
  }[input.outcomeType];
  const projectPredicate = input.outcomeType === 'message'
    ? 'target_channel.project_id = $3'
    : input.outcomeType === 'agent_run' ? 'target_task.project_id = $3' : 'target.project_id = $3';
  const targetAgent = {
    message: `(SELECT author.agent_id FROM public.workspace_member author
               WHERE author.id = target.author_workspace_member_id
                 AND author.workspace_id = target.workspace_id)`,
    handoff: 'target.target_agent_id', agent_run: 'target.agent_id',
    finding: 'target.author_agent_id', coordination_plan: 'target.coordinating_agent_id'
  }[input.outcomeType];
  const target = await pool.query<CollaborationEvaluationAttributionRow & { agent_id: string | null }>(
    `SELECT ${targetAgent} AS agent_id,
            COALESCE(attribution.agent_type, agent.agent_type, 'unattributed') AS agent_type,
            COALESCE(attribution.routing_policy_version, 'not-applicable-v1') AS routing_policy_version,
            COALESCE(attribution.prompt_version, 'not-applicable-v1') AS prompt_version,
            COALESCE(attribution.permission_policy_version, 'not-applicable-v1') AS permission_policy_version,
            COALESCE(attribution.agent_configuration_version,
              CASE WHEN ${targetAgent} IS NULL THEN 'unattributed-v1'
                   ELSE 'agent-config-' || COALESCE(agent.configuration_version, 1)::text END
            ) AS agent_configuration_version
     FROM ${targetTable}
     LEFT JOIN public.agent agent ON agent.id = ${targetAgent} AND agent.workspace_id = target.workspace_id
     LEFT JOIN LATERAL (
       SELECT event.agent_type, event.routing_policy_version, event.prompt_version,
              event.permission_policy_version, event.agent_configuration_version
       FROM public.collaboration_evaluation_event event
       WHERE event.workspace_id = target.workspace_id AND event.project_id = $3
         AND event.outcome_type = $4 AND event.outcome_id = target.id
       ORDER BY event.created_at DESC, event.id DESC LIMIT 1
     ) attribution ON true
     WHERE target.id = $1 AND target.workspace_id = $2 AND ${projectPredicate}`,
    [input.outcomeId, access.workspace.id, input.projectId, input.outcomeType]
  );
  const attribution = target.rows[0];
  if (!attribution) throw new AccountabilityError('Feedback outcome is outside the Project');
  await pool.query(
    `INSERT INTO public.collaboration_feedback (
       id, workspace_id, project_id, submitted_by_workspace_member_id,
       outcome_type, outcome_id, rating, reason, agent_id, agent_type,
       routing_policy_version, prompt_version, permission_policy_version,
       agent_configuration_version
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (submitted_by_workspace_member_id, outcome_type, outcome_id)
     DO UPDATE SET rating = EXCLUDED.rating, reason = EXCLUDED.reason,
       agent_id = EXCLUDED.agent_id,
       agent_type = EXCLUDED.agent_type,
       routing_policy_version = EXCLUDED.routing_policy_version,
       prompt_version = EXCLUDED.prompt_version,
       permission_policy_version = EXCLUDED.permission_policy_version,
       agent_configuration_version = EXCLUDED.agent_configuration_version,
       created_at = now(), expires_at = DEFAULT`,
    [randomUUID(), access.workspace.id, input.projectId, actor.rows[0].id,
      input.outcomeType, input.outcomeId, input.rating, reason, attribution.agent_id,
      attribution.agent_type,
      attribution.routing_policy_version, attribution.prompt_version,
      attribution.permission_policy_version, attribution.agent_configuration_version]
  );
}
