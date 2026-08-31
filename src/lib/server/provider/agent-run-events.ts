import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import {
  isTerminalAgentRunStatus,
  type AgentRunEventType,
  type AgentRunStatus
} from './agent-run.js';

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
    await client.query(
      `INSERT INTO public.collaboration_evaluation_event (
         id, workspace_id, project_id, event_type, agent_id,
         routing_policy_version, prompt_version, permission_policy_version,
         outcome_type, outcome_id, evidence
       )
       SELECT $1, run.workspace_id, task.project_id, $2, run.agent_id,
              COALESCE(decision.policy_version, 'not-applicable-v1'),
              'engineering-run-v1', 'mvp-engineering-autonomy-v1',
              'agent_run', run.id, jsonb_build_object('status', $3::text)
       FROM public.agent_run run
       JOIN public.task task ON task.id = run.task_id AND task.workspace_id = run.workspace_id
       LEFT JOIN public.message_intent_decision decision
         ON decision.message_id = task.source_message_id AND decision.workspace_id = run.workspace_id
       WHERE run.id = $4 AND run.workspace_id = $5`,
      [randomUUID(), `outcome.${event.status}`, event.status, target.id, target.workspaceId]
    );
  }
  if (event.eventType === 'run.action_rejected') {
    await client.query(
      `INSERT INTO public.collaboration_evaluation_event (
         id, workspace_id, project_id, event_type, agent_id,
         routing_policy_version, prompt_version, permission_policy_version,
         outcome_type, outcome_id, evidence
       )
       SELECT $1, run.workspace_id, task.project_id, 'policy.rejected', run.agent_id,
              COALESCE(decision.policy_version, 'not-applicable-v1'),
              'engineering-run-v1', 'mvp-engineering-autonomy-v1',
              'agent_run', run.id, jsonb_build_object('agentRunEventType', $2::text)
       FROM public.agent_run run
       JOIN public.task task ON task.id = run.task_id AND task.workspace_id = run.workspace_id
       LEFT JOIN public.message_intent_decision decision
         ON decision.message_id = task.source_message_id AND decision.workspace_id = run.workspace_id
       WHERE run.id = $3 AND run.workspace_id = $4`,
      [randomUUID(), event.eventType, target.id, target.workspaceId]
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
