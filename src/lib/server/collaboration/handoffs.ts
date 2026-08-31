import type { Pool, PoolClient } from 'pg';

import type { WorkspaceAccess } from '../authentication/authorization.js';
import { recordCollaborationEvaluationEvent } from './evaluation.js';

export type AgentHandoffStatus =
  | 'queued'
  | 'working'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

export class AgentHandoffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentHandoffError';
  }
}

export async function enqueueAgentHandoffStatus(
  client: PoolClient,
  workspaceId: string,
  handoffId: string,
  status: AgentHandoffStatus
): Promise<void> {
  await client.query(
    `INSERT INTO public.notification_outbox (
       workspace_id, agent_handoff_id, topic, payload
     ) VALUES ($1, $2, 'agent_handoff.status', $3)`,
    [workspaceId, handoffId, { agentHandoffId: handoffId, status }]
  );
}

export async function cancelAgentHandoff(
  pool: Pool,
  access: WorkspaceAccess,
  handoffId: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cancelled = await client.query<{
      id: string; receiving_turn_id: string; project_id: string; target_agent_id: string;
    }>(
      `UPDATE public.agent_handoff handoff
       SET status = 'cancelled', cancelled_at = now(), updated_at = now(),
           error_code = 'handoff_cancelled',
           outcome_snapshot = jsonb_build_object(
             'kind', 'cancelled', 'errorCode', 'handoff_cancelled'
           )
       FROM public.workspace_member actor
       JOIN public.project_membership membership
         ON membership.workspace_member_id = actor.id
        AND membership.workspace_id = actor.workspace_id
       WHERE handoff.id = $1 AND handoff.workspace_id = $2
         AND actor.workspace_id = handoff.workspace_id
         AND actor.kind = 'pilot' AND actor.pilot_membership_id = $3
         AND membership.project_id = handoff.project_id
         AND handoff.status = 'queued'
       RETURNING handoff.id, handoff.receiving_turn_id, handoff.project_id, handoff.target_agent_id`,
      [handoffId, access.workspace.id, access.membership.id]
    );
    const row = cancelled.rows[0];
    if (!row) {
      throw new AgentHandoffError('Queued Agent handoff was not found');
    }
    const evaluation = await client.query<{
      routing_policy_version: string | null; agent_configuration_version: number;
      agent_type_snapshot: string;
    }>(
      `SELECT decision.policy_version AS routing_policy_version,
              turn.agent_configuration_version, turn.agent_type_snapshot
       FROM public.agent_conversation_turn turn
       JOIN public.message request ON request.id = turn.request_message_id
       LEFT JOIN public.message_intent_decision decision ON decision.message_id = request.id
       WHERE turn.id = $1 AND turn.workspace_id = $2`,
      [row.receiving_turn_id, access.workspace.id]
    );
    const attribution = evaluation.rows[0];
    if (!attribution) throw new AgentHandoffError('Agent handoff attribution was not found');
    await client.query(
      `UPDATE public.agent_conversation_turn
       SET status = 'failed', error_code = 'handoff_cancelled',
           completed_at = now(), updated_at = now()
       WHERE id = $1 AND workspace_id = $2 AND status = 'queued'`,
      [row.receiving_turn_id, access.workspace.id]
    );
    await enqueueAgentHandoffStatus(client, access.workspace.id, row.id, 'cancelled');
    await recordCollaborationEvaluationEvent(client, {
      workspaceId: access.workspace.id, projectId: row.project_id,
      eventType: 'outcome.cancelled', agentId: row.target_agent_id,
      routingPolicyVersion: attribution.routing_policy_version,
      agentConfigurationVersion: `agent-config-${attribution.agent_configuration_version}`,
      agentType: attribution.agent_type_snapshot,
      promptVersion: 'conversation-v1', permissionPolicyVersion: 'handoff-depth-v1',
      outcomeType: 'handoff', outcomeId: row.id,
      evidence: { status: 'cancelled', errorCode: 'handoff_cancelled' }
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
