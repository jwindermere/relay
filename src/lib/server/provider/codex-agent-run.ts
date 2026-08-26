import {
  CodexProtocolError,
  createCodexAppServerSession,
  type CodexAppServerSession,
  type ProtocolMessage
} from './codex-runtime.js';
import {
  AgentRunProviderError,
  readSafeCodexErrorCode,
  type AgentRunProvider,
  type AgentRunProviderInput,
  type AgentRunProviderObserver,
  type ProviderNotification,
  type ProviderReconciliation
} from './agent-run.js';

export class LocalCodexAgentRunProvider implements AgentRunProvider {
  constructor(
    private readonly binary = process.env.RELAY_CODEX_BIN ?? 'codex',
    private readonly createSession: (binary: string) => CodexAppServerSession =
      createCodexAppServerSession
  ) {}

  async execute(input: AgentRunProviderInput, observer: AgentRunProviderObserver): Promise<void> {
    const session = this.createSession(this.binary);
    let releaseNotifications!: () => void;
    const referencesPersisted = new Promise<void>((resolve) => { releaseNotifications = resolve; });
    let notificationChain = Promise.resolve();
    let resolveTerminal!: () => void;
    let rejectTerminal!: (error: Error) => void;
    const terminal = new Promise<void>((resolve, reject) => {
      resolveTerminal = resolve;
      rejectTerminal = reject;
    });
    const abort = () => {
      session.close();
      rejectTerminal(new AgentRunProviderError(
        'provider_unavailable',
        'Codex execution stopped after its AgentRun lease was lost'
      ));
    };
    input.signal.addEventListener('abort', abort, { once: true });

    session.onNotification = (message) => {
      const notification = parseNotification(message);
      if (!notification) return;
      notificationChain = notificationChain.then(async () => {
        await referencesPersisted;
        await observer.notification(notification);
        if (notification.method === 'turn/completed') resolveTerminal();
      }).catch(rejectTerminal);
    };
    session.onRequest = (message) => {
      if (message.method === 'item/commandExecution/requestApproval'
        || message.method === 'item/fileChange/requestApproval') {
        session.respond?.(message.id, { decision: 'decline' });
        return;
      }
      if (message.method === 'item/permissions/requestApproval') {
        session.respond?.(message.id, { permissions: [], scope: 'turn' });
      }
    };
    session.onFailure = (error) => rejectTerminal(classifyProviderError(error));

    try {
      await session.initialize();
      const threadResult = asRecord(await session.send('thread/start', {
        cwd: input.workspaceDirectory,
        approvalPolicy: input.approvalPolicy,
        sandbox: 'workspaceWrite',
        serviceName: 'relay-worker'
      }));
      const threadId = readId(asRecord(threadResult.thread), 'Codex thread');
      await observer.threadStarted(threadId);

      const turnResult = asRecord(await session.send('turn/start', {
        threadId,
        input: [{ type: 'text', text: input.prompt }],
        cwd: input.workspaceDirectory,
        approvalPolicy: input.approvalPolicy,
        sandboxPolicy: input.sandboxPolicy
      }));
      const turnId = readId(asRecord(turnResult.turn), 'Codex turn');
      await observer.turnStarted(turnId);
      releaseNotifications();
      await terminal;
      await notificationChain;
    } catch (error) {
      releaseNotifications();
      throw classifyProviderError(error);
    } finally {
      input.signal.removeEventListener('abort', abort);
      session.close();
    }
  }

  async reconcile(input: { threadId: string; turnId: string }): Promise<ProviderReconciliation> {
    const session = this.createSession(this.binary);
    try {
      await session.initialize();
      const result = asRecord(await session.send('thread/read', {
        threadId: input.threadId,
        includeTurns: true
      }));
      const thread = asRecord(result.thread);
      const turns = Array.isArray(thread.turns) ? thread.turns : [];
      const turn = turns.map(asRecord).find(({ id }) => id === input.turnId);
      if (!turn || !['completed', 'failed', 'interrupted'].includes(String(turn.status))) {
        return { outcome: 'indeterminate' };
      }
      const outcome = turn.status as 'completed' | 'failed' | 'interrupted';
      return {
        outcome,
        errorCode: readSafeCodexErrorCode(asRecord(turn.error).codexErrorInfo)
      };
    } catch (error) {
      throw classifyProviderError(error);
    } finally {
      session.close();
    }
  }
}

function parseNotification(message: ProtocolMessage): ProviderNotification | undefined {
  if (!message.params) return undefined;
  if (message.method === 'item/started' || message.method === 'item/completed') {
    const item = asRecord(message.params.item);
    const itemId = typeof item.id === 'string' ? item.id : undefined;
    const turnId = typeof message.params.turnId === 'string' ? message.params.turnId : undefined;
    if (!itemId || !turnId) return undefined;
    return {
      method: message.method,
      providerEventId: `${turnId}:${itemId}:${message.method}`,
      item
    };
  }
  if (message.method === 'turn/completed') {
    const turn = asRecord(message.params.turn);
    if (typeof turn.id !== 'string'
      || !['completed', 'interrupted', 'failed'].includes(String(turn.status))) return undefined;
    return {
      method: 'turn/completed',
      providerEventId: `${turn.id}:turn/completed`,
      turn: {
        id: turn.id,
        status: turn.status as 'completed' | 'interrupted' | 'failed',
        error: asRecord(turn.error)
      }
    };
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function readId(value: Record<string, unknown>, label: string): string {
  if (typeof value.id !== 'string' || !value.id) {
    throw new AgentRunProviderError('provider_failed', `${label} response was invalid`);
  }
  return value.id;
}

function classifyProviderError(error: unknown): AgentRunProviderError {
  if (error instanceof AgentRunProviderError) return error;
  const detail = error instanceof CodexProtocolError
    ? `${error.message} ${JSON.stringify(error.protocolError?.data ?? '')}`
    : error instanceof Error ? error.message : '';
  if (/rate.?limit|usage.?limit|quota|too many requests|plan limit/i.test(detail)) {
    return new AgentRunProviderError('provider_limit', 'Codex usage limit reached');
  }
  if (/unavailable|timed out|could not be sent|stopped|ECONN|ENOENT/i.test(detail)) {
    return new AgentRunProviderError('provider_unavailable', 'Codex is unavailable');
  }
  return new AgentRunProviderError('provider_failed', 'Codex execution failed');
}
