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
  type ProviderClarificationRequest,
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
      if (message.method === 'item/tool/requestUserInput') {
        void Promise.resolve().then(async () => {
          await referencesPersisted;
          const request = parseClarificationRequest(message);
          const answers = await observer.clarificationRequested(request);
          if (!session.respond) throw new Error('Codex app-server cannot receive clarification input');
          await session.respond(message.id, {
            answers: Object.fromEntries(Object.entries(answers).map(([id, values]) => [
              id,
              { answers: values }
            ]))
          });
          await observer.clarificationDelivered(request.providerRequestId);
        }).catch((error) => rejectTerminal(classifyProviderError(error)));
        return;
      }
      if (message.method === 'item/commandExecution/requestApproval'
        || message.method === 'item/fileChange/requestApproval') {
        void session.respond?.(message.id, { decision: 'decline' });
        return;
      }
      if (message.method === 'item/permissions/requestApproval') {
        void session.respond?.(message.id, { permissions: [], scope: 'turn' });
      }
    };
    session.onFailure = (error) => rejectTerminal(classifyProviderError(error));

    try {
      await session.initialize();
      const threadResult = asRecord(await session.send(
        input.providerThreadId ? 'thread/resume' : 'thread/start',
        input.providerThreadId
          ? { threadId: input.providerThreadId }
          : {
              cwd: input.workspaceDirectory,
              approvalPolicy: input.approvalPolicy,
              sandbox: 'workspaceWrite',
              serviceName: 'relay-worker'
            }
      ));
      const threadId = readId(asRecord(threadResult.thread), 'Codex thread');
      if (input.providerThreadId && threadId !== input.providerThreadId) {
        throw new Error('Codex resumed a different Provider thread');
      }
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

function parseClarificationRequest(
  message: ProtocolMessage & { id: string | number; method: string }
): ProviderClarificationRequest {
  const params = message.params ?? {};
  const questions = Array.isArray(params.questions) ? params.questions : [];
  if (
    typeof params.threadId !== 'string'
    || typeof params.turnId !== 'string'
    || typeof params.itemId !== 'string'
    || params.isBlocking !== true
    || questions.length < 1
    || questions.length > 3
  ) {
    throw new Error('Codex clarification request was invalid');
  }
  return {
    providerRequestId: String(message.id),
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    questions: questions.map((value) => {
      const question = asRecord(value);
      if (
        typeof question.id !== 'string'
        || typeof question.header !== 'string'
        || typeof question.question !== 'string'
        || question.isSecret === true
      ) {
        throw new Error('Codex clarification question was invalid');
      }
      const options = question.options === null
        ? null
        : Array.isArray(question.options)
          ? question.options.map((value) => {
              const option = asRecord(value);
              if (typeof option.label !== 'string' || typeof option.description !== 'string') {
                throw new Error('Codex clarification option was invalid');
              }
              return { label: option.label, description: option.description };
            })
          : null;
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options
      };
    })
  };
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
