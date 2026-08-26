import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import {
  AgentRunProviderError,
  mapProviderOutcomeToAgentRunStatus,
  readSafeCodexErrorCode,
  type AgentRunStatus,
  type AgentRunProvider,
  type AgentRunProviderInput,
  type AgentRunProviderObserver,
  type ProviderClarificationAnswers,
  type ProviderClarificationRequest,
  type ProviderNotification
} from '../lib/server/provider/agent-run.js';
import {
  appendAgentRunEvent,
  type AgentRunEventInput
} from '../lib/server/provider/agent-run-events.js';

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
  provider_input: string;
  credential_store_reference: string;
  provider_thread_id: string | null;
  active_turn_id: string | null;
  resume_clarification_id: string | null;
  lease_token: string;
  recovering: boolean;
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
    },
    async clarificationRequested(request) {
      return requestClarificationAndWait(pool, claim, request, executionAbort.signal);
    },
    async clarificationDelivered(providerRequestId) {
      await markClarificationDelivered(pool, claim, providerRequestId);
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
    if (claim.resume_clarification_id) {
      await pool.query(
        `UPDATE public.agent_run_clarification
         SET delivery_attempted_at = COALESCE(delivery_attempted_at, now())
         WHERE id = $1 AND agent_run_id = $2`,
        [claim.resume_clarification_id, claim.id]
      );
    }
    await provider.execute({
      signal: executionAbort.signal,
      credentialStoreReference: claim.credential_store_reference,
      workspaceDirectory,
      prompt: claim.provider_input,
      ...(claim.resume_clarification_id && claim.provider_thread_id
        ? { providerThreadId: claim.provider_thread_id }
        : {}),
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
      provider_input: string;
      provider_thread_id: string | null;
      active_turn_id: string | null;
      credential_store_reference: string;
      status: AgentRunStatus;
      recovering: boolean;
      resume_clarification_id: string | null;
    }>(
      `SELECT run.id, run.workspace_id, run.provider_connection_id,
              COALESCE(answer.body, task.request_snapshot) AS provider_input,
              run.provider_thread_id, run.active_turn_id,
              connection.credential_store_reference,
              run.status,
              (run.lease_expires_at IS NOT NULL AND run.lease_expires_at <= $1) AS recovering,
              clarification.id AS resume_clarification_id
       FROM public.agent_run run
       JOIN public.task task ON task.id = run.task_id
       JOIN public.provider_connection connection ON connection.id = run.provider_connection_id
       LEFT JOIN LATERAL (
         SELECT pending.id, pending.answer_message_id
         FROM public.agent_run_clarification pending
         WHERE pending.agent_run_id = run.id
           AND pending.status = 'answered' AND pending.delivery_attempted_at IS NULL
         ORDER BY pending.answered_at DESC, pending.id DESC
         LIMIT 1
       ) clarification ON true
       LEFT JOIN public.message answer ON answer.id = clarification.answer_message_id
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
      provider_input: row.provider_input,
      credential_store_reference: row.credential_store_reference,
      provider_thread_id: row.provider_thread_id,
      active_turn_id: row.active_turn_id,
      resume_clarification_id: row.resume_clarification_id,
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
  const clarificationStatus = await recoverClarificationBoundary(pool, claim);
  if (clarificationStatus) {
    return { kind: 'recovered', agentRunId: claim.id, status: clarificationStatus };
  }
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

async function recoverClarificationBoundary(
  pool: Pool,
  claim: ClaimedAgentRun
): Promise<'waiting_for_input' | 'queued' | undefined> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{ id: string; status: 'pending' | 'answered' }>(
      `SELECT clarification.id, clarification.status
       FROM public.agent_run_clarification clarification
       JOIN public.agent_run run ON run.id = clarification.agent_run_id
       WHERE clarification.agent_run_id = $1
         AND clarification.delivery_attempted_at IS NULL
       ORDER BY clarification.created_at DESC, clarification.id DESC
       LIMIT 1
       FOR UPDATE OF clarification, run`,
      [claim.id]
    );
    const clarification = result.rows[0];
    if (!clarification) {
      await client.query('COMMIT');
      return undefined;
    }
    const status = clarification.status === 'answered' ? 'queued' : 'waiting_for_input';
    await appendRunEventWithClient(client, claim, {
      eventType: clarification.status === 'answered'
        ? 'run.clarification_requeued'
        : 'run.clarification_wait_recovered',
      status,
      summary: clarification.status === 'answered'
        ? 'Clarification retained; continuing on the existing Provider thread'
        : 'Clarification remains open for a Pilot member',
      evidence: { clarificationId: clarification.id },
      clearActiveTurn: clarification.status === 'answered',
      releaseLease: true
    });
    await client.query('COMMIT');
    return status;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE public.agent_run SET active_turn_id = $3, updated_at = now()
       WHERE id = $1 AND lease_token = $2`,
      [claim.id, claim.lease_token, turnId]
    );
    if (updated.rowCount !== 1) throw new Error('AgentRun execution lease was lost');
    if (claim.resume_clarification_id) {
      await client.query(
        `UPDATE public.agent_run_clarification
         SET delivered_at = COALESCE(delivered_at, now())
         WHERE id = $1 AND agent_run_id = $2`,
        [claim.resume_clarification_id, claim.id]
      );
    }
    await appendRunEventWithClient(client, claim, {
      eventType: 'provider.turn.started',
      status: 'working',
      summary: 'Codex turn started',
      evidence: { provider: 'codex' },
      providerEventId: `turn:${turnId}:started`,
      providerTurnId: turnId
    });
    await client.query('COMMIT');
    claim.active_turn_id = turnId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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

async function requestClarificationAndWait(
  pool: Pool,
  claim: ClaimedAgentRun,
  request: ProviderClarificationRequest,
  signal: AbortSignal
): Promise<ProviderClarificationAnswers> {
  if (request.threadId !== claim.provider_thread_id || request.turnId !== claim.active_turn_id) {
    throw new Error('Provider clarification does not match the active AgentRun turn');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = await client.query<{
      source_message_id: string;
      root_message_id: string;
      agent_member_id: string;
      channel_id: string;
    }>(
      `SELECT task.source_message_id,
              COALESCE(source.parent_message_id, source.id) AS root_message_id,
              agent_member.id AS agent_member_id,
              source.channel_id
       FROM public.agent_run run
       JOIN public.task task ON task.id = run.task_id
       JOIN public.message source ON source.id = task.source_message_id
       JOIN public.workspace_member agent_member
         ON agent_member.agent_id = run.agent_id
        AND agent_member.workspace_id = run.workspace_id
       WHERE run.id = $1 AND run.workspace_id = $2 AND run.lease_token = $3
       FOR UPDATE OF run`,
      [claim.id, claim.workspace_id, claim.lease_token]
    );
    const context = run.rows[0];
    if (!context) throw new Error('AgentRun execution lease was lost');

    const existing = await client.query<{ id: string }>(
      `SELECT id FROM public.agent_run_clarification
       WHERE agent_run_id = $1 AND provider_request_id = $2`,
      [claim.id, request.providerRequestId]
    );
    if (!existing.rows[0]) {
      const clarificationId = randomUUID();
      const requestMessageId = randomUUID();
      await client.query(
        `INSERT INTO public.message (
           id, workspace_id, channel_id, author_workspace_member_id, parent_message_id, body
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          requestMessageId,
          claim.workspace_id,
          context.channel_id,
          context.agent_member_id,
          context.root_message_id,
          visibleClarificationRequest(request)
        ]
      );
      await client.query(
        `INSERT INTO public.notification_outbox (
           workspace_id, message_id, topic, payload
         ) VALUES ($1, $2, 'channel.message', $3)`,
        [claim.workspace_id, requestMessageId, { messageId: requestMessageId }]
      );
      await client.query(
        `INSERT INTO public.agent_run_clarification (
           id, workspace_id, agent_run_id, provider_request_id, provider_turn_id,
           provider_item_id, questions, request_message_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          clarificationId,
          claim.workspace_id,
          claim.id,
          request.providerRequestId,
          request.turnId,
          request.itemId,
          JSON.stringify(request.questions),
          requestMessageId
        ]
      );
      await appendRunEventWithClient(client, claim, {
        eventType: 'run.clarification_requested',
        status: 'waiting_for_input',
        summary: 'Waiting for a Pilot member to clarify the request',
        evidence: { clarificationId, providerItemId: request.itemId }
      });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  while (!signal.aborted) {
    const answer = await pool.query<{ id: string; answers: ProviderClarificationAnswers }>(
      `SELECT id, answers FROM public.agent_run_clarification
       WHERE agent_run_id = $1 AND provider_request_id = $2 AND status = 'answered'`,
      [claim.id, request.providerRequestId]
    );
    if (answer.rows[0]) {
      await pool.query(
        `UPDATE public.agent_run_clarification
         SET delivery_attempted_at = COALESCE(delivery_attempted_at, now())
         WHERE id = $1`,
        [answer.rows[0].id]
      );
      return answer.rows[0].answers;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('AgentRun clarification stopped after its execution lease was lost');
}

async function markClarificationDelivered(
  pool: Pool,
  claim: ClaimedAgentRun,
  providerRequestId: string
): Promise<void> {
  const updated = await pool.query(
    `UPDATE public.agent_run_clarification
     SET delivered_at = COALESCE(delivered_at, now())
     WHERE agent_run_id = $1 AND provider_request_id = $2
       AND delivery_attempted_at IS NOT NULL`,
    [claim.id, providerRequestId]
  );
  if (updated.rowCount !== 1) {
    throw new Error('AgentRun clarification delivery boundary changed');
  }
}

function visibleClarificationRequest(request: ProviderClarificationRequest): string {
  const questions = request.questions.map(({ header, question, options }) => {
    const choices = options?.length
      ? ` Options: ${options.map(({ label }) => label).join(', ')}.`
      : '';
    return `${header}: ${question}${choices}`;
  });
  return `Quick clarification: ${questions.join('\n')} Reply in this thread to continue.`.slice(0, 4000);
}

async function appendRunEvent(
  pool: Pool,
  claim: ClaimedAgentRun,
  event: AgentRunEventInput
): Promise<void> {
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
  event: AgentRunEventInput
): Promise<void> {
  await appendAgentRunEvent(client, {
    id: claim.id,
    workspaceId: claim.workspace_id,
    requiredLeaseToken: claim.lease_token
  }, event);
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
