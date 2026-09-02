import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { normalizeCollaborationEvaluationEvidence } from './accountability.js';

export interface CollaborationEvaluationEventInput {
  workspaceId: string;
  projectId: string;
  eventType: string;
  agentId: string | null;
  agentType?: string | null;
  routingPolicyVersion?: string | null;
  promptVersion?: string | null;
  permissionPolicyVersion?: string | null;
  agentConfigurationVersion?: string | null;
  outcomeType: string;
  outcomeId: string;
  evidence?: Record<string, unknown>;
}

export async function recordCollaborationEvaluationEvent(
  client: PoolClient,
  input: CollaborationEvaluationEventInput
): Promise<void> {
  await client.query(
    `INSERT INTO public.collaboration_evaluation_event (
       id, workspace_id, project_id, event_type, agent_id,
       agent_type, routing_policy_version, prompt_version, permission_policy_version,
       agent_configuration_version, outcome_type, outcome_id, evidence
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      randomUUID(), input.workspaceId, input.projectId, input.eventType, input.agentId,
      input.agentType ?? null,
      input.routingPolicyVersion ?? 'not-applicable-v1',
      input.promptVersion ?? 'not-applicable-v1',
      input.permissionPolicyVersion ?? 'not-applicable-v1',
      input.agentConfigurationVersion ?? null,
      input.outcomeType, input.outcomeId,
      normalizeCollaborationEvaluationEvidence(input.evidence ?? {})
    ]
  );
}
