import type { PoolClient } from 'pg';

import {
  isTerminalAgentRunStatus,
  type AgentRunEventType,
  type AgentRunStatus
} from './agent-run.js';
import { recordCollaborationEvaluationEvent } from '../collaboration/evaluation.js';

export interface AgentRunEventInput {
  eventType: AgentRunEventType;
  status: AgentRunStatus;
  summary: string;
  evidence?: Record<string, unknown>;
  providerEventId?: string;
  providerTurnId?: string;
  providerItemId?: string;
  completed?: boolean;
  clearActiveTurn?: boolean;
  releaseLease?: boolean;
}

interface AgentRunEventTarget {
  id: string;
  workspaceId: string;
  requiredLeaseToken?: string;
}

async function recordAgentRunEvaluationEvent(
  client: PoolClient,
  target: AgentRunEventTarget,
  eventType: string,
  evidence: Record<string, unknown>
): Promise<void> {
  const context = await client.query<{
    workspace_id: string; project_id: string; agent_id: string; routing_policy_version: string | null;
    agent_configuration_version: number;
    agent_type_snapshot: string;
  }>(
    `SELECT run.workspace_id, task.project_id, run.agent_id,
            decision.policy_version AS routing_policy_version,
            run.agent_configuration_version, run.agent_type_snapshot
     FROM public.agent_run run
     JOIN public.task task ON task.id = run.task_id AND task.workspace_id = run.workspace_id
     LEFT JOIN public.message_intent_decision decision
       ON decision.message_id = task.source_message_id AND decision.workspace_id = run.workspace_id
     WHERE run.id = $1 AND run.workspace_id = $2`,
    [target.id, target.workspaceId]
  );
  const row = context.rows[0];
  if (!row) return;
  await recordCollaborationEvaluationEvent(client, {
    workspaceId: row.workspace_id, projectId: row.project_id, eventType,
    agentId: row.agent_id, routingPolicyVersion: row.routing_policy_version,
    agentType: row.agent_type_snapshot,
    agentConfigurationVersion: `agent-config-${row.agent_configuration_version}`,
    promptVersion: 'engineering-run-v1',
    permissionPolicyVersion: 'mvp-engineering-autonomy-v1',
    outcomeType: 'agent_run', outcomeId: target.id, evidence
  });
}

export async function appendAgentRunEvent(
  client: PoolClient,
  target: AgentRunEventTarget,
  event: AgentRunEventInput
): Promise<number | undefined> {
  const run = await client.query<{ id: string; status: AgentRunStatus; lease_token: string | null }>(
    `SELECT id, status, lease_token FROM public.agent_run
     WHERE id = $1 AND workspace_id = $2
     FOR UPDATE`,
    [target.id, target.workspaceId]
  );
  if (!run.rowCount) throw new Error('AgentRun execution lease was lost');
  if (isTerminalAgentRunStatus(run.rows[0]!.status)) return undefined;
  if (target.requiredLeaseToken && run.rows[0]!.lease_token !== target.requiredLeaseToken) {
    throw new Error('AgentRun execution lease was lost');
  }
  if (event.providerEventId) {
    const duplicate = await client.query(
      `SELECT 1 FROM public.agent_run_event
       WHERE agent_run_id = $1 AND provider_event_id = $2`,
      [target.id, event.providerEventId]
    );
    if (duplicate.rowCount) return undefined;
  }
  const inserted = await client.query<{ id: number; sequence: number }>(
    `INSERT INTO public.agent_run_event (
       workspace_id, agent_run_id, sequence, event_type, status, summary, evidence,
       provider_event_id, provider_turn_id, provider_item_id
     )
     SELECT $2, $1, COALESCE(MAX(sequence), 0) + 1, $3, $4, $5, $6, $7, $8, $9
     FROM public.agent_run_event WHERE agent_run_id = $1
     RETURNING id, sequence`,
    [
      target.id,
      target.workspaceId,
      event.eventType,
      event.status,
      event.summary,
      event.evidence ?? {},
      event.providerEventId ?? null,
      event.providerTurnId ?? null,
      event.providerItemId ?? null
    ]
  );
  const eventId = inserted.rows[0]?.id;
  const sequence = inserted.rows[0]?.sequence;
  if (!eventId || !sequence) throw new Error('AgentRun event was not persisted');
  await client.query(
    `INSERT INTO public.notification_outbox (
       workspace_id, agent_run_event_id, topic, payload
     ) VALUES ($1, $2, 'agent_run.event', $3)`,
    [target.workspaceId, eventId, {
      agentRunId: target.id,
      eventType: event.eventType,
      sequence
    }]
  );
  if (event.completed && (event.status === 'completed' || event.status === 'cancelled')) {
    await client.query(
      `UPDATE public.task
       SET status = $2, updated_at = now()
       WHERE id = (SELECT task_id FROM public.agent_run WHERE id = $1)
         AND status = 'open'`,
      [target.id, event.status]
    );
  }
  if (event.completed) {
    await client.query(
      `UPDATE public.approval
       SET state = 'expired'
       WHERE agent_run_id = $1 AND state IN ('pending', 'approved')`,
      [target.id]
    );
    await recordAgentRunEvaluationEvent(
      client, target, `outcome.${event.status}`, { status: event.status }
    );
  }
  if (event.eventType === 'run.action_rejected') {
    await recordAgentRunEvaluationEvent(
      client, target, 'policy.rejected', { agentRunEventType: event.eventType }
    );
  }
  await client.query(
    `UPDATE public.agent_run
     SET status = $3,
         active_turn_id = CASE WHEN $4 THEN NULL ELSE active_turn_id END,
         completed_at = CASE WHEN $5 THEN now() ELSE completed_at END,
         lease_owner = CASE WHEN $5 OR $3 = 'paused' OR $6 THEN NULL ELSE lease_owner END,
         lease_token = CASE WHEN $5 OR $3 = 'paused' OR $6 THEN NULL ELSE lease_token END,
         lease_expires_at = CASE WHEN $5 OR $3 = 'paused' OR $6 THEN NULL ELSE lease_expires_at END,
         updated_at = now()
     WHERE id = $1 AND workspace_id = $2`,
    [
      target.id,
      target.workspaceId,
      event.status,
      event.clearActiveTurn ?? false,
      event.completed ?? false,
      event.releaseLease ?? false
    ]
  );
  await client.query(
    `UPDATE public.agent
     SET status = CASE
       WHEN $2 IN ('waiting_for_input', 'waiting_for_approval', 'paused') THEN 'waiting'
       WHEN $2 IN ('completed', 'failed', 'cancelled') THEN 'idle'
       ELSE 'working'
     END
     WHERE id = (SELECT agent_id FROM public.agent_run WHERE id = $1)
       AND enabled = true`,
    [target.id, event.status]
  );
  return sequence;
}
