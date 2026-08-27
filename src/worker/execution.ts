import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { postApprovalResolutionMessage } from '../lib/server/collaboration/approvals.js';
import {
  recordAgentRunFailureResult,
  type AgentRunFailureResult
} from '../lib/server/collaboration/agent-run-result.js';
import {
  recordPullRequestResult,
  type PullRequestPublication
} from '../lib/server/collaboration/pull-request-result.js';
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
  type ProviderApprovalRequest,
  type ProviderNotification
} from '../lib/server/provider/agent-run.js';
import {
  appendAgentRunEvent,
  type AgentRunEventInput
} from '../lib/server/provider/agent-run-events.js';
import type {
  AgentRunGitHubWorkspaceBroker,
  PreparedAgentRunRepository
} from '../lib/server/github/workspace.js';
import { AgentRunGitHubPublicationError } from '../lib/server/github/workspace.js';

export interface WorkerExecutionOptions {
  workerId: string;
  workspaceRoot: string;
  leaseDurationMs?: number;
  retryDelayMs?: number;
  cancellationPollMs?: number;
  now?: () => Date;
  githubWorkspaceBroker?: AgentRunGitHubWorkspaceBroker;
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
  cancellation_requested: boolean;
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
  let terminalNotification: ProviderNotification | undefined;
  const observer: AgentRunProviderObserver = {
    async threadStarted(threadId) {
      await persistProviderThread(pool, claim, threadId);
    },
    async turnStarted(turnId) {
      await persistProviderTurn(pool, claim, turnId);
    },
    async notification(notification) {
      if (notification.method === 'turn/completed') {
        if (!terminalNotification) {
          terminalNotification = notification;
          terminalStatus = notification.turn
            ? mapProviderOutcomeToAgentRunStatus(notification.turn.status)
            : terminalStatus;
        }
        return;
      }
      terminalStatus = await persistProviderNotification(pool, claim, notification)
        ?? terminalStatus;
    },
    async clarificationRequested(request) {
      return requestClarificationAndWait(
        pool,
        claim,
        request,
        AbortSignal.any([executionAbort.signal, cancellationAbort.signal])
      );
    },
    async clarificationDelivered(providerRequestId) {
      await markClarificationDelivered(pool, claim, providerRequestId);
    },
    async approvalRequested(request) {
      return requestApprovalAndWait(
        pool,
        claim,
        request,
        AbortSignal.any([executionAbort.signal, cancellationAbort.signal])
      );
    },
    async actionRejected(request) {
      await recordRejectedAction(pool, claim, request);
    }
  };

  const executionAbort = new AbortController();
  const cancellationAbort = new AbortController();
  const cancellationMonitor = monitorCancellation(
    pool,
    claim.id,
    cancellationAbort,
    options.cancellationPollMs ?? 250
  );
  const renewal = setInterval(() => {
    void renewLease(pool, claim, leaseDurationMs)
      .then((renewed) => { if (!renewed) executionAbort.abort(); })
      .catch(() => executionAbort.abort());
  }, Math.max(250, Math.floor(leaseDurationMs / 3)));
  renewal.unref();
  let preparedRepository: PreparedAgentRunRepository | undefined;
  let pullRequestPublication: PullRequestPublication | undefined;
  let repositoryPublicationError: unknown;

  try {
    if (options.githubWorkspaceBroker) {
      preparedRepository = claim.provider_thread_id
        ? await options.githubWorkspaceBroker.resume(claim.id)
        : await options.githubWorkspaceBroker.prepare(claim.id, workspaceDirectory);
    }
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
      cancellationSignal: cancellationAbort.signal,
      credentialStoreReference: claim.credential_store_reference,
      workspaceDirectory,
      prompt: options.githubWorkspaceBroker
        ? `${claim.provider_input}\n\nThe repository is already checked out on your assigned branch in this credential-free workspace. Make the requested changes here; Relay will publish the branch and pull request after your turn. Do not configure a Git remote or request repository credentials.`
        : claim.provider_input,
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

    if (terminalNotification?.turn) {
      if (terminalNotification.turn.status === 'completed' && options.githubWorkspaceBroker) {
        try {
          if (!preparedRepository) {
            throw new Error('AgentRun repository preparation boundary is unavailable');
          }
          pullRequestPublication = await options.githubWorkspaceBroker.publish(
            claim.id,
            workspaceDirectory,
            preparedRepository
          );
        } catch (error) {
          repositoryPublicationError = error;
          throw error;
        }
      }
      terminalStatus = await persistProviderNotification(
        pool,
        claim,
        terminalNotification,
        pullRequestPublication
      ) ?? terminalStatus;
    }

    if (!terminalStatus) {
      if (cancellationAbort.signal.aborted) {
        await appendRunEvent(pool, claim, {
          eventType: 'run.paused',
          status: 'paused',
          summary: 'Codex interruption outcome is uncertain; human review is required',
          evidence: { reason: 'missing_cancellation_terminal_event' },
          releaseLease: true
        });
        return { kind: 'executed', agentRunId: claim.id, status: 'paused' };
      }
      await failAgentRun(pool, claim, {
        eventType: 'run.failed',
        status: 'failed',
        summary: 'Codex stopped without a terminal turn result',
        evidence: { reason: 'missing_terminal_event' },
        completed: true,
        clearActiveTurn: true
      }, 'provider_failed');
      terminalStatus = 'failed';
    }
    return { kind: 'executed', agentRunId: claim.id, status: terminalStatus };
  } catch (error) {
    if (cancellationAbort.signal.aborted) {
      await appendRunEvent(pool, claim, {
        eventType: 'run.paused',
        status: 'paused',
        summary: 'Codex interruption outcome is uncertain; human review is required',
        evidence: { reason: 'cancellation_provider_boundary_lost' },
        releaseLease: true
      });
      return { kind: 'executed', agentRunId: claim.id, status: 'paused' };
    }
    if (error instanceof AgentRunProviderError
      && (error.code === 'provider_limit' || error.code === 'provider_unavailable')) {
      if (claim.provider_thread_id) {
        await pauseUncertainAgentRun(pool, claim, error);
        return { kind: 'executed', agentRunId: claim.id, status: 'paused' };
      }
      await deferAgentRun(pool, claim, error, retryDelayMs);
      return { kind: 'deferred', agentRunId: claim.id, reason: error.code };
    }

    const failureResult: AgentRunFailureResult = repositoryPublicationError
      ? repositoryPublicationError instanceof AgentRunGitHubPublicationError
        ? repositoryPublicationError.code
        : 'github_publication_failed'
      : 'provider_failed';
    await failAgentRun(pool, claim, {
      eventType: 'run.failed',
      status: 'failed',
      summary: 'Codex execution failed',
      evidence: {
        reason: repositoryPublicationError
          ? 'github_publication_failed'
          : error instanceof AgentRunProviderError ? error.code : 'provider_failed'
      },
      completed: true,
      clearActiveTurn: true
    }, failureResult);
    return { kind: 'executed', agentRunId: claim.id, status: 'failed' };
  } finally {
    clearInterval(renewal);
    clearInterval(cancellationMonitor);
  }
}

function monitorCancellation(
  pool: Pool,
  agentRunId: string,
  controller: AbortController,
  pollMs: number
): NodeJS.Timeout {
  let checking = false;
  const check = async () => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    try {
      const result = await pool.query<{ requested: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM public.agent_run_cancellation_request
           WHERE agent_run_id = $1
         ) AS requested`,
        [agentRunId]
      );
      if (result.rows[0]?.requested) controller.abort();
    } catch {
      // A later poll retries; lease renewal independently protects execution ownership.
    } finally {
      checking = false;
    }
  };
  void check();
  const timer = setInterval(() => void check(), Math.max(25, pollMs));
  timer.unref();
  return timer;
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
      cancellation_requested: boolean;
      resume_clarification_id: string | null;
    }>(
      `SELECT run.id, run.workspace_id, run.provider_connection_id,
              COALESCE(answer.body, task.request_snapshot) AS provider_input,
              run.provider_thread_id, run.active_turn_id,
              connection.credential_store_reference,
              run.status,
              (run.lease_expires_at IS NOT NULL AND run.lease_expires_at <= $1) AS recovering,
              EXISTS (
                SELECT 1 FROM public.agent_run_cancellation_request cancellation
                WHERE cancellation.agent_run_id = run.id
              ) AS cancellation_requested,
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
       ) OR EXISTS (
         SELECT 1 FROM public.agent_conversation_turn turn
         JOIN public.agent_conversation conversation ON conversation.id = turn.conversation_id
         WHERE conversation.provider_connection_id = $1
           AND turn.lease_expires_at > $3 AND turn.status = 'working'
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
      recovering: row.recovering,
      cancellation_requested: row.cancellation_requested
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
  if (!await hasDurableProviderBoundary(pool, claim)) {
    await appendRunEvent(pool, claim, {
      eventType: 'run.paused',
      status: 'paused',
      summary: 'Recorded Provider work could not be verified; human review is required',
      evidence: { reason: 'unverified_provider_cursor' }
    });
    return { kind: 'recovered', agentRunId: claim.id, status: 'paused' };
  }
  if (claim.cancellation_requested && claim.provider_thread_id && claim.active_turn_id) {
    try {
      await provider.interrupt({
        threadId: claim.provider_thread_id,
        turnId: claim.active_turn_id,
        credentialStoreReference: claim.credential_store_reference
      });
    } catch {
      await appendRunEvent(pool, claim, {
        eventType: 'run.paused',
        status: 'paused',
        summary: 'Cancellation could not reach Codex; human review is required',
        evidence: { reason: 'provider_unavailable_during_cancellation' }
      });
      return { kind: 'recovered', agentRunId: claim.id, status: 'paused' };
    }
  }
  if (!claim.cancellation_requested) {
    const approvalStatus = await recoverApprovalBoundary(pool, claim);
    if (approvalStatus) {
      return { kind: 'recovered', agentRunId: claim.id, status: approvalStatus };
    }
    const clarificationStatus = await recoverClarificationBoundary(pool, claim);
    if (clarificationStatus) {
      return { kind: 'recovered', agentRunId: claim.id, status: clarificationStatus };
    }
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
    if (reconciliation.outcome === 'completed'
      && await hasUnresolvedRepositoryPublication(pool, claim.id)) {
      await appendRunEvent(pool, claim, {
        eventType: 'run.paused',
        status: 'paused',
        summary: 'Repository publication outcome is uncertain; human review is required',
        evidence: { reason: 'unresolved_github_publication' }
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
      providerEventId: `${claim.active_turn_id}:turn/completed`,
      providerTurnId: claim.active_turn_id,
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

async function hasUnresolvedRepositoryPublication(pool: Pool, agentRunId: string): Promise<boolean> {
  const result = await pool.query<{ broker_started: boolean; artifact_recorded: boolean }>(
    `SELECT
       EXISTS (SELECT 1 FROM public.github_broker_decision WHERE agent_run_id = $1)
         AS broker_started,
       EXISTS (SELECT 1 FROM public.artifact WHERE agent_run_id = $1)
         AS artifact_recorded`,
    [agentRunId]
  );
  return result.rows[0]?.broker_started === true && result.rows[0]?.artifact_recorded !== true;
}

async function hasDurableProviderBoundary(
  pool: Pool,
  claim: Pick<ClaimedAgentRun, 'id' | 'provider_thread_id' | 'active_turn_id'>
): Promise<boolean> {
  const evidence = await pool.query<{ thread_recorded: boolean; turn_recorded: boolean }>(
    `SELECT
       EXISTS (
         SELECT 1 FROM public.agent_run_event
         WHERE agent_run_id = $1
           AND event_type = 'provider.thread.started'
           AND provider_event_id = $2
       ) AS thread_recorded,
       EXISTS (
         SELECT 1 FROM public.agent_run_event
         WHERE agent_run_id = $1
           AND event_type = 'provider.turn.started'
           AND provider_turn_id = $3
       ) AS turn_recorded`,
    [
      claim.id,
      `thread:${claim.provider_thread_id}:started`,
      claim.active_turn_id
    ]
  );
  return evidence.rows[0]?.thread_recorded === true
    && evidence.rows[0]?.turn_recorded === true;
}

async function recoverApprovalBoundary(
  pool: Pool,
  claim: ClaimedAgentRun
): Promise<'paused' | undefined> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const approval = await client.query<{ id: string }>(
      `SELECT approval.id
       FROM public.approval approval
       JOIN public.agent_run run ON run.id = approval.agent_run_id
       WHERE approval.agent_run_id = $1
         AND approval.state IN ('pending', 'approved')
       ORDER BY approval.created_at DESC, approval.id DESC
       LIMIT 1
       FOR UPDATE OF approval, run`,
      [claim.id]
    );
    if (!approval.rows[0]) {
      await client.query('COMMIT');
      return undefined;
    }
    await client.query(
      `UPDATE public.approval SET state = 'expired'
       WHERE id = $1 AND state IN ('pending', 'approved')`,
      [approval.rows[0].id]
    );
    await postApprovalResolutionMessage(
      client,
      approval.rows[0].id,
      'recovery_expired'
    );
    await appendRunEventWithClient(client, claim, {
      eventType: 'run.paused',
      status: 'paused',
      summary: 'Approval expired after execution recovery; human review is required',
      evidence: { approvalId: approval.rows[0].id, reason: 'approval_worker_loss' }
    });
    await client.query('COMMIT');
    return 'paused';
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE public.agent_run
       SET provider_thread_id = COALESCE(provider_thread_id, $3), updated_at = now()
       WHERE id = $1 AND lease_token = $2 AND lease_owner IS NOT NULL
         AND (provider_thread_id IS NULL OR provider_thread_id = $3)`,
      [claim.id, claim.lease_token, threadId]
    );
    if (updated.rowCount !== 1) throw new Error('AgentRun lease or Provider thread changed');
    await appendRunEventWithClient(client, claim, {
      eventType: 'provider.thread.started',
      status: 'planning',
      summary: 'Codex thread started',
      evidence: { provider: 'codex' },
      providerEventId: `thread:${threadId}:started`
    });
    await client.query('COMMIT');
    claim.provider_thread_id = threadId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
  notification: ProviderNotification,
  publication?: PullRequestPublication
): Promise<AgentRunStatus | undefined> {
  if (notification.method === 'turn/completed' && notification.turn) {
    const errorCode = readSafeCodexErrorCode(notification.turn.error?.codexErrorInfo);
    const status = mapProviderOutcomeToAgentRunStatus(notification.turn.status);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await appendRunEventWithClient(client, claim, {
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
      if (publication) await recordPullRequestResult(client, publication);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const stored = await pool.query<{ status: AgentRunStatus }>(
      'SELECT status FROM public.agent_run WHERE id = $1',
      [claim.id]
    );
    return stored.rows[0]?.status ?? status;
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

async function requestApprovalAndWait(
  pool: Pool,
  claim: ClaimedAgentRun,
  request: ProviderApprovalRequest,
  signal: AbortSignal
): Promise<'approved' | 'denied'> {
  assertActiveProviderRequest(claim, request);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = await client.query<{
      root_message_id: string;
      agent_member_id: string;
      channel_id: string;
    }>(
      `SELECT COALESCE(source.parent_message_id, source.id) AS root_message_id,
              agent_member.id AS agent_member_id, source.channel_id
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
      `SELECT id FROM public.approval
       WHERE agent_run_id = $1 AND provider_request_id = $2`,
      [claim.id, request.providerRequestId]
    );
    if (!existing.rows[0]) {
      const approvalId = randomUUID();
      const decisionCode = approvalId.replaceAll('-', '').slice(0, 8);
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
          `Approval ${decisionCode} needed: ${request.summary}. `
            + `Reply “approve ${decisionCode}” or “deny ${decisionCode}” in this thread.`
        ]
      );
      await client.query(
        `INSERT INTO public.notification_outbox (
           workspace_id, message_id, topic, payload
         ) VALUES ($1, $2, 'channel.message', $3)`,
        [claim.workspace_id, requestMessageId, { messageId: requestMessageId }]
      );
      await client.query(
        `INSERT INTO public.approval (
         id, workspace_id, agent_run_id, provider_request_id, provider_turn_id,
           provider_thread_id, provider_item_id, action_kind, scope_hash, decision_code, summary,
           requester_workspace_member_id, request_message_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          approvalId,
          claim.workspace_id,
          claim.id,
          request.providerRequestId,
          request.turnId,
          request.threadId,
          request.itemId,
          request.actionKind,
          request.scopeHash,
          decisionCode,
          request.summary,
          context.agent_member_id,
          requestMessageId
        ]
      );
      await appendRunEventWithClient(client, claim, {
        eventType: 'run.approval_requested',
        status: 'waiting_for_approval',
        summary: 'Waiting for a Pilot member to approve one action',
        evidence: {
          approvalId,
          actionKind: request.actionKind,
          scopeHash: request.scopeHash,
          providerItemId: request.itemId
        }
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
    const decision = await pool.query<{ id: string; state: string }>(
      `SELECT id, state FROM public.approval
       WHERE agent_run_id = $1 AND provider_request_id = $2`,
      [claim.id, request.providerRequestId]
    );
    if (decision.rows[0]?.state === 'approved') {
      return consumeApprovedAction(pool, claim, request, decision.rows[0].id);
    }
    if (decision.rows[0] && ['denied', 'expired', 'consumed'].includes(decision.rows[0].state)) {
      return 'denied';
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('AgentRun approval stopped after its execution lease was lost');
}

async function consumeApprovedAction(
  pool: Pool,
  claim: ClaimedAgentRun,
  request: ProviderApprovalRequest,
  approvalId: string
): Promise<'approved' | 'denied'> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const consumed = await client.query(
      `UPDATE public.approval approval
       SET state = 'consumed', consumed_at = now()
       FROM public.agent_run run
       WHERE approval.id = $1
         AND approval.agent_run_id = run.id
         AND approval.state = 'approved'
         AND approval.provider_turn_id = $2
         AND approval.provider_item_id = $3
         AND approval.scope_hash = $4
         AND run.lease_token = $5
         AND run.provider_thread_id = $6
         AND run.active_turn_id = $2
         AND run.status NOT IN ('completed', 'failed', 'cancelled', 'paused')`,
      [
        approvalId,
        request.turnId,
        request.itemId,
        request.scopeHash,
        claim.lease_token,
        request.threadId
      ]
    );
    if (consumed.rowCount !== 1) {
      await client.query('ROLLBACK');
      return 'denied';
    }
    await postApprovalResolutionMessage(
      client,
      approvalId,
      'consumed'
    );
    await appendRunEventWithClient(client, claim, {
      eventType: 'run.approval_consumed',
      status: 'working',
      summary: 'Approved action authorised once; continuing the request',
      evidence: { approvalId, actionKind: request.actionKind, scopeHash: request.scopeHash }
    });
    await client.query('COMMIT');
    return 'approved';
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function recordRejectedAction(
  pool: Pool,
  claim: ClaimedAgentRun,
  request: ProviderApprovalRequest
): Promise<void> {
  assertActiveProviderRequest(claim, request);
  await appendRunEvent(pool, claim, {
    eventType: 'run.action_rejected',
    status: 'working',
    summary: 'Unsafe action rejected; continuing within the allowed boundary',
    evidence: {
      actionKind: request.actionKind,
      scopeHash: request.scopeHash,
      providerItemId: request.itemId
    }
  });
}

function assertActiveProviderRequest(
  claim: ClaimedAgentRun,
  request: Pick<ProviderApprovalRequest, 'threadId' | 'turnId'>
): void {
  if (request.threadId !== claim.provider_thread_id || request.turnId !== claim.active_turn_id) {
    throw new Error('Provider action does not match the active AgentRun turn');
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

async function failAgentRun(
  pool: Pool,
  claim: ClaimedAgentRun,
  event: AgentRunEventInput,
  result: AgentRunFailureResult
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await appendRunEventWithClient(client, claim, event);
    await recordAgentRunFailureResult(client, claim.id, result);
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
