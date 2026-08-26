export type ProviderTerminalOutcome = 'completed' | 'interrupted' | 'failed';
export type ProviderAgentRunStatus = 'completed' | 'cancelled' | 'failed';

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
  credentialStoreReference: string;
  workspaceDirectory: string;
  prompt: string;
  approvalPolicy: 'onRequest';
  sandboxPolicy: {
    type: 'workspaceWrite';
    writableRoots: string[];
    readOnlyAccess: {
      type: 'restricted';
      includePlatformDefaults: boolean;
      readableRoots: string[];
    };
    networkAccess: false;
  };
}

export interface AgentRunProviderObserver {
  threadStarted(threadId: string): Promise<void>;
  turnStarted(turnId: string): Promise<void>;
  notification(notification: ProviderNotification): Promise<void>;
}

export type ProviderReconciliation =
  | { outcome: ProviderTerminalOutcome; errorCode?: string }
  | { outcome: 'indeterminate' };

export interface AgentRunProvider {
  execute(input: AgentRunProviderInput, observer: AgentRunProviderObserver): Promise<void>;
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

export function readSafeCodexErrorCode(value: unknown): string | undefined {
  if (typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(value)) return value;
  if (!value || typeof value !== 'object') return undefined;
  const type = (value as Record<string, unknown>).type;
  return typeof type === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(type) ? type : undefined;
}
