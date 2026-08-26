import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import {
  isTerminalAgentRunStatus,
  type AgentRunStatus
} from '../provider/agent-run.js';
import { appendAgentRunEvent } from '../provider/agent-run-events.js';

interface AgentRunCommandContext {
  messageId: string;
  workspaceId: string;
  channelId: string;
  parentMessageId: string;
  body: string;
}

interface ThreadAgentRun {
  id: string;
  task_id: string;
  status: AgentRunStatus;
  attempt_number: number;
  agent_id: string;
  provider_connection_id: string;
  linked_repository_id: string;
  author_workspace_member_id: string;
  has_execution_boundary: boolean;
  task_status: 'open' | 'completed' | 'cancelled';
  retry_ready: boolean;
}

export async function handleAgentRunCommand(
  client: PoolClient,
  context: AgentRunCommandContext
): Promise<boolean> {
  const command = readCommand(context.body);
  if (!command) return false;
  const run = await findThreadAgentRun(client, context);
  if (!run) return false;
  if (command === 'cancel') {
    return requestCancellation(client, context, run);
  }
  return requestRetry(client, context, run);
}

async function requestCancellation(
  client: PoolClient,
  context: AgentRunCommandContext,
  run: ThreadAgentRun
): Promise<boolean> {
  await client.query(
    `INSERT INTO public.agent_run_cancellation_request (
       id, workspace_id, agent_run_id, request_message_id,
       requested_by_workspace_member_id
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (request_message_id) DO NOTHING`,
    [randomUUID(), context.workspaceId, run.id, context.messageId, run.author_workspace_member_id]
  );
  if (isTerminalAgentRunStatus(run.status)) return true;
  await appendAgentRunEvent(client, {
    id: run.id,
    workspaceId: context.workspaceId
  }, {
    eventType: 'run.cancellation_requested',
    status: run.status,
    summary: 'A Pilot member requested cancellation',
    evidence: {
      requestedByWorkspaceMemberId: run.author_workspace_member_id,
      requestMessageId: context.messageId
    }
  });
  if (!run.has_execution_boundary && run.status === 'queued') {
    await appendAgentRunEvent(client, {
      id: run.id,
      workspaceId: context.workspaceId
    }, {
      eventType: 'provider.turn.reconciled',
      status: 'cancelled',
      summary: 'Queued engineering request cancelled before Provider execution',
      evidence: { outcome: 'not_started', requestMessageId: context.messageId },
      completed: true,
      clearActiveTurn: true
    });
  }
  return true;
}

async function requestRetry(
  client: PoolClient,
  context: AgentRunCommandContext,
  run: ThreadAgentRun
): Promise<boolean> {
  const retryableOutcome = run.status === 'failed' || run.status === 'cancelled';
  if (!retryableOutcome || run.task_status === 'completed' || !run.retry_ready) return true;
  const agentRunId = randomUUID();
  const inserted = await client.query(
    `INSERT INTO public.agent_run (
       id, workspace_id, task_id, agent_id, provider_connection_id,
       linked_repository_id, attempt_number, status,
       requested_by_workspace_member_id, request_message_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, $9)
     ON CONFLICT (task_id, attempt_number) DO NOTHING`,
    [
      agentRunId,
      context.workspaceId,
      run.task_id,
      run.agent_id,
      run.provider_connection_id,
      run.linked_repository_id,
      run.attempt_number + 1,
      run.author_workspace_member_id,
      context.messageId
    ]
  );
  if (inserted.rowCount !== 1) return true;
  await client.query(
    `UPDATE public.task SET status = 'open', updated_at = now()
     WHERE id = $1 AND workspace_id = $2 AND status = 'cancelled'`,
    [run.task_id, context.workspaceId]
  );
  await appendAgentRunEvent(client, {
    id: agentRunId,
    workspaceId: context.workspaceId
  }, {
    eventType: 'run.queued',
    status: 'queued',
    summary: 'Engineering request queued for another attempt',
    evidence: {
      priorAgentRunId: run.id,
      requestedByWorkspaceMemberId: run.author_workspace_member_id,
      requestMessageId: context.messageId
    }
  });
  return true;
}

async function findThreadAgentRun(
  client: PoolClient,
  context: AgentRunCommandContext
): Promise<ThreadAgentRun | undefined> {
  const result = await client.query<ThreadAgentRun>(
    `SELECT run.id, run.task_id, run.status, run.attempt_number, run.agent_id,
            run.provider_connection_id, run.linked_repository_id,
            reply.author_workspace_member_id,
            (run.provider_thread_id IS NOT NULL OR run.active_turn_id IS NOT NULL
              OR run.lease_owner IS NOT NULL) AS has_execution_boundary,
            task.status AS task_status,
            (agent.enabled AND agent.status = 'idle' AND connection.status = 'ready'
              AND repository.ready_for_autonomous_work
              AND NOT EXISTS (
                SELECT 1 FROM public.agent_run active
                WHERE active.provider_connection_id = run.provider_connection_id
                  AND active.id <> run.id
                  AND active.status NOT IN ('completed', 'failed', 'cancelled')
              )) AS retry_ready
     FROM public.message reply
     JOIN public.message source
       ON source.channel_id = $3 AND COALESCE(source.parent_message_id, source.id) = $4
     JOIN public.task task ON task.source_message_id = source.id
     JOIN public.agent_run run ON run.task_id = task.id
     JOIN public.agent agent ON agent.id = run.agent_id
     JOIN public.provider_connection connection ON connection.id = run.provider_connection_id
     JOIN public.linked_repository repository ON repository.id = run.linked_repository_id
     WHERE reply.id = $1 AND reply.workspace_id = $2 AND reply.channel_id = $3
     ORDER BY run.created_at DESC, run.attempt_number DESC, run.id DESC
     LIMIT 1
     FOR UPDATE OF run`,
    [context.messageId, context.workspaceId, context.channelId, context.parentMessageId]
  );
  return result.rows[0];
}

function readCommand(body: string): 'cancel' | 'retry' | undefined {
  const normalized = body.trim();
  if (/^(?:please\s+)?(?:cancel|stop)(?:\s+(?:this|the))?(?:\s+(?:work|task|request|run))?[.!]?$/iu.test(normalized)) {
    return 'cancel';
  }
  if (/^(?:please\s+)?(?:retry|try)(?:\s+(?:this|the))?(?:\s+(?:work|task|request|run))?(?:\s+again)?[.!]?$/iu.test(normalized)) {
    return 'retry';
  }
  return undefined;
}
