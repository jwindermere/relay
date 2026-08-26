import type { Pool } from 'pg';

import type { VisibleAgentRunStatus } from '../../reconciliation.js';
import type { WorkspaceAccess } from '../authentication/authorization.js';
import {
  loadAuthorizedChannelMessages,
  type ChannelMessage
} from './channel.js';

export type AgentRunStatus = VisibleAgentRunStatus;

export interface ReconciledAgentRunEvent {
  sequence: number;
  status: AgentRunStatus;
  summary: string;
}

export interface ReconciledAgentRun {
  id: string;
  sourceMessageId: string;
  status: AgentRunStatus;
  summary: string;
  sequence: number;
  events: ReconciledAgentRunEvent[];
}

export interface ChannelReconciliation {
  channelId: string;
  messages: ChannelMessage[];
  runs: ReconciledAgentRun[];
}

interface RunRow {
  id: string;
  source_message_id: string;
  status: AgentRunStatus;
  sequence: number;
}

interface EventRow {
  agent_run_id: string;
  sequence: number;
  status: AgentRunStatus;
}

export async function loadChannelReconciliation(
  pool: Pool,
  access: WorkspaceAccess,
  channelId: string,
  afterSequences: Readonly<Record<string, number>>
): Promise<ChannelReconciliation> {
  const messages = await loadAuthorizedChannelMessages(pool, access, channelId);
  const runs = await pool.query<RunRow>(
    `SELECT run.id, task.source_message_id, run.status,
            latest.sequence
     FROM public.message source_message
     JOIN public.task task ON task.source_message_id = source_message.id
     JOIN public.agent_run run ON run.task_id = task.id
     JOIN LATERAL (
       SELECT event.sequence
       FROM public.agent_run_event event
       WHERE event.agent_run_id = run.id
       ORDER BY event.sequence DESC
       LIMIT 1
     ) latest ON true
     WHERE source_message.channel_id = $1
       AND source_message.workspace_id = $2
     ORDER BY run.created_at, run.id`,
    [channelId, access.workspace.id]
  );

  const runIds = runs.rows.map(({ id }) => id);
  const events = runIds.length === 0
    ? { rows: [] as EventRow[] }
    : await pool.query<EventRow>(
        `SELECT event.agent_run_id, event.sequence, event.status
         FROM public.agent_run_event event
         WHERE event.agent_run_id = ANY($1::text[])
         ORDER BY event.agent_run_id, event.sequence`,
        [runIds]
      );
  const eventsByRun = new Map<string, ReconciledAgentRunEvent[]>();
  for (const event of events.rows) {
    const after = readAfterSequence(afterSequences[event.agent_run_id]);
    if (event.sequence <= after) continue;
    const runEvents = eventsByRun.get(event.agent_run_id) ?? [];
    runEvents.push({
      sequence: event.sequence,
      status: event.status,
      summary: visibleAgentRunSummary(event.status)
    });
    eventsByRun.set(event.agent_run_id, runEvents);
  }

  return {
    channelId,
    messages,
    runs: runs.rows.map((run) => ({
      id: run.id,
      sourceMessageId: run.source_message_id,
      status: run.status,
      summary: visibleAgentRunSummary(run.status),
      sequence: run.sequence,
      events: eventsByRun.get(run.id) ?? []
    }))
  };
}

function visibleAgentRunSummary(status: AgentRunStatus): string {
  const summaries: Record<AgentRunStatus, string> = {
    queued: 'Engineering request queued',
    planning: 'Planning the request',
    working: 'Working on the request',
    waiting_for_input: 'Waiting for a reply',
    waiting_for_approval: 'Waiting for approval',
    recovering: 'Reconnecting to existing work',
    paused: 'Needs review before continuing',
    completed: 'Engineering request completed',
    failed: 'Engineering request failed',
    cancelled: 'Engineering request cancelled'
  };
  return summaries[status];
}

function readAfterSequence(value: number | undefined): number {
  return Number.isSafeInteger(value) && value! >= 0 ? value! : 0;
}
