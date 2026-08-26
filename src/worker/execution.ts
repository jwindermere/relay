import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import {
  AgentRunProviderError,
  mapProviderOutcomeToAgentRunStatus,
  readSafeCodexErrorCode,
  type AgentRunProvider,
  type AgentRunProviderInput,
  type AgentRunProviderObserver,
  type ProviderNotification
} from '../lib/server/provider/agent-run.js';

type AgentRunStatus =
  | 'queued'
  | 'planning'
  | 'working'
  | 'waiting_for_input'
  | 'waiting_for_approval'
  | 'recovering'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface WorkerExecutionOptions {
  workerId: string;
  workspaceRoot: string;
  leaseDurationMs?: number;
  retryDelayMs?: number;
  now?: () => Date;
}

export type WorkerCycleResult =
  | { kind: 'idle' }
  | { kind: 'executed'; agentRunId: string; status: AgentRunStatus }
  | { kind: 'deferred'; agentRunId: string; reason: string }
  | { kind: 'recovered'; agentRunId: string; status: AgentRunStatus };

interface ClaimedAgentRun {
  id: string;
  workspace_id: string;
  request_snapshot: string;
  credential_store_reference: string;
  provider_thread_id: string | null;
  active_turn_id: string | null;
  lease_token: string;
  recovering: boolean;
}

interface RunEvent {
  eventType: string;
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

export async function processNextAgentRun(
  pool: Pool,
  provider: AgentRunProvider,
  options: WorkerExecutionOptions
): Promise<WorkerCycleResult> {
  const leaseDurationMs = options.leaseDurationMs ?? 30_000;
  const retryDelayMs = options.retryDelayMs ?? 30_000;
  const now = options.now ?? (() => new Date());
  const claim = await claimNextAgentRun(pool, options.workerId, leaseDurationMs, now());
  if (!claim) return { kind: 'idle' };

  if (claim.recovering) {
    return recoverAgentRun(pool, provider, claim);
  }

  const workspaceDirectory = await prepareAgentRunWorkspace(options.workspaceRoot, claim.id);
  const updated = await pool.query(
    `UPDATE public.agent_run
     SET workspace_directory = $4, updated_at = now()
     WHERE id = $1 AND lease_owner = $2 AND lease_token = $3`,
    [claim.id, options.workerId, claim.lease_token, workspaceDirectory]
  );
  if (updated.rowCount !== 1) throw new Error('AgentRun execution lease was lost');

  let terminalStatus: AgentRunStatus | undefined;
  const observer: AgentRunProviderObserver = {
    async threadStarted(threadId) {
      await persistProviderThread(pool, claim, threadId);
    },
    async turnStarted(turnId) {
      await persistProviderTurn(pool, claim, turnId);
    },
    async notification(notification) {
      terminalStatus = await persistProviderNotification(pool, claim, notification)
        ?? terminalStatus;
    }
  };

  const executionAbort = new AbortController();
  const renewal = setInterval(() => {
    void renewLease(pool, claim, leaseDurationMs)
      .then((renewed) => { if (!renewed) executionAbort.abort(); })
      .catch(() => executionAbort.abort());
  }, Math.max(250, Math.floor(leaseDurationMs / 3)));
  renewal.unref();

  try {
    await provider.execute({
      signal: executionAbort.signal,
      credentialStoreReference: claim.credential_store_reference,
      workspaceDirectory,
      prompt: claim.request_snapshot,
      approvalPolicy: 'onRequest',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [workspaceDirectory],
        readOnlyAccess: {
          type: 'restricted',
          includePlatformDefaults: true,
          readableRoots: [workspaceDirectory]
        },
        networkAccess: false
      }
    }, observer);

    if (!terminalStatus) {
      await appendRunEvent(pool, claim, {
        eventType: 'run.failed',
        status: 'failed',
        summary: 'Codex stopped without a terminal turn result',
        evidence: { reason: 'missing_terminal_event' },
        completed: true,
        clearActiveTurn: true
      });
      terminalStatus = 'failed';
    }
    return { kind: 'executed', agentRunId: claim.id, status: terminalStatus };
  } catch (error) {
    if (error instanceof AgentRunProviderError
      && (error.code === 'provider_limit' || error.code === 'provider_unavailable')) {
      if (claim.provider_thread_id) {
        await pauseUncertainAgentRun(pool, claim, error);
        return { kind: 'executed', agentRunId: claim.id, status: 'paused' };
      }
      await deferAgentRun(pool, claim, error, retryDelayMs);
      return { kind: 'deferred', agentRunId: claim.id, reason: error.code };
    }

    await appendRunEvent(pool, claim, {
      eventType: 'run.failed',
      status: 'failed',
      summary: 'Codex execution failed',
      evidence: {
        reason: error instanceof AgentRunProviderError ? error.code : 'provider_failed'
      },
      completed: true,
      clearActiveTurn: true
    });
    return { kind: 'executed', agentRunId: claim.id, status: 'failed' };
  } finally {
    clearInterval(renewal);
  }
}

async function claimNextAgentRun(
  pool: Pool,
  workerId: string,
  leaseDurationMs: number,
  now: Date
): Promise<ClaimedAgentRun | undefined> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const candidate = await client.query<{
      id: string;
      workspace_id: string;
      provider_connection_id: string;
      request_snapshot: string;
      provider_thread_id: string | null;
      active_turn_id: string | null;
      credential_store_reference: string;
      status: AgentRunStatus;
      recovering: boolean;
    }>(
      `SELECT run.id, run.workspace_id, run.provider_connection_id,
              task.request_snapshot, run.provider_thread_id, run.active_turn_id,
              connection.credential_store_reference,
              run.status,
              (run.lease_expires_at IS NOT NULL AND run.lease_expires_at <= $1) AS recovering
       FROM public.agent_run run
       JOIN public.task task ON task.id = run.task_id
       JOIN public.provider_connection connection ON connection.id = run.provider_connection_id
       WHERE connection.status = 'ready'
         AND (
           (run.lease_expires_at IS NOT NULL AND run.lease_expires_at <= $1
             AND run.status NOT IN ('completed', 'failed', 'cancelled'))
           OR (run.status = 'queued' AND run.available_at <= $1 AND run.lease_expires_at IS NULL)
         )
       ORDER BY
         CASE WHEN run.lease_expires_at IS NOT NULL THEN 0 ELSE 1 END,
         run.created_at, run.id
       FOR UPDATE OF run SKIP LOCKED
       LIMIT 1`,
      [now]
    );
    const row = candidate.rows[0];
    if (!row) {
      await client.query('COMMIT');
      return undefined;
    }

    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      row.provider_connection_id
    ]);
    const occupied = await client.query<{ occupied: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM public.agent_run
         WHERE provider_connection_id = $1 AND id <> $2
           AND lease_expires_at > $3
           AND status NOT IN ('completed', 'failed', 'cancelled')
       ) AS occupied`,
      [row.provider_connection_id, row.id, now]
    );
    if (occupied.rows[0]?.occupied) {
      await client.query('COMMIT');
      return undefined;
    }

    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);
    const nextStatus: AgentRunStatus = row.recovering ? 'recovering' : 'planning';
    await client.query(
      `UPDATE public.agent_run
       SET status = $4, lease_owner = $2, lease_token = $3, lease_expires_at = $5,
           started_at = COALESCE(started_at, $6), updated_at = $6
       WHERE id = $1`,
      [row.id, workerId, leaseToken, nextStatus, leaseExpiresAt, now]
    );
    await appendRunEventWithClient(client, {
      id: row.id,
      workspace_id: row.workspace_id,
      lease_token: leaseToken
    }, {
      eventType: row.recovering ? 'run.recovering' : 'run.claimed',
      status: nextStatus,
      summary: row.recovering
        ? 'Worker lease expired; reconciling the recorded Codex turn'
        : 'Engineering request claimed for execution',
      evidence: { workerId }
    });
    await client.query('COMMIT');
    return {
      id: row.id,
      workspace_id: row.workspace_id,
      request_snapshot: row.request_snapshot,
      credential_store_reference: row.credential_store_reference,
      provider_thread_id: row.provider_thread_id,
      active_turn_id: row.active_turn_id,
      lease_token: leaseToken,
      recovering: row.recovering
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function recoverAgentRun(
  pool: Pool,
  provider: AgentRunProvider,
  claim: ClaimedAgentRun
): Promise<WorkerCycleResult> {
  if (!claim.provider_thread_id || !claim.active_turn_id) {
    await appendRunEvent(pool, claim, {
      eventType: 'run.paused',
      status: 'paused',
      summary: 'Execution recovery needs human review',
      evidence: { reason: 'missing_provider_cursor' }
    });
    return { kind: 'recovered', agentRunId: claim.id, status: 'paused' };
  }

  try {
    const reconciliation = await provider.reconcile({
      threadId: claim.provider_thread_id,
      turnId: claim.active_turn_id
    });
    if (reconciliation.outcome === 'indeterminate') {
      await appendRunEvent(pool, claim, {
        eventType: 'run.paused',
        status: 'paused',
        summary: 'Codex turn outcome is uncertain; human review is required',
        evidence: { reason: 'indeterminate_provider_outcome' }
      });
      return { kind: 'recovered', agentRunId: claim.id, status: 'paused' };
    }

    const status = mapProviderOutcomeToAgentRunStatus(reconciliation.outcome);
    await appendRunEvent(pool, claim, {
      eventType: 'provider.turn.reconciled',
      status,
      summary: status === 'completed'
        ? 'Codex completion recovered'
        : status === 'cancelled' ? 'Codex interruption recovered' : 'Codex failure recovered',
      evidence: { outcome: reconciliation.outcome, errorCode: reconciliation.errorCode },
      completed: true,
      clearActiveTurn: true
    });
    return { kind: 'recovered', agentRunId: claim.id, status };
  } catch {
    await appendRunEvent(pool, claim, {
      eventType: 'run.paused',
      status: 'paused',
      summary: 'Codex was unavailable during recovery; human review is required',
      evidence: { reason: 'provider_unavailable_during_recovery' }
    });
    return { kind: 'recovered', agentRunId: claim.id, status: 'paused' };
  }
}

async function prepareAgentRunWorkspace(root: string, agentRunId: string): Promise<string> {
  const resolvedRoot = resolve(root);
  const workspaceDirectory = resolve(resolvedRoot, agentRunId);
  if (!workspaceDirectory.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error('AgentRun workspace escaped its configured root');
  }
  await mkdir(workspaceDirectory, { recursive: true, mode: 0o700 });
  return workspaceDirectory;
}

async function persistProviderThread(
  pool: Pool,
  claim: ClaimedAgentRun,
  threadId: string
): Promise<void> {
  const updated = await pool.query(
    `UPDATE public.agent_run
     SET provider_thread_id = COALESCE(provider_thread_id, $3), updated_at = now()
     WHERE id = $1 AND lease_token = $2 AND lease_owner IS NOT NULL
       AND (provider_thread_id IS NULL OR provider_thread_id = $3)`,
    [claim.id, claim.lease_token, threadId]
  );
  if (updated.rowCount !== 1) throw new Error('AgentRun lease or Provider thread changed');
  claim.provider_thread_id = threadId;
  await appendRunEvent(pool, claim, {
    eventType: 'provider.thread.started',
    status: 'planning',
    summary: 'Codex thread started',
    evidence: { provider: 'codex' },
    providerEventId: `thread:${threadId}:started`
  });
}

async function persistProviderTurn(
  pool: Pool,
  claim: ClaimedAgentRun,
  turnId: string
): Promise<void> {
  const updated = await pool.query(
    `UPDATE public.agent_run SET active_turn_id = $3, updated_at = now()
     WHERE id = $1 AND lease_token = $2`,
    [claim.id, claim.lease_token, turnId]
  );
  if (updated.rowCount !== 1) throw new Error('AgentRun execution lease was lost');
  claim.active_turn_id = turnId;
  await appendRunEvent(pool, claim, {
    eventType: 'provider.turn.started',
    status: 'working',
    summary: 'Codex turn started',
    evidence: { provider: 'codex' },
    providerEventId: `turn:${turnId}:started`,
    providerTurnId: turnId
  });
}

async function persistProviderNotification(
  pool: Pool,
  claim: ClaimedAgentRun,
  notification: ProviderNotification
): Promise<AgentRunStatus | undefined> {
  if (notification.method === 'turn/completed' && notification.turn) {
    const errorCode = readSafeCodexErrorCode(notification.turn.error?.codexErrorInfo);
    const status = mapProviderOutcomeToAgentRunStatus(notification.turn.status);
    await appendRunEvent(pool, claim, {
      eventType: 'provider.turn.completed',
      status,
      summary: errorCode === 'UsageLimitExceeded'
        ? 'Codex usage limit reached'
        : status === 'completed'
        ? 'Engineering request completed'
        : status === 'cancelled' ? 'Engineering request cancelled' : 'Codex turn failed',
      evidence: {
        provider: 'codex',
        outcome: notification.turn.status,
        errorCode
      },
      providerEventId: notification.providerEventId,
      providerTurnId: notification.turn.id,
      completed: true,
      clearActiveTurn: true
    });
    return status;
  }

  const itemId = notification.item?.id;
  const itemType = safeItemType(notification.item?.type);
  await appendRunEvent(pool, claim, {
    eventType: notification.method === 'item/started'
      ? 'provider.item.started'
      : 'provider.item.completed',
    status: 'working',
    summary: notification.method === 'item/started'
      ? `${itemType} started`
      : `${itemType} completed`,
    evidence: { provider: 'codex', itemType },
    providerEventId: notification.providerEventId,
    providerTurnId: claim.active_turn_id ?? undefined,
    providerItemId: itemId
  });
  return undefined;
}

function safeItemType(value: unknown): string {
  if (typeof value !== 'string') return 'Codex activity';
  const summaries: Record<string, string> = {
    agentMessage: 'Agent response',
    commandExecution: 'Command',
    fileChange: 'File change',
    mcpToolCall: 'Tool call',
    plan: 'Plan',
    reasoning: 'Planning'
  };
  return summaries[value] ?? 'Codex activity';
}

async function appendRunEvent(pool: Pool, claim: ClaimedAgentRun, event: RunEvent): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await appendRunEventWithClient(client, claim, event);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function appendRunEventWithClient(
  client: PoolClient,
  claim: Pick<ClaimedAgentRun, 'id' | 'workspace_id' | 'lease_token'>,
  event: RunEvent
): Promise<void> {
  const leased = await client.query(
    'SELECT id FROM public.agent_run WHERE id = $1 AND lease_token = $2 FOR UPDATE',
    [claim.id, claim.lease_token]
  );
  if (!leased.rowCount) throw new Error('AgentRun execution lease was lost');
  if (event.providerEventId) {
    const duplicate = await client.query(
      `SELECT 1 FROM public.agent_run_event
       WHERE agent_run_id = $1 AND provider_event_id = $2`,
      [claim.id, event.providerEventId]
    );
    if (duplicate.rowCount) return;
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
      claim.id,
      claim.workspace_id,
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
    [claim.workspace_id, eventId, {
      agentRunId: claim.id,
      eventType: event.eventType,
      sequence
    }]
  );
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
      claim.id,
      claim.workspace_id,
      event.status,
      event.clearActiveTurn ?? false,
      event.completed ?? false,
      event.releaseLease ?? false
    ]
  );
}

async function renewLease(
  pool: Pool,
  claim: ClaimedAgentRun,
  leaseDurationMs: number
): Promise<boolean> {
  const renewed = await pool.query(
    `UPDATE public.agent_run
     SET lease_expires_at = now() + ($3::integer * interval '1 millisecond'), updated_at = now()
     WHERE id = $1 AND lease_token = $2
       AND status NOT IN ('completed', 'failed', 'cancelled', 'paused')`,
    [claim.id, claim.lease_token, leaseDurationMs]
  );
  return renewed.rowCount === 1;
}

async function deferAgentRun(
  pool: Pool,
  claim: ClaimedAgentRun,
  error: AgentRunProviderError,
  retryDelayMs: number
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE public.agent_run
       SET status = 'queued', available_at = now() + ($3::integer * interval '1 millisecond'),
           last_error_code = $4, updated_at = now()
       WHERE id = $1 AND lease_token = $2`,
      [claim.id, claim.lease_token, retryDelayMs, error.code]
    );
    await appendRunEventWithClient(client, claim, {
      eventType: 'run.deferred',
      status: 'queued',
      summary: error.code === 'provider_limit'
        ? 'Codex usage limit reached; execution remains queued'
        : 'Codex is unavailable; execution remains queued',
      evidence: { reason: error.code },
      releaseLease: true
    });
    await client.query('COMMIT');
  } catch (transactionError) {
    await client.query('ROLLBACK');
    throw transactionError;
  } finally {
    client.release();
  }
}

async function pauseUncertainAgentRun(
  pool: Pool,
  claim: ClaimedAgentRun,
  error: AgentRunProviderError
): Promise<void> {
  await appendRunEvent(pool, claim, {
    eventType: 'run.paused',
    status: 'paused',
    summary: error.code === 'provider_limit'
      ? 'Codex usage limit interrupted execution; human review is required'
      : 'Codex became unavailable; human review is required',
    evidence: { reason: error.code, providerOutcome: 'indeterminate' }
  });
}
