import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import type { WorkspaceAccess } from '../authentication/authorization.js';

export interface CoordinationBudget {
  maxParticipants: number;
  maxHandoffs: number;
  maxDepth: number;
  maxAgentRuns: number;
  maxElapsedSeconds: number;
  providerUsageLimit?: number;
}

export interface CoordinationStepInput {
  key: string;
  agentId: string;
  instruction: string;
  dependencies: string[];
  expectedOutput?: 'concise_text' | 'structured_finding' | 'artifact';
  artifactId?: string;
}

export interface CoordinationPlanInput {
  goal: string;
  constraints?: string[];
  allowParallel: boolean;
  budget: CoordinationBudget;
  steps: CoordinationStepInput[];
}

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
  maxAgentRuns: 20,
  maxElapsedSeconds: 86_400
};

function integerWithin(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CoordinationError(`${label} exceeds the operator limit`);
  }
  return value;
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
  const budget: CoordinationBudget = {
    maxParticipants: integerWithin(input.budget.maxParticipants, 1, OPERATOR_LIMITS.maxParticipants, 'Participant budget'),
    maxHandoffs: integerWithin(input.budget.maxHandoffs, 0, OPERATOR_LIMITS.maxHandoffs, 'Handoff budget'),
    maxDepth: integerWithin(input.budget.maxDepth, 0, OPERATOR_LIMITS.maxDepth, 'Handoff depth'),
    maxAgentRuns: integerWithin(input.budget.maxAgentRuns, 0, OPERATOR_LIMITS.maxAgentRuns, 'AgentRun budget'),
    maxElapsedSeconds: integerWithin(input.budget.maxElapsedSeconds, 60, OPERATOR_LIMITS.maxElapsedSeconds, 'Elapsed-time budget'),
    ...(input.budget.providerUsageLimit === undefined
      ? {}
      : Number.isFinite(input.budget.providerUsageLimit) && input.budget.providerUsageLimit >= 0
        ? { providerUsageLimit: input.budget.providerUsageLimit }
        : (() => { throw new CoordinationError('Provider usage budget is invalid'); })())
  };
  const keys = new Set<string>();
  const participants = new Set<string>();
  const steps = input.steps.map((step) => {
    const key = step.key?.trim();
    const agentId = step.agentId?.trim();
    const instruction = step.instruction?.trim();
    if (!key || key.length > 80 || keys.has(key)) throw new CoordinationError('Coordination step keys must be unique');
    if (!agentId || !instruction || instruction.length > 4000) throw new CoordinationError('Coordination step is incomplete');
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

export function reserveCoordinationBudget(
  budget: { consumed: number; limit: number }, amount: number
): { consumed: number; remaining: number } {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new CoordinationError('Budget reservation is invalid');
  if (budget.consumed + amount > budget.limit) throw new CoordinationError('Coordination budget is exhausted');
  const consumed = budget.consumed + amount;
  return { consumed, remaining: budget.limit - consumed };
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
    const policy = await client.query<{ allowed: boolean }>(
      `SELECT ($2 <= default_max_participants
          AND $3 <= default_max_handoffs
          AND $4 <= default_max_depth
          AND $5 <= default_max_agent_runs
          AND $6 <= default_max_elapsed_seconds
          AND (default_provider_usage_limit IS NULL
            OR ($7::numeric IS NOT NULL AND $7 <= default_provider_usage_limit))) AS allowed
       FROM public.workspace_coordination_policy WHERE workspace_id = $1 FOR UPDATE`,
      [input.workspaceId, plan.budget.maxParticipants, plan.budget.maxHandoffs,
        plan.budget.maxDepth, plan.budget.maxAgentRuns, plan.budget.maxElapsedSeconds,
        plan.budget.providerUsageLimit ?? null]
    );
    if (!policy.rows[0]?.allowed) throw new CoordinationError('Coordination plan exceeds Workspace defaults');
    await client.query(
      `INSERT INTO public.coordination_plan (
         id, workspace_id, project_id, coordinating_agent_id, source_message_id,
         goal, constraints, allow_parallel, max_participants, max_handoffs,
         max_depth, max_agent_runs, max_elapsed_seconds, provider_usage_limit
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [id, input.workspaceId, input.projectId, input.coordinatingAgentId, input.sourceMessageId,
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

export async function decideCoordinationPlan(
  pool: Pool,
  access: WorkspaceAccess,
  planId: string,
  action: 'approve' | 'reject' | 'pause' | 'cancel'
): Promise<void> {
  if (!['approve', 'reject', 'pause', 'cancel'].includes(action)) {
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
    const nextStatus = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : action === 'pause' ? 'paused' : 'cancelled';
    const allowedCurrent = action === 'approve' || action === 'reject' ? ['proposed'] : ['approved', 'active', 'paused'];
    const updated = await client.query(
      `UPDATE public.coordination_plan
       SET status = $4,
           approved_by_workspace_member_id = CASE WHEN $4 = 'approved' THEN $3 ELSE approved_by_workspace_member_id END,
           approved_at = CASE WHEN $4 = 'approved' THEN now() ELSE approved_at END,
           updated_at = now()
       WHERE id = $1 AND workspace_id = $2 AND status = ANY($5::text[])`,
      [planId, access.workspace.id, actor.rows[0].id, nextStatus, allowedCurrent]
    );
    if (updated.rowCount !== 1) throw new CoordinationError('Coordination plan cannot accept that decision');
    if (action === 'approve') {
      await client.query(
        `UPDATE public.coordination_plan_step step SET status = 'ready'
         WHERE step.plan_id = $1 AND step.workspace_id = $2 AND cardinality(step.dependencies) = 0`,
        [planId, access.workspace.id]
      );
    } else if (action === 'cancel' || action === 'reject') {
      await client.query(
        `UPDATE public.coordination_plan_step SET status = 'cancelled'
         WHERE plan_id = $1 AND workspace_id = $2 AND status IN ('pending', 'ready', 'blocked')`,
        [planId, access.workspace.id]
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
    const editable = await client.query<{ project_id: string }>(
      `SELECT proposal.project_id
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
    const policy = await client.query<{ allowed: boolean }>(
      `SELECT ($2 <= default_max_participants AND $3 <= default_max_handoffs
          AND $4 <= default_max_depth AND $5 <= default_max_agent_runs
          AND $6 <= default_max_elapsed_seconds
          AND (default_provider_usage_limit IS NULL
            OR ($7::numeric IS NOT NULL AND $7 <= default_provider_usage_limit))) AS allowed
       FROM public.workspace_coordination_policy WHERE workspace_id = $1 FOR UPDATE`,
      [access.workspace.id, plan.budget.maxParticipants, plan.budget.maxHandoffs,
        plan.budget.maxDepth, plan.budget.maxAgentRuns, plan.budget.maxElapsedSeconds,
        plan.budget.providerUsageLimit ?? null]
    );
    if (!policy.rows[0]?.allowed) throw new CoordinationError('Coordination plan exceeds Workspace defaults');
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
      max_agent_runs: number; provider_usage_limit: string | null;
      provider_usage_consumed: string | null; provider_usage_known: boolean;
    }>(
      `SELECT workspace_id, status, allow_parallel, max_handoffs, started_at, max_elapsed_seconds,
              max_agent_runs, provider_usage_limit, provider_usage_consumed, provider_usage_known
       FROM public.coordination_plan WHERE id = $1 FOR UPDATE`,
      [planId]
    );
    const current = plan.rows[0];
    if (!current || !['approved', 'active'].includes(current.status)) {
      await client.query('COMMIT');
      return null;
    }
    if (current.started_at && Date.now() - current.started_at.getTime() >= current.max_elapsed_seconds * 1000) {
      await client.query(`UPDATE public.coordination_plan SET status = 'paused', updated_at = now() WHERE id = $1`, [planId]);
      await client.query('COMMIT');
      return null;
    }
    if (current.provider_usage_limit !== null && (
      !current.provider_usage_known
      || Number(current.provider_usage_consumed ?? 0) >= Number(current.provider_usage_limit)
    )) {
      await client.query(`UPDATE public.coordination_plan SET status = 'paused', updated_at = now() WHERE id = $1`, [planId]);
      await client.query('COMMIT');
      return null;
    }
    const agentRunReservations = await client.query<{ count: number }>(
      `SELECT COALESCE(sum(amount), 0)::integer AS count
       FROM public.coordination_budget_reservation
       WHERE plan_id = $1 AND reservation_kind = 'agent_run'`, [planId]
    );
    if ((agentRunReservations.rows[0]?.count ?? 0) > current.max_agent_runs) {
      await client.query(`UPDATE public.coordination_plan SET status = 'paused', updated_at = now() WHERE id = $1`, [planId]);
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
      [planId, current.allow_parallel]
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
      await client.query(
        `UPDATE public.coordination_plan SET status = 'paused', updated_at = now() WHERE id = $1`,
        [planId]
      );
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
  const completed = await client.query<{ id: string; plan_id: string; target_agent_id: string }>(
    `UPDATE public.coordination_plan_step
     SET status = $3, result_message_id = $4, completed_at = now()
     WHERE conversation_turn_id = $1 AND workspace_id = $2 AND status = 'active'
     RETURNING id, plan_id, target_agent_id`,
    [input.conversationTurnId, input.workspaceId, input.status, input.resultMessageId]
  );
  const planId = completed.rows[0]?.plan_id;
  if (!planId) return;
  await client.query(
    `INSERT INTO public.collaboration_evaluation_event (
       id, workspace_id, project_id, event_type, agent_id,
       routing_policy_version, prompt_version, permission_policy_version,
       outcome_type, outcome_id, evidence
     )
     SELECT $1, plan.workspace_id, plan.project_id, $2, $3,
            COALESCE(decision.policy_version, 'not-applicable-v1'),
            'coordination-step-v1', 'coordination-budget-v1',
            'coordination_step', $4, jsonb_build_object('status', $5::text)
     FROM public.coordination_plan plan
     LEFT JOIN public.message_intent_decision decision
       ON decision.message_id = plan.source_message_id AND decision.workspace_id = plan.workspace_id
     WHERE plan.id = $6 AND plan.workspace_id = $7`,
    [randomUUID(), `outcome.${input.status}`, completed.rows[0]!.target_agent_id,
      completed.rows[0]!.id, input.status, planId, input.workspaceId]
  );
  if (input.status === 'failed') {
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

async function finishCoordinationPlanIfComplete(client: PoolClient, planId: string): Promise<void> {
  const remaining = await client.query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM public.coordination_plan_step
     WHERE plan_id = $1 AND status <> 'completed'`,
    [planId]
  );
  if (remaining.rows[0]?.count === 0) {
    const synthesis = await client.query<{
      workspace_id: string; channel_id: string; root_message_id: string;
      coordinator_member_id: string; result_ids: string[]; artifact_ids: string[];
    }>(
      `SELECT plan.workspace_id, source.channel_id,
              COALESCE(source.parent_message_id, source.id) AS root_message_id,
              member.id AS coordinator_member_id,
              array_agg(step.result_message_id ORDER BY step.position)
                FILTER (WHERE step.result_message_id IS NOT NULL) AS result_ids,
              array_agg(step.artifact_id ORDER BY step.position)
                FILTER (WHERE step.artifact_id IS NOT NULL) AS artifact_ids
       FROM public.coordination_plan plan
       JOIN public.message source ON source.id = plan.source_message_id
       JOIN public.workspace_member member ON member.agent_id = plan.coordinating_agent_id
       JOIN public.coordination_plan_step step ON step.plan_id = plan.id
       WHERE plan.id = $1
       GROUP BY plan.id, source.id, member.id`,
      [planId]
    );
    const row = synthesis.rows[0];
    const synthesisMessageId = `coordination-synthesis:${planId}`;
    if (row) {
      await client.query(
        `INSERT INTO public.message (
           id, workspace_id, channel_id, author_workspace_member_id, parent_message_id, body
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [synthesisMessageId, row.workspace_id, row.channel_id, row.coordinator_member_id,
          row.root_message_id,
          `Coordination complete. Reviewed results: ${[
            ...(row.result_ids ?? []).map((id) => `Message ${id}`),
            ...(row.artifact_ids ?? []).map((id) => `Artifact ${id}`)
          ].join(', ') || 'none'}.`]
      );
      await client.query(
        `INSERT INTO public.notification_outbox (workspace_id, message_id, topic, payload)
         VALUES ($1, $2, 'channel.message', $3)`,
        [row.workspace_id, synthesisMessageId, { messageId: synthesisMessageId }]
      );
    }
    await client.query(
      `UPDATE public.coordination_plan
       SET status = 'completed', completed_at = now(), updated_at = now(),
           synthesis_message_id = $2 WHERE id = $1`,
      [planId, row ? synthesisMessageId : null]
    );
  }
}
