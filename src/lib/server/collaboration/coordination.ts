import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import type { WorkspaceAccess } from '../authentication/authorization.js';
import { renderCoordinationSynthesis } from '../../coordination-presentation.js';
import { recordCollaborationEvaluationEvent } from './evaluation.js';

export interface CoordinationBudget {
  maxParticipants: number;
  maxHandoffs: number;
  maxDepth: number;
  maxAgentRuns: number;
  maxElapsedSeconds: number;
  providerUsageLimit?: number;
}

export interface WorkspaceCoordinationPolicyInput extends CoordinationBudget {
  parallelPermitted: boolean;
}

const COORDINATION_OUTPUT_TYPES = [
  'concise_text',
  'structured_finding',
  'artifact'
] as const;

type CoordinationOutputType = typeof COORDINATION_OUTPUT_TYPES[number];

export interface CoordinationStepInput {
  key: string;
  agentId: string;
  instruction: string;
  dependencies: string[];
  expectedOutput?: CoordinationOutputType;
  artifactId?: string;
}

export interface CoordinationPlanInput {
  goal: string;
  constraints?: string[];
  allowParallel: boolean;
  budget: CoordinationBudget;
  steps: CoordinationStepInput[];
}

const COORDINATION_OUTPUT_TYPE_SET = new Set<CoordinationOutputType>(COORDINATION_OUTPUT_TYPES);

export class CoordinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoordinationError';
  }
}

const OPERATOR_LIMITS: CoordinationBudget = {
  maxParticipants: 8,
  maxHandoffs: 20,
  maxDepth: 1,
  maxAgentRuns: 0,
  maxElapsedSeconds: 86_400
};

function integerWithin(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CoordinationError(`${label} exceeds the operator limit`);
  }
  return value;
}

function normalizeCoordinationBudget(input: CoordinationBudget): CoordinationBudget {
  if (input.maxAgentRuns !== 0) {
    throw new CoordinationError(
      'AgentRun limit must be zero because Coordination cannot create AgentRuns; Engineering delegation is independent'
    );
  }
  return {
    maxParticipants: integerWithin(input.maxParticipants, 1, OPERATOR_LIMITS.maxParticipants, 'Participant budget'),
    maxHandoffs: integerWithin(input.maxHandoffs, 0, OPERATOR_LIMITS.maxHandoffs, 'Handoff budget'),
    maxDepth: integerWithin(input.maxDepth, 0, OPERATOR_LIMITS.maxDepth, 'Handoff depth'),
    maxAgentRuns: integerWithin(input.maxAgentRuns, 0, OPERATOR_LIMITS.maxAgentRuns, 'AgentRun budget'),
    maxElapsedSeconds: integerWithin(input.maxElapsedSeconds, 60, OPERATOR_LIMITS.maxElapsedSeconds, 'Elapsed-time budget'),
    ...(input.providerUsageLimit === undefined
      ? {}
      : Number.isFinite(input.providerUsageLimit) && input.providerUsageLimit >= 0
        ? { providerUsageLimit: input.providerUsageLimit }
        : (() => { throw new CoordinationError('Provider usage budget is invalid'); })())
  };
}

async function assertWithinCurrentCoordinationPolicy(
  client: PoolClient,
  workspaceId: string,
  plan: CoordinationPlanInput
): Promise<void> {
  const policy = await client.query<{ allowed: boolean }>(
    `SELECT ($2 <= default_max_participants
        AND $3 <= default_max_handoffs
        AND $4 <= default_max_depth
        AND $5 <= default_max_agent_runs
        AND $6 <= default_max_elapsed_seconds
        AND (NOT $8 OR workspace_policy.parallel_permitted)
        AND (default_provider_usage_limit IS NULL
          OR ($7::numeric IS NOT NULL AND $7 <= default_provider_usage_limit))
        AND (provider.coordination_provider_usage_limit IS NULL
          OR ($7::numeric IS NOT NULL
            AND $7 <= provider.coordination_provider_usage_limit))) AS allowed
     FROM public.workspace_coordination_policy workspace_policy
     JOIN public.provider_connection provider ON provider.workspace_id = workspace_policy.workspace_id
     WHERE workspace_policy.workspace_id = $1 FOR UPDATE OF workspace_policy, provider`,
    [workspaceId, plan.budget.maxParticipants, plan.budget.maxHandoffs,
      plan.budget.maxDepth, plan.budget.maxAgentRuns, plan.budget.maxElapsedSeconds,
      plan.budget.providerUsageLimit ?? null, plan.allowParallel]
  );
  if (!policy.rows[0]?.allowed) {
    throw new CoordinationError('Coordination plan exceeds Workspace defaults');
  }
}

export function normalizeCoordinationPlan(input: CoordinationPlanInput): CoordinationPlanInput {
  const goal = input?.goal?.trim();
  if (!goal || goal.length > 4000) throw new CoordinationError('Coordination goal is required');
  if (!Array.isArray(input.steps) || input.steps.length === 0 || input.steps.length > 20) {
    throw new CoordinationError('Coordination plan requires between 1 and 20 steps');
  }
  if (input.budget.maxDepth > 1) {
    throw new CoordinationError('Coordination handoff depth cannot exceed 1');
  }
  const budget = normalizeCoordinationBudget(input.budget);
  if (input.allowParallel && budget.providerUsageLimit !== undefined) {
    throw new CoordinationError('Provider-usage-limited coordination must run sequentially');
  }
  const keys = new Set<string>();
  const participants = new Set<string>();
  const steps = input.steps.map((step) => {
    const key = step.key?.trim();
    const agentId = step.agentId?.trim();
    const instruction = step.instruction?.trim();
    if (!key || key.length > 80 || keys.has(key)) throw new CoordinationError('Coordination step keys must be unique');
    if (!agentId || !instruction || instruction.length > 4000) throw new CoordinationError('Coordination step is incomplete');
    if (step.expectedOutput !== undefined && !COORDINATION_OUTPUT_TYPE_SET.has(step.expectedOutput)) {
      throw new CoordinationError('Coordination step output type is not allowed');
    }
    keys.add(key);
    participants.add(agentId);
    return {
      key, agentId, instruction,
      dependencies: [...new Set(step.dependencies ?? [])],
      expectedOutput: step.expectedOutput ?? 'structured_finding',
      ...(step.artifactId?.trim() ? { artifactId: step.artifactId.trim() } : {})
    };
  });
  if (steps.some((step) => step.expectedOutput === 'artifact' && !step.artifactId)) {
    throw new CoordinationError('Artifact steps must reference an existing Artifact');
  }
  if (participants.size > budget.maxParticipants) {
    throw new CoordinationError('Coordination plan exceeds its participant budget');
  }
  for (const [index, step] of steps.entries()) {
    if (step.dependencies.some((dependency) => !keys.has(dependency) || dependency === step.key)) {
      throw new CoordinationError('Coordination step dependency is invalid');
    }
    if (step.dependencies.some((dependency) => steps.findIndex(({ key }) => key === dependency) >= index)) {
      throw new CoordinationError('Coordination dependencies must refer to earlier steps');
    }
  }
  const constraints = (input.constraints ?? []).map((constraint) => constraint.trim()).filter(Boolean);
  return { goal, constraints, allowParallel: Boolean(input.allowParallel), budget, steps };
}

function normalizeWorkspaceCoordinationPolicy(
  input: WorkspaceCoordinationPolicyInput
): WorkspaceCoordinationPolicyInput {
  return {
    ...normalizeCoordinationBudget(input),
    parallelPermitted: Boolean(input.parallelPermitted)
  };
}

export function reserveCoordinationBudget(
  budget: { consumed: number; limit: number }, amount: number
): { consumed: number; remaining: number } {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new CoordinationError('Budget reservation is invalid');
  if (budget.consumed + amount > budget.limit) throw new CoordinationError('Coordination budget is exhausted');
  const consumed = budget.consumed + amount;
  return { consumed, remaining: budget.limit - consumed };
}

function resolveCoordinationStepStatus(input: {
  providerStatus: 'completed' | 'failed';
  expectedOutput: CoordinationOutputType;
  hasResultMessage: boolean;
  hasStructuredFinding: boolean;
}): 'completed' | 'failed' {
  if (input.providerStatus === 'failed') return 'failed';
  if (input.expectedOutput !== 'artifact' && !input.hasResultMessage) return 'failed';
  if (input.expectedOutput === 'structured_finding' && !input.hasStructuredFinding) {
    return 'failed';
  }
  return 'completed';
}

export async function updateWorkspaceCoordinationPolicy(
  pool: Pool,
  access: WorkspaceAccess,
  input: WorkspaceCoordinationPolicyInput
): Promise<void> {
  if (access.membership.role !== 'owner') {
    throw new CoordinationError('Workspace owner membership is required');
  }
  const policy = normalizeWorkspaceCoordinationPolicy(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const previous = await client.query(
      `SELECT default_max_participants, default_max_handoffs, default_max_depth,
              default_max_agent_runs, default_max_elapsed_seconds,
              default_provider_usage_limit, parallel_permitted
       FROM public.workspace_coordination_policy
       WHERE workspace_id = $1 FOR UPDATE`,
      [access.workspace.id]
    );
    if (!previous.rows[0]) throw new CoordinationError('Workspace coordination policy was not found');
    const provider = await client.query<{ coordination_provider_usage_limit: string | null }>(
      `SELECT coordination_provider_usage_limit
       FROM public.provider_connection
       WHERE workspace_id = $1 FOR UPDATE`,
      [access.workspace.id]
    );
    const providerLimit = provider.rows[0]?.coordination_provider_usage_limit ?? null;
    if (providerLimit !== null && (
      policy.providerUsageLimit === undefined
      || policy.providerUsageLimit > Number(providerLimit)
    )) {
      throw new CoordinationError('Workspace defaults exceed the Provider limit');
    }
    await client.query(
      `UPDATE public.workspace_coordination_policy
       SET default_max_participants = $2, default_max_handoffs = $3,
           default_max_depth = $4, default_max_agent_runs = $5,
           default_max_elapsed_seconds = $6, default_provider_usage_limit = $7,
           parallel_permitted = $8, updated_at = now()
       WHERE workspace_id = $1`,
      [access.workspace.id, policy.maxParticipants, policy.maxHandoffs,
        policy.maxDepth, policy.maxAgentRuns, policy.maxElapsedSeconds,
        policy.providerUsageLimit ?? null, policy.parallelPermitted]
    );
    await client.query(
      `INSERT INTO public.audit_event (
         workspace_id, actor_user_id, actor_membership_id,
         event_type, subject_type, subject_id, evidence
       ) VALUES ($1, $2, $3, 'workspace_coordination_policy.updated',
         'workspace_coordination_policy', $1,
         jsonb_build_object('before', $4::jsonb, 'after', $5::jsonb))`,
      [access.workspace.id, access.identity.userId, access.membership.id,
        JSON.stringify(previous.rows[0]), JSON.stringify(policy)]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function loadWorkspaceCoordinationPolicy(
  pool: Pool,
  access: WorkspaceAccess
): Promise<WorkspaceCoordinationPolicyInput> {
  const result = await pool.query<{
    default_max_participants: number; default_max_handoffs: number; default_max_depth: number;
    default_max_agent_runs: number; default_max_elapsed_seconds: number;
    default_provider_usage_limit: string | null; parallel_permitted: boolean;
  }>(
    `SELECT default_max_participants, default_max_handoffs, default_max_depth,
            default_max_agent_runs, default_max_elapsed_seconds,
            default_provider_usage_limit, parallel_permitted
     FROM public.workspace_coordination_policy WHERE workspace_id = $1`,
    [access.workspace.id]
  );
  const row = result.rows[0];
  if (!row) throw new CoordinationError('Workspace coordination policy was not found');
  return {
    maxParticipants: row.default_max_participants,
    maxHandoffs: row.default_max_handoffs,
    maxDepth: row.default_max_depth,
    maxAgentRuns: row.default_max_agent_runs,
    maxElapsedSeconds: row.default_max_elapsed_seconds,
    ...(row.default_provider_usage_limit === null
      ? {} : { providerUsageLimit: Number(row.default_provider_usage_limit) }),
    parallelPermitted: row.parallel_permitted
  };
}

export function parseCoordinationPlanProposal(
  body: string
): { message: string; plan: CoordinationPlanInput } | null {
  const match = body.match(/```relay-coordination-plan\s*([\s\S]*?)```/iu);
  if (!match?.[1]) return null;
  let decoded: unknown;
  try { decoded = JSON.parse(match[1]); } catch { throw new CoordinationError('Coordination plan JSON is invalid'); }
  return {
    message: body.replace(match[0], '').trim(),
    plan: normalizeCoordinationPlan(decoded as CoordinationPlanInput)
  };
}

export async function proposeCoordinationPlan(
  pool: Pool,
  input: CoordinationPlanInput & {
    workspaceId: string; projectId: string; coordinatingAgentId: string; sourceMessageId: string;
    routingPolicyVersion: string; agentConfigurationVersion: number; agentType: string;
  }
): Promise<string> {
  const plan = normalizeCoordinationPlan(input);
  const client = await pool.connect();
  const id = randomUUID();
  try {
    await client.query('BEGIN');
    const source = await client.query<{ allowed: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM public.message message
         JOIN public.channel channel ON channel.id = message.channel_id
         JOIN public.workspace_member author ON author.id = message.author_workspace_member_id
         JOIN public.agent coordinator ON coordinator.id = author.agent_id
         WHERE message.id = $4 AND message.workspace_id = $1 AND channel.project_id = $2
           AND coordinator.id = $3
       ) AND NOT EXISTS (
         SELECT 1 FROM unnest($5::text[]) requested(agent_id)
         WHERE NOT EXISTS (
           SELECT 1 FROM public.agent agent
           JOIN public.workspace_member member ON member.agent_id = agent.id
           JOIN public.project_membership project_member ON project_member.workspace_member_id = member.id
           WHERE agent.id = requested.agent_id AND agent.workspace_id = $1
             AND project_member.project_id = $2 AND agent.enabled AND agent.status <> 'disabled'
         )
       ) AND NOT EXISTS (
         SELECT 1 FROM unnest($6::text[]) requested(artifact_id)
         WHERE NOT EXISTS (
           SELECT 1 FROM public.artifact artifact
           WHERE artifact.id = requested.artifact_id AND artifact.workspace_id = $1
             AND artifact.project_id = $2
         )
       ) AS allowed`,
      [input.workspaceId, input.projectId, input.coordinatingAgentId, input.sourceMessageId,
        [...new Set(plan.steps.map(({ agentId }) => agentId))],
        plan.steps.flatMap(({ artifactId }) => artifactId ? [artifactId] : [])]
    );
    if (!source.rows[0]?.allowed) throw new CoordinationError('Plan participants and source must belong to the Project');
    await assertWithinCurrentCoordinationPolicy(client, input.workspaceId, plan);
    await client.query(
      `INSERT INTO public.coordination_plan (
         id, workspace_id, project_id, coordinating_agent_id, source_message_id,
         routing_policy_version, agent_configuration_version, agent_type_snapshot,
         goal, constraints, allow_parallel, max_participants, max_handoffs,
         max_depth, max_agent_runs, max_elapsed_seconds, provider_usage_limit
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [id, input.workspaceId, input.projectId, input.coordinatingAgentId, input.sourceMessageId,
        input.routingPolicyVersion, input.agentConfigurationVersion, input.agentType,
        plan.goal, JSON.stringify(plan.constraints), plan.allowParallel,
        plan.budget.maxParticipants, plan.budget.maxHandoffs, plan.budget.maxDepth,
        plan.budget.maxAgentRuns, plan.budget.maxElapsedSeconds,
        plan.budget.providerUsageLimit ?? null]
    );
    for (const [position, step] of plan.steps.entries()) {
      await client.query(
        `INSERT INTO public.coordination_plan_step (
           id, workspace_id, project_id, plan_id, step_key, position,
           target_agent_id, instruction, expected_output, dependencies, artifact_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [randomUUID(), input.workspaceId, input.projectId, id, step.key, position,
          step.agentId, step.instruction, step.expectedOutput, step.dependencies, step.artifactId ?? null]
      );
    }
    await client.query('COMMIT');
    return id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function assertCoordinationPlanCanActivate(
  client: PoolClient,
  workspaceId: string,
  planId: string,
  resuming: boolean
): Promise<void> {
  const validation = await client.query<{
    allowed: boolean; budget_stop_reason: CoordinationBudgetStopReason | null;
    has_failed_steps: boolean;
  }>(
    `SELECT (
       provider.status = 'ready'
       AND plan.max_participants <= policy.default_max_participants
       AND plan.max_handoffs <= policy.default_max_handoffs
       AND plan.max_depth <= policy.default_max_depth
       AND plan.max_agent_runs <= policy.default_max_agent_runs
       AND plan.max_elapsed_seconds <= policy.default_max_elapsed_seconds
       AND (NOT plan.allow_parallel OR policy.parallel_permitted)
       AND NOT (plan.allow_parallel AND plan.provider_usage_limit IS NOT NULL)
       AND (policy.default_provider_usage_limit IS NULL OR (
         plan.provider_usage_limit IS NOT NULL
         AND plan.provider_usage_limit <= policy.default_provider_usage_limit
       ))
       AND (provider.coordination_provider_usage_limit IS NULL OR (
         plan.provider_usage_limit IS NOT NULL
         AND plan.provider_usage_limit <= provider.coordination_provider_usage_limit
       ))
       AND (plan.started_at IS NULL
         OR now() < plan.started_at + plan.max_elapsed_seconds * interval '1 second')
       AND (plan.provider_usage_limit IS NULL OR NOT plan.provider_usage_known
         OR COALESCE(plan.provider_usage_consumed, 0) < plan.provider_usage_limit)
       AND (
         NOT EXISTS (
           SELECT 1 FROM public.coordination_plan_step step
           WHERE step.plan_id = plan.id AND step.status <> 'completed'
             AND step.expected_output <> 'artifact'
         )
         OR COALESCE((
           SELECT sum(reservation.amount)
           FROM public.coordination_budget_reservation reservation
           WHERE reservation.plan_id = plan.id AND reservation.reservation_kind = 'handoff'
         ), 0) < plan.max_handoffs
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.coordination_plan_step step
         LEFT JOIN public.agent agent
           ON agent.id = step.target_agent_id AND agent.workspace_id = step.workspace_id
         LEFT JOIN public.workspace_member member ON member.agent_id = agent.id
         LEFT JOIN public.project_membership project_member
           ON project_member.workspace_member_id = member.id
          AND project_member.project_id = step.project_id
         WHERE step.plan_id = plan.id AND step.status <> 'completed'
           AND (agent.id IS NULL OR NOT agent.enabled OR agent.status = 'disabled'
             OR project_member.workspace_member_id IS NULL)
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.coordination_plan_step step
         LEFT JOIN public.artifact artifact
           ON artifact.id = step.artifact_id AND artifact.workspace_id = step.workspace_id
          AND artifact.project_id = step.project_id
         WHERE step.plan_id = plan.id AND step.artifact_id IS NOT NULL
           AND step.status <> 'completed' AND artifact.id IS NULL
       )
     ) AS allowed, plan.budget_stop_reason,
     EXISTS (
       SELECT 1 FROM public.coordination_plan_step step
       WHERE step.plan_id = plan.id AND step.status = 'failed'
     ) AS has_failed_steps
     FROM public.coordination_plan plan
     JOIN public.workspace_coordination_policy policy ON policy.workspace_id = plan.workspace_id
     JOIN public.provider_connection provider ON provider.workspace_id = plan.workspace_id
     WHERE plan.id = $1 AND plan.workspace_id = $2
     FOR UPDATE OF plan, policy, provider`,
    [planId, workspaceId]
  );
  const result = validation.rows[0];
  if (resuming && result?.budget_stop_reason) {
    throw new CoordinationError('Coordination plan cannot resume after a hard budget stop');
  }
  if (resuming && result?.has_failed_steps) {
    throw new CoordinationError('Coordination plan cannot resume with failed steps');
  }
  if (!result?.allowed) {
    throw new CoordinationError('Coordination plan exceeds current Workspace or Provider limits');
  }
}

type CoordinationPlanDecision = 'approve' | 'reject' | 'pause' | 'resume' | 'cancel';

const COORDINATION_PLAN_TRANSITIONS = {
  approve: { allowedCurrent: ['proposed'], nextStatus: 'approved', validates: true, approves: true },
  reject: { allowedCurrent: ['proposed'], nextStatus: 'rejected', validates: false, approves: false },
  pause: { allowedCurrent: ['approved', 'active', 'paused'], nextStatus: 'paused', validates: false, approves: false },
  resume: { allowedCurrent: ['paused'], nextStatus: null, validates: true, approves: true },
  cancel: { allowedCurrent: ['approved', 'active', 'paused'], nextStatus: 'cancelled', validates: false, approves: false }
} as const satisfies Record<CoordinationPlanDecision, {
  allowedCurrent: readonly string[];
  nextStatus: string | null;
  validates: boolean;
  approves: boolean;
}>;

export async function decideCoordinationPlan(
  pool: Pool,
  access: WorkspaceAccess,
  planId: string,
  action: CoordinationPlanDecision
): Promise<void> {
  const transition = COORDINATION_PLAN_TRANSITIONS[action];
  if (!transition) {
    throw new CoordinationError('Coordination plan decision is invalid');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const actor = await client.query<{ id: string }>(
      `SELECT member.id FROM public.coordination_plan plan
       JOIN public.project_membership project_member ON project_member.project_id = plan.project_id
       JOIN public.workspace_member member ON member.id = project_member.workspace_member_id
       JOIN public.workspace_membership membership ON membership.id = member.pilot_membership_id
       WHERE plan.id = $3 AND plan.workspace_id = $1
         AND member.workspace_id = $1 AND membership.id = $2 AND membership.revoked_at IS NULL`,
      [access.workspace.id, access.membership.id, planId]
    );
    if (!actor.rows[0]) throw new CoordinationError('active Pilot membership is required');
    if (transition.validates) {
      await assertCoordinationPlanCanActivate(
        client, access.workspace.id, planId, action === 'resume'
      );
    }
    const resumedStatus = action === 'resume'
      ? (await client.query<{ active: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM public.coordination_plan_step
             WHERE plan_id = $1 AND status = 'active'
           ) AS active`,
          [planId]
        )).rows[0]?.active ? 'active' : 'approved'
      : null;
    const nextStatus = transition.nextStatus ?? resumedStatus!;
    const updated = await client.query<{
      project_id: string; coordinating_agent_id: string; routing_policy_version: string;
      agent_configuration_version: number;
      agent_type_snapshot: string;
    }>(
      `UPDATE public.coordination_plan
       SET status = $4,
           approved_by_workspace_member_id = CASE WHEN $6 THEN $3 ELSE approved_by_workspace_member_id END,
           approved_at = CASE WHEN $6 THEN now() ELSE approved_at END,
           updated_at = now()
       WHERE id = $1 AND workspace_id = $2 AND status = ANY($5::text[])
       RETURNING project_id, coordinating_agent_id, routing_policy_version,
         agent_configuration_version, agent_type_snapshot`,
      [planId, access.workspace.id, actor.rows[0].id, nextStatus,
        [...transition.allowedCurrent], transition.approves]
    );
    if (updated.rowCount !== 1) throw new CoordinationError('Coordination plan cannot accept that decision');
    if (action === 'resume') {
      await client.query(
        `INSERT INTO public.audit_event (
           workspace_id, actor_user_id, actor_membership_id,
           event_type, subject_type, subject_id, evidence
         ) VALUES ($1, $2, $3, 'coordination_plan.resumed', 'coordination_plan', $4,
           jsonb_build_object('status', $5::text,
                              'approvedByWorkspaceMemberId', $6::text))`,
        [access.workspace.id, access.identity.userId, access.membership.id,
          planId, nextStatus, actor.rows[0].id]
      );
    }
    if (action === 'approve') {
      await client.query(
        `UPDATE public.coordination_plan_step step SET status = 'ready'
         WHERE step.plan_id = $1 AND step.workspace_id = $2 AND cardinality(step.dependencies) = 0`,
        [planId, access.workspace.id]
      );
    } else if (action === 'cancel' || action === 'reject') {
      if (action === 'cancel') {
        await client.query(
          `UPDATE public.agent_conversation_turn turn
           SET status = 'failed', error_code = 'coordination_cancelled',
               lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
               completed_at = now(), updated_at = now()
           FROM public.coordination_plan_step step
           WHERE step.plan_id = $1 AND step.conversation_turn_id = turn.id
             AND turn.status IN ('queued', 'working')`,
          [planId]
        );
        await client.query(
          `UPDATE public.coordination_budget_reservation
           SET outcome = 'cancelled', updated_at = now()
           WHERE plan_id = $1 AND outcome IN ('reserved', 'started')`,
          [planId]
        );
        await refreshCoordinationProviderUsage(client, planId, access.workspace.id);
      }
      await client.query(
        `UPDATE public.coordination_plan_step SET status = 'cancelled'
         WHERE plan_id = $1 AND workspace_id = $2
           AND status IN ('pending', 'ready', 'active', 'blocked')`,
        [planId, access.workspace.id]
      );
      await recordCollaborationEvaluationEvent(client, {
        workspaceId: access.workspace.id, projectId: updated.rows[0]!.project_id,
        eventType: `outcome.${nextStatus}`, agentId: updated.rows[0]!.coordinating_agent_id,
        routingPolicyVersion: updated.rows[0]!.routing_policy_version,
        agentConfigurationVersion: `agent-config-${updated.rows[0]!.agent_configuration_version}`,
        agentType: updated.rows[0]!.agent_type_snapshot,
        promptVersion: 'coordination-plan-v1', permissionPolicyVersion: 'coordination-budget-v1',
        outcomeType: 'coordination_plan', outcomeId: planId,
        evidence: { status: nextStatus }
      });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function editCoordinationPlan(
  pool: Pool,
  access: WorkspaceAccess,
  planId: string,
  input: CoordinationPlanInput
): Promise<void> {
  const plan = normalizeCoordinationPlan(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const editable = await client.query<{
      project_id: string; max_participants: number; max_handoffs: number; max_depth: number;
      max_agent_runs: number; max_elapsed_seconds: number; provider_usage_limit: string | null;
      allow_parallel: boolean;
    }>(
      `SELECT proposal.project_id, proposal.max_participants, proposal.max_handoffs,
              proposal.max_depth, proposal.max_agent_runs, proposal.max_elapsed_seconds,
              proposal.provider_usage_limit, proposal.allow_parallel
       FROM public.coordination_plan proposal
       WHERE proposal.id = $1 AND proposal.workspace_id = $2 AND proposal.status = 'proposed'
         AND EXISTS (
           SELECT 1 FROM public.workspace_member member
           JOIN public.workspace_membership membership ON membership.id = member.pilot_membership_id
           JOIN public.project_membership project_member ON project_member.workspace_member_id = member.id
           WHERE member.workspace_id = $2 AND membership.id = $3
             AND membership.revoked_at IS NULL AND project_member.project_id = proposal.project_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM unnest($4::text[]) requested(agent_id)
           WHERE NOT EXISTS (
             SELECT 1 FROM public.agent agent
             JOIN public.workspace_member agent_member ON agent_member.agent_id = agent.id
             JOIN public.project_membership agent_project
               ON agent_project.workspace_member_id = agent_member.id
             WHERE agent.id = requested.agent_id AND agent.workspace_id = $2
               AND agent_project.project_id = proposal.project_id
               AND agent.enabled AND agent.status <> 'disabled'
           )
         ) AND NOT EXISTS (
           SELECT 1 FROM unnest($5::text[]) requested(artifact_id)
           WHERE NOT EXISTS (
             SELECT 1 FROM public.artifact artifact
             WHERE artifact.id = requested.artifact_id AND artifact.workspace_id = $2
               AND artifact.project_id = proposal.project_id
           )
         )
       FOR UPDATE`,
      [planId, access.workspace.id, access.membership.id,
        [...new Set(plan.steps.map(({ agentId }) => agentId))],
        plan.steps.flatMap(({ artifactId }) => artifactId ? [artifactId] : [])]
    );
    const projectId = editable.rows[0]?.project_id;
    if (!projectId) throw new CoordinationError('Proposed coordination plan was not found');
    await assertWithinCurrentCoordinationPolicy(client, access.workspace.id, plan);
    await client.query(
      `UPDATE public.coordination_plan
       SET goal = $3, constraints = $4, allow_parallel = $5,
           max_participants = $6, max_handoffs = $7, max_depth = $8,
           max_agent_runs = $9, max_elapsed_seconds = $10,
           provider_usage_limit = $11, updated_at = now()
       WHERE id = $1 AND workspace_id = $2`,
      [planId, access.workspace.id, plan.goal, JSON.stringify(plan.constraints),
        plan.allowParallel, plan.budget.maxParticipants, plan.budget.maxHandoffs,
        plan.budget.maxDepth, plan.budget.maxAgentRuns, plan.budget.maxElapsedSeconds,
        plan.budget.providerUsageLimit ?? null]
    );
    await client.query(
      `INSERT INTO public.audit_event (
         workspace_id, actor_user_id, actor_membership_id,
         event_type, subject_type, subject_id, evidence
       ) VALUES ($1, $2, $3, 'coordination_plan.budget_edited', 'coordination_plan', $4,
         jsonb_build_object('before', $5::jsonb, 'after', $6::jsonb))`,
      [access.workspace.id, access.identity.userId, access.membership.id, planId,
        JSON.stringify({
          maxParticipants: editable.rows[0]!.max_participants,
          maxHandoffs: editable.rows[0]!.max_handoffs,
          maxDepth: editable.rows[0]!.max_depth,
          maxAgentRuns: editable.rows[0]!.max_agent_runs,
          maxElapsedSeconds: editable.rows[0]!.max_elapsed_seconds,
          providerUsageLimit: editable.rows[0]!.provider_usage_limit === null
            ? null : Number(editable.rows[0]!.provider_usage_limit),
          allowParallel: editable.rows[0]!.allow_parallel
        }),
        JSON.stringify({ ...plan.budget, allowParallel: plan.allowParallel })]
    );
    await client.query(`DELETE FROM public.coordination_plan_step WHERE plan_id = $1`, [planId]);
    for (const [position, step] of plan.steps.entries()) {
      await client.query(
        `INSERT INTO public.coordination_plan_step (
           id, workspace_id, project_id, plan_id, step_key, position,
           target_agent_id, instruction, expected_output, dependencies, artifact_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [randomUUID(), access.workspace.id, projectId, planId, step.key, position,
          step.agentId, step.instruction, step.expectedOutput, step.dependencies, step.artifactId ?? null]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function claimCoordinationStep(
  pool: Pool,
  planId: string
): Promise<{ stepId: string; agentId: string; instruction: string } | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const plan = await client.query<{
      workspace_id: string; status: string; allow_parallel: boolean;
      max_handoffs: number; started_at: Date | null; max_elapsed_seconds: number;
      provider_usage_limit: string | null;
      provider_usage_consumed: string | null; provider_usage_known: boolean;
    }>(
      `SELECT workspace_id, status, allow_parallel, max_handoffs, started_at, max_elapsed_seconds,
              provider_usage_limit, provider_usage_consumed, provider_usage_known
       FROM public.coordination_plan WHERE id = $1 FOR UPDATE`,
      [planId]
    );
    const current = plan.rows[0];
    if (!current || !['approved', 'active'].includes(current.status)) {
      await client.query('COMMIT');
      return null;
    }
    if (current.started_at && Date.now() - current.started_at.getTime() >= current.max_elapsed_seconds * 1000) {
      await pauseCoordinationForBudget(client, planId, 'elapsed_time_limit');
      await client.query('COMMIT');
      return null;
    }
    if (current.provider_usage_limit !== null && current.provider_usage_known
      && Number(current.provider_usage_consumed ?? 0) >= Number(current.provider_usage_limit)) {
      await pauseCoordinationForBudget(
        client,
        planId,
        'provider_usage_limit'
      );
      await client.query('COMMIT');
      return null;
    }
    const step = await client.query<{
      id: string; target_agent_id: string; instruction: string; expected_output: string;
      artifact_id: string | null;
      constraints: string[];
      workspace_id: string; project_id: string; source_message_id: string;
      channel_id: string; root_message_id: string; coordinator_member_id: string;
      originating_pilot_member_id: string; provider_connection_id: string;
    }>(
      `SELECT step.id, step.target_agent_id, step.instruction, step.expected_output, step.artifact_id,
              plan.constraints,
              step.workspace_id, step.project_id, plan.source_message_id,
              source.channel_id, COALESCE(source.parent_message_id, source.id) AS root_message_id,
              coordinator_member.id AS coordinator_member_id,
              source_turn.requested_by_workspace_member_id AS originating_pilot_member_id,
              provider.id AS provider_connection_id
       FROM public.coordination_plan_step step
       JOIN public.coordination_plan plan ON plan.id = step.plan_id
       JOIN public.agent target_agent ON target_agent.id = step.target_agent_id
       JOIN public.message source ON source.id = plan.source_message_id
       JOIN public.workspace_member coordinator_member
         ON coordinator_member.agent_id = plan.coordinating_agent_id
       JOIN public.agent_conversation_turn source_turn ON source_turn.response_message_id = source.id
       JOIN public.provider_connection provider
         ON provider.workspace_id = plan.workspace_id AND provider.status = 'ready'
       WHERE step.plan_id = $1 AND step.status = 'ready'
         AND target_agent.enabled AND target_agent.status <> 'disabled'
         AND ($2 OR NOT EXISTS (
           SELECT 1 FROM public.coordination_plan_step active
           WHERE active.plan_id = step.plan_id AND active.status = 'active'
         ))
       ORDER BY step.position, step.id FOR UPDATE OF step SKIP LOCKED LIMIT 1`,
      [planId, current.allow_parallel && current.provider_usage_limit === null]
    );
    if (!step.rows[0]) {
      await client.query('COMMIT');
      return null;
    }
    if (step.rows[0].expected_output === 'artifact') {
      await client.query(
        `UPDATE public.coordination_plan_step
         SET status = 'completed', completed_at = now()
         WHERE id = $1 AND status = 'ready' AND artifact_id IS NOT NULL`,
        [step.rows[0].id]
      );
      await client.query(
        `UPDATE public.coordination_plan_step candidate SET status = 'ready'
         WHERE candidate.plan_id = $1 AND candidate.status = 'pending'
           AND NOT EXISTS (
             SELECT 1 FROM unnest(candidate.dependencies) dependency(step_key)
             LEFT JOIN public.coordination_plan_step prerequisite
               ON prerequisite.plan_id = candidate.plan_id
              AND prerequisite.step_key = dependency.step_key
             WHERE prerequisite.status IS DISTINCT FROM 'completed'
           )`,
        [planId]
      );
      await finishCoordinationPlanIfComplete(client, planId);
      await client.query('COMMIT');
      return null;
    }
    const consumed = await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM public.coordination_budget_reservation
       WHERE plan_id = $1 AND reservation_kind = 'handoff'`,
      [planId]
    );
    if ((consumed.rows[0]?.count ?? 0) >= current.max_handoffs) {
      await pauseCoordinationForBudget(client, planId, 'handoff_limit');
      await client.query('COMMIT');
      return null;
    }
    const reservationId = randomUUID();
    const pendingConstraints = await client.query<{ id: string; guidance: string }>(
      `SELECT id, guidance FROM public.coordination_plan_constraint
       WHERE plan_id = $1 AND status = 'pending'
       ORDER BY ordinal FOR UPDATE`,
      [planId]
    );
    const effectiveConstraints = [
      ...step.rows[0].constraints,
      ...pendingConstraints.rows.map(({ guidance }) => guidance)
    ];
    await client.query(
      `INSERT INTO public.coordination_budget_reservation (
         id, workspace_id, plan_id, step_id, reservation_kind
       ) VALUES ($1, $2, $3, $4, 'handoff')`,
      [reservationId, current.workspace_id, planId, step.rows[0].id]
    );
    await client.query(
      `UPDATE public.coordination_plan_step SET status = 'active', started_at = now() WHERE id = $1`,
      [step.rows[0].id]
    );
    const requestMessageId = `coordination-step:${step.rows[0].id}`;
    const requestBody = effectiveConstraints.length === 0
      ? step.rows[0].instruction
      : `${step.rows[0].instruction}\n\nApproved coordination constraints:\n${
          effectiveConstraints.map((constraint) => `- ${constraint}`).join('\n')
        }`;
    const conversationId = randomUUID();
    const turnId = randomUUID();
    await client.query(
      `INSERT INTO public.message (
         id, workspace_id, channel_id, author_workspace_member_id, parent_message_id, body
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [requestMessageId, step.rows[0].workspace_id, step.rows[0].channel_id,
        step.rows[0].coordinator_member_id, step.rows[0].root_message_id,
        requestBody]
    );
    await client.query(
      `INSERT INTO public.agent_conversation (
         id, workspace_id, channel_id, root_message_id, agent_id, provider_connection_id
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (root_message_id, agent_id) DO NOTHING`,
      [conversationId, step.rows[0].workspace_id, step.rows[0].channel_id,
        step.rows[0].root_message_id, step.rows[0].target_agent_id,
        step.rows[0].provider_connection_id]
    );
    const storedConversation = await client.query<{ id: string }>(
      `SELECT id FROM public.agent_conversation
       WHERE root_message_id = $1 AND agent_id = $2`,
      [step.rows[0].root_message_id, step.rows[0].target_agent_id]
    );
    await client.query(
      `INSERT INTO public.agent_conversation_turn (
         id, workspace_id, conversation_id, request_message_id,
         requested_by_workspace_member_id, status, response_placement,
         response_parent_message_id, ambient, handoff_depth
       ) VALUES ($1, $2, $3, $4, $5, 'queued', 'thread', $6, false, 1)`,
      [turnId, step.rows[0].workspace_id, storedConversation.rows[0]!.id,
        requestMessageId, step.rows[0].originating_pilot_member_id,
        step.rows[0].root_message_id]
    );
    await client.query(
      `UPDATE public.coordination_plan_step SET conversation_turn_id = $2 WHERE id = $1`,
      [step.rows[0].id, turnId]
    );
    await client.query(
      `INSERT INTO public.notification_outbox (workspace_id, message_id, topic, payload)
       VALUES ($1, $2, 'channel.message', $3)`,
      [step.rows[0].workspace_id, requestMessageId, { messageId: requestMessageId }]
    );
    await client.query(
      `UPDATE public.coordination_plan
       SET status = 'active', constraints = $2,
           started_at = COALESCE(started_at, now()), updated_at = now()
       WHERE id = $1`,
      [planId, JSON.stringify(effectiveConstraints)]
    );
    if (pendingConstraints.rows.length > 0) {
      await client.query(
        `UPDATE public.coordination_plan_constraint
         SET status = 'delivered', delivery_conversation_turn_id = $2, delivered_at = now()
         WHERE id = ANY($1::text[]) AND status = 'pending'`,
        [pendingConstraints.rows.map(({ id }) => id), turnId]
      );
    }
    await client.query('COMMIT');
    return { stepId: step.rows[0].id, agentId: step.rows[0].target_agent_id, instruction: step.rows[0].instruction };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

type CoordinationBudgetStopReason =
  | 'handoff_limit'
  | 'agent_run_limit'
  | 'elapsed_time_limit'
  | 'provider_usage_limit';

async function pauseCoordinationForBudget(
  client: PoolClient,
  planId: string,
  reason: CoordinationBudgetStopReason
): Promise<void> {
  const plan = await client.query<{
    workspace_id: string; channel_id: string; root_message_id: string;
    coordinator_member_id: string; budget_notice_message_id: string | null;
  }>(
    `UPDATE public.coordination_plan plan
     SET status = 'paused', budget_stop_reason = $2, updated_at = now()
     FROM public.message source, public.workspace_member coordinator
     WHERE plan.id = $1 AND source.id = plan.source_message_id
       AND coordinator.agent_id = plan.coordinating_agent_id
     RETURNING plan.workspace_id, source.channel_id,
       COALESCE(source.parent_message_id, source.id) AS root_message_id,
       coordinator.id AS coordinator_member_id, plan.budget_notice_message_id`,
    [planId, reason]
  );
  const row = plan.rows[0];
  if (!row || row.budget_notice_message_id) return;
  const noticeMessageId = `coordination-budget:${planId}`;
  const label: Record<CoordinationBudgetStopReason, string> = {
    handoff_limit: 'handoff limit reached',
    agent_run_limit: 'AgentRun limit reached',
    elapsed_time_limit: 'elapsed-time limit reached',
    provider_usage_limit: 'Provider-usage limit reached'
  };
  await client.query(
    `INSERT INTO public.message (
       id, workspace_id, channel_id, author_workspace_member_id, parent_message_id, body
     ) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [noticeMessageId, row.workspace_id, row.channel_id, row.coordinator_member_id,
      row.root_message_id,
      `Coordination paused: ${label[reason]}. Pilot direction is required before more work can start.`]
  );
  await client.query(
    `UPDATE public.coordination_plan SET budget_notice_message_id = $2 WHERE id = $1`,
    [planId, noticeMessageId]
  );
  await client.query(
    `INSERT INTO public.notification_outbox (workspace_id, message_id, topic, payload)
     VALUES ($1, $2, 'channel.message', $3)`,
    [row.workspace_id, noticeMessageId, { messageId: noticeMessageId }]
  );
}

export async function activateNextCoordinationStep(pool: Pool): Promise<void> {
  const plans = await pool.query<{ id: string }>(
    `SELECT id FROM public.coordination_plan
     WHERE status IN ('approved', 'active') ORDER BY created_at, id`
  );
  for (const plan of plans.rows) {
    if (await claimCoordinationStep(pool, plan.id)) return;
  }
}

export async function completeCoordinationStep(
  client: PoolClient,
  input: {
    workspaceId: string; conversationTurnId: string;
    status: 'completed' | 'failed'; resultMessageId: string | null;
  }
): Promise<void> {
  const output = await client.query<{
    expected_output: CoordinationOutputType; has_structured_finding: boolean;
  }>(
    `SELECT step.expected_output,
            EXISTS (
              SELECT 1 FROM public.agent_finding finding
              WHERE finding.result_message_id = $3
                AND finding.workspace_id = step.workspace_id
                AND finding.project_id = step.project_id
                AND finding.author_agent_id = step.target_agent_id
            ) AS has_structured_finding
     FROM public.coordination_plan_step step
     WHERE step.conversation_turn_id = $1 AND step.workspace_id = $2
       AND step.status = 'active'`,
    [input.conversationTurnId, input.workspaceId, input.resultMessageId]
  );
  const expectedOutput = output.rows[0];
  if (!expectedOutput) return;
  const stepStatus = resolveCoordinationStepStatus({
    providerStatus: input.status,
    expectedOutput: expectedOutput.expected_output,
    hasResultMessage: input.resultMessageId !== null,
    hasStructuredFinding: expectedOutput.has_structured_finding
  });
  const completed = await client.query<{ id: string; plan_id: string; target_agent_id: string }>(
    `UPDATE public.coordination_plan_step
     SET status = $3, result_message_id = $4, completed_at = now()
     WHERE conversation_turn_id = $1 AND workspace_id = $2 AND status = 'active'
     RETURNING id, plan_id, target_agent_id`,
    [input.conversationTurnId, input.workspaceId, stepStatus, input.resultMessageId]
  );
  const planId = completed.rows[0]?.plan_id;
  if (!planId) return;
  await client.query(
    `UPDATE public.coordination_budget_reservation
     SET outcome = CASE
       WHEN $2 = 'completed' THEN 'completed'
       WHEN outcome = 'reserved' THEN 'failed_start'
       WHEN outcome = 'started' THEN 'failed'
       ELSE outcome
     END, updated_at = now()
     WHERE step_id = $1 AND reservation_kind = 'handoff'`,
    [completed.rows[0]!.id, stepStatus]
  );
  await refreshCoordinationProviderUsage(client, planId, input.workspaceId);
  const evaluation = await client.query<{
    workspace_id: string; project_id: string; routing_policy_version: string;
    agent_configuration_version: number;
    agent_type_snapshot: string;
  }>(
    `SELECT plan.workspace_id, plan.project_id, plan.routing_policy_version,
            turn.agent_configuration_version, turn.agent_type_snapshot
     FROM public.coordination_plan plan
     JOIN public.agent_conversation_turn turn ON turn.id = $3
     WHERE plan.id = $1 AND plan.workspace_id = $2`,
    [planId, input.workspaceId, input.conversationTurnId]
  );
  const evaluationContext = evaluation.rows[0];
  if (evaluationContext) {
    await recordCollaborationEvaluationEvent(client, {
      workspaceId: evaluationContext.workspace_id, projectId: evaluationContext.project_id,
      eventType: `outcome.${stepStatus}`, agentId: completed.rows[0]!.target_agent_id,
      routingPolicyVersion: evaluationContext.routing_policy_version,
      agentConfigurationVersion: `agent-config-${evaluationContext.agent_configuration_version}`,
      agentType: evaluationContext.agent_type_snapshot,
      promptVersion: 'coordination-step-v1', permissionPolicyVersion: 'coordination-budget-v1',
      outcomeType: 'coordination_step', outcomeId: completed.rows[0]!.id,
      evidence: { status: stepStatus }
    });
  }
  if (stepStatus === 'failed') {
    await client.query(
      `UPDATE public.coordination_plan SET status = 'paused', updated_at = now() WHERE id = $1`,
      [planId]
    );
    return;
  }
  await client.query(
    `UPDATE public.coordination_plan_step candidate
     SET status = 'ready'
     WHERE candidate.plan_id = $1 AND candidate.status = 'pending'
       AND NOT EXISTS (
         SELECT 1 FROM unnest(candidate.dependencies) dependency(step_key)
         LEFT JOIN public.coordination_plan_step prerequisite
           ON prerequisite.plan_id = candidate.plan_id
          AND prerequisite.step_key = dependency.step_key
         WHERE prerequisite.status IS DISTINCT FROM 'completed'
       )`,
    [planId]
  );
  await finishCoordinationPlanIfComplete(client, planId);
}

export async function recordCoordinationProviderUsage(
  client: PoolClient,
  input: { workspaceId: string; conversationTurnId: string; amount: number }
): Promise<void> {
  if (!Number.isFinite(input.amount) || input.amount < 0) {
    throw new CoordinationError('Measured Provider usage is invalid');
  }
  const inserted = await client.query<{ plan_id: string }>(
    `INSERT INTO public.coordination_provider_usage_record (
       id, workspace_id, plan_id, step_id, conversation_turn_id, amount
     )
     SELECT $1, step.workspace_id, step.plan_id, step.id, $2, $3
     FROM public.coordination_plan_step step
     WHERE step.conversation_turn_id = $2 AND step.workspace_id = $4
     ON CONFLICT (conversation_turn_id) DO NOTHING
     RETURNING plan_id`,
    [randomUUID(), input.conversationTurnId, input.amount, input.workspaceId]
  );
  const planId = inserted.rows[0]?.plan_id;
  if (!planId) return;
  await refreshCoordinationProviderUsage(client, planId, input.workspaceId);
}

async function refreshCoordinationProviderUsage(
  client: PoolClient,
  planId: string,
  workspaceId: string
): Promise<void> {
  await client.query(
    `UPDATE public.coordination_plan plan
     SET provider_usage_known = (
           EXISTS (
             SELECT 1 FROM public.coordination_provider_usage_record usage
             WHERE usage.plan_id = plan.id
           ) AND NOT EXISTS (
             SELECT 1
             FROM public.coordination_budget_reservation reservation
             JOIN public.coordination_plan_step step ON step.id = reservation.step_id
             JOIN public.agent_conversation_turn turn ON turn.id = step.conversation_turn_id
             LEFT JOIN public.coordination_provider_usage_record usage
               ON usage.conversation_turn_id = turn.id
             WHERE reservation.plan_id = plan.id
               AND usage.id IS NULL
               AND (
                 reservation.outcome IN ('started', 'failed', 'completed')
                 OR (reservation.outcome = 'cancelled' AND turn.provider_turn_id IS NOT NULL)
               )
           )
         ),
         provider_usage_consumed = (
           SELECT COALESCE(sum(amount), 0)
           FROM public.coordination_provider_usage_record usage
           WHERE usage.plan_id = plan.id
         ),
         updated_at = now()
     WHERE plan.id = $1 AND plan.workspace_id = $2`,
    [planId, workspaceId]
  );
}

async function finishCoordinationPlanIfComplete(client: PoolClient, planId: string): Promise<void> {
  const remaining = await client.query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM public.coordination_plan_step
     WHERE plan_id = $1 AND status <> 'completed'`,
    [planId]
  );
  if (remaining.rows[0]?.count === 0) {
    const synthesis = await client.query<{
      workspace_id: string; project_id: string; channel_id: string; root_message_id: string;
      coordinating_agent_id: string; routing_policy_version: string;
      agent_configuration_version: number;
      agent_type_snapshot: string;
      coordinator_member_id: string; goal: string;
    }>(
      `SELECT plan.workspace_id, plan.project_id, plan.coordinating_agent_id,
              plan.routing_policy_version, plan.agent_configuration_version,
              plan.agent_type_snapshot, plan.goal, source.channel_id,
              COALESCE(source.parent_message_id, source.id) AS root_message_id,
              member.id AS coordinator_member_id
       FROM public.coordination_plan plan
       JOIN public.message source ON source.id = plan.source_message_id
       JOIN public.workspace_member member ON member.agent_id = plan.coordinating_agent_id
       WHERE plan.id = $1`,
      [planId]
    );
    const row = synthesis.rows[0];
    const synthesisMessageId = `coordination-synthesis:${planId}`;
    if (row) {
      const stepResults = await client.query<{
        step_key: string; agent_name: string; instruction: string; summary: string | null;
        result_message_id: string | null; artifact_id: string | null;
        artifact_url: string | null; artifact_result_message_id: string | null;
      }>(
        `SELECT step.step_key, agent.name AS agent_name, step.instruction,
                COALESCE(finding.summary, result.body) AS summary,
                step.result_message_id, step.artifact_id, artifact.url AS artifact_url,
                artifact.result_message_id AS artifact_result_message_id
         FROM public.coordination_plan_step step
         JOIN public.agent agent ON agent.id = step.target_agent_id
         LEFT JOIN public.message result ON result.id = step.result_message_id
         LEFT JOIN public.agent_finding finding
           ON finding.result_message_id = step.result_message_id
         LEFT JOIN public.artifact artifact ON artifact.id = step.artifact_id
         WHERE step.plan_id = $1
         ORDER BY step.position, step.id`,
        [planId]
      );
      const body = renderCoordinationSynthesis(row.goal, stepResults.rows.map((step) => ({
        key: step.step_key,
        agentName: step.agent_name,
        instruction: step.instruction,
        summary: step.summary,
        resultMessageId: step.result_message_id,
        artifactId: step.artifact_id,
        artifactUrl: step.artifact_url,
        artifactResultMessageId: step.artifact_result_message_id
      })));
      await client.query(
        `INSERT INTO public.message (
           id, workspace_id, channel_id, author_workspace_member_id, parent_message_id, body
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [synthesisMessageId, row.workspace_id, row.channel_id, row.coordinator_member_id,
          row.root_message_id, body]
      );
      await client.query(
        `INSERT INTO public.notification_outbox (workspace_id, message_id, topic, payload)
         VALUES ($1, $2, 'channel.message', $3)`,
        [row.workspace_id, synthesisMessageId, { messageId: synthesisMessageId }]
      );
      await recordCollaborationEvaluationEvent(client, {
        workspaceId: row.workspace_id, projectId: row.project_id,
        eventType: 'outcome.completed', agentId: row.coordinating_agent_id,
        routingPolicyVersion: row.routing_policy_version,
        agentConfigurationVersion: `agent-config-${row.agent_configuration_version}`,
        agentType: row.agent_type_snapshot,
        promptVersion: 'coordination-plan-v1', permissionPolicyVersion: 'coordination-budget-v1',
        outcomeType: 'coordination_plan', outcomeId: planId,
        evidence: { status: 'completed', synthesisMessageId }
      });
    }
    await client.query(
      `UPDATE public.coordination_plan
       SET status = 'completed', completed_at = now(), updated_at = now(),
           synthesis_message_id = $2 WHERE id = $1`,
      [planId, row ? synthesisMessageId : null]
    );
  }
}
