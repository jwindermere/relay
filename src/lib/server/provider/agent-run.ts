export type ProviderTerminalOutcome = 'completed' | 'interrupted' | 'failed';
export type ProviderAgentRunStatus = 'completed' | 'cancelled' | 'failed';
export type AgentRunStatus =
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
export type AgentRunEventType =
  | 'run.queued'
  | 'run.claimed'
  | 'run.recovering'
  | 'run.failed'
  | 'run.paused'
  | 'run.deferred'
  | 'run.clarification_requested'
  | 'run.clarification_answered'
  | 'run.clarification_requeued'
  | 'run.clarification_wait_recovered'
  | 'run.approval_requested'
  | 'run.approval_approved'
  | 'run.approval_denied'
  | 'run.approval_consumed'
  | 'run.action_rejected'
  | 'run.cancellation_requested'
  | 'provider.thread.started'
  | 'provider.turn.started'
  | 'provider.turn.completed'
  | 'provider.turn.reconciled'
  | 'provider.item.started'
  | 'provider.item.completed';

export interface ProviderNotification {
  method: 'item/started' | 'item/completed' | 'turn/completed';
  providerEventId: string;
  item?: { id?: string; type?: string; [key: string]: unknown };
  turn?: {
    id: string;
    status: ProviderTerminalOutcome;
    error?: { message?: string; codexErrorInfo?: unknown };
  };
}

export interface AgentRunProviderInput {
  signal: AbortSignal;
  cancellationSignal?: AbortSignal;
  credentialStoreReference: string;
  workspaceDirectory: string;
  prompt: string;
  providerThreadId?: string;
  approvalPolicy: 'onRequest';
  sandboxPolicy:
    | {
        type: 'workspaceWrite';
        writableRoots: string[];
        readOnlyAccess: {
          type: 'restricted';
          includePlatformDefaults: boolean;
          readableRoots: string[];
        };
        networkAccess: false;
      }
    | { type: 'readOnly'; networkAccess: false };
}

export interface AgentRunProviderObserver {
  threadStarted(threadId: string): Promise<void>;
  turnStarted(turnId: string): Promise<void>;
  notification(notification: ProviderNotification): Promise<void>;
  clarificationRequested(request: ProviderClarificationRequest): Promise<ProviderClarificationAnswers>;
  clarificationDelivered(providerRequestId: string): Promise<void>;
  approvalRequested(request: ProviderApprovalRequest): Promise<'approved' | 'denied'>;
  actionRejected(request: ProviderApprovalRequest): Promise<void>;
}

export interface ProviderRequestBoundary {
  providerRequestId: string;
  threadId: string;
  turnId: string;
  itemId: string;
}

export interface ProviderApprovalRequest extends ProviderRequestBoundary {
  actionKind: 'command' | 'file_change' | 'permissions';
  scopeHash: string;
  summary: string;
}

export interface ProviderClarificationQuestion {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string }> | null;
}

export interface ProviderClarificationRequest extends ProviderRequestBoundary {
  questions: ProviderClarificationQuestion[];
}

export type ProviderClarificationAnswers = Record<string, string[]>;

export type ProviderReconciliation =
  | { outcome: ProviderTerminalOutcome; errorCode?: string }
  | { outcome: 'indeterminate' };

export interface ProviderInterruptionInput {
  threadId: string;
  turnId: string;
  credentialStoreReference: string;
}

export interface AgentRunProvider {
  execute(input: AgentRunProviderInput, observer: AgentRunProviderObserver): Promise<void>;
  interrupt(input: ProviderInterruptionInput): Promise<void>;
  reconcile(input: { threadId: string; turnId: string }): Promise<ProviderReconciliation>;
}

export class AgentRunProviderError extends Error {
  constructor(
    readonly code: 'provider_limit' | 'provider_unavailable' | 'provider_failed',
    message: string
  ) {
    super(message);
    this.name = 'AgentRunProviderError';
  }
}

export function mapProviderOutcomeToAgentRunStatus(
  outcome: ProviderTerminalOutcome
): ProviderAgentRunStatus {
  if (outcome === 'completed') return 'completed';
  if (outcome === 'interrupted') return 'cancelled';
  return 'failed';
}

export function isTerminalAgentRunStatus(status: AgentRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function readSafeCodexErrorCode(value: unknown): string | undefined {
  if (typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(value)) return value;
  if (!value || typeof value !== 'object') return undefined;
  const type = (value as Record<string, unknown>).type;
  return typeof type === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(type) ? type : undefined;
}
