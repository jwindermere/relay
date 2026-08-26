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
  type ProviderInterruptionInput,
  type ProviderReconciliation
} from './agent-run.js';
import {
  classifyProviderAction,
  type ProviderActionRequest,
  type ProviderApprovalResponse
} from './approval-policy.js';

export class LocalCodexAgentRunProvider implements AgentRunProvider {
  constructor(
    private readonly binary = process.env.RELAY_CODEX_BIN ?? 'codex',
    private readonly createSession: (binary: string) => CodexAppServerSession =
      createCodexAppServerSession
  ) {}

  async execute(input: AgentRunProviderInput, observer: AgentRunProviderObserver): Promise<void> {
    const session = this.createSession(this.binary);
    const approvalPolicy = serializeApprovalPolicy(input.approvalPolicy);
    const sandboxPolicy = serializeSandboxPolicy(input.sandboxPolicy);
    const sandbox = input.sandboxPolicy.type === 'workspaceWrite'
      ? 'workspace-write'
      : 'read-only';
    let releaseNotifications!: () => void;
    const referencesPersisted = new Promise<void>((resolve) => { releaseNotifications = resolve; });
    let notificationChain = Promise.resolve();
    let requestChain = Promise.resolve();
    let providerThreadId: string | undefined;
    let providerTurnId: string | undefined;
    let interruptSent = false;
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
    const interrupt = () => {
      if (interruptSent || !providerThreadId || !providerTurnId) return;
      interruptSent = true;
      void session.send('turn/interrupt', {
        threadId: providerThreadId,
        turnId: providerTurnId
      }).catch((error) => rejectTerminal(classifyProviderError(error)));
    };
    input.signal.addEventListener('abort', abort, { once: true });
    input.cancellationSignal?.addEventListener('abort', interrupt, { once: true });

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
        requestChain = requestChain.then(async () => {
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
        }).catch((error) => {
          if (!input.cancellationSignal?.aborted) rejectTerminal(classifyProviderError(error));
        });
        return;
      }
      if (message.method === 'item/commandExecution/requestApproval'
        || message.method === 'item/fileChange/requestApproval'
        || message.method === 'item/permissions/requestApproval') {
        requestChain = requestChain.then(async () => {
          await referencesPersisted;
          if (!session.respond) throw new Error('Codex app-server cannot receive approval input');
          const providerRequest = parseApprovalRequest(message);
          const action = classifyProviderAction(providerRequest, input.workspaceDirectory);
          const visibleRequest = {
            providerRequestId: providerRequest.providerRequestId,
            threadId: providerRequest.threadId,
            turnId: providerRequest.turnId,
            itemId: providerRequest.itemId,
            actionKind: action.actionKind,
            scopeHash: action.scopeHash,
            summary: action.summary
          };
          if (action.classification === 'forbidden') {
            await observer.actionRejected(visibleRequest);
            await session.respond(message.id, deniedResponse(action.actionKind));
            return;
          }
          if (action.classification === 'autonomous') {
            await session.respond(message.id, action.providerResponse);
            return;
          }
          const decision = await observer.approvalRequested(visibleRequest);
          await session.respond(
            message.id,
            decision === 'approved' ? action.providerResponse : deniedResponse(action.actionKind)
          );
        }).catch((error) => {
          if (!input.cancellationSignal?.aborted) rejectTerminal(classifyProviderError(error));
        });
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
              approvalPolicy,
              sandbox,
              serviceName: 'relay-worker'
            }
      ));
      const threadId = readId(asRecord(threadResult.thread), 'Codex thread');
      providerThreadId = threadId;
      if (input.providerThreadId && threadId !== input.providerThreadId) {
        throw new Error('Codex resumed a different Provider thread');
      }
      await observer.threadStarted(threadId);

      const turnResult = asRecord(await session.send('turn/start', {
        threadId,
        input: [{ type: 'text', text: input.prompt }],
        cwd: input.workspaceDirectory,
        approvalPolicy,
        sandboxPolicy
      }));
      const turnId = readId(asRecord(turnResult.turn), 'Codex turn');
      providerTurnId = turnId;
      await observer.turnStarted(turnId);
      if (input.cancellationSignal?.aborted) interrupt();
      releaseNotifications();
      await terminal;
      await notificationChain;
      await requestChain;
    } catch (error) {
      releaseNotifications();
      throw classifyProviderError(error);
    } finally {
      input.signal.removeEventListener('abort', abort);
      input.cancellationSignal?.removeEventListener('abort', interrupt);
      session.close();
    }
  }

  async interrupt(input: ProviderInterruptionInput): Promise<void> {
    const session = this.createSession(this.binary);
    try {
      await session.initialize();
      await session.send('turn/interrupt', {
        threadId: input.threadId,
        turnId: input.turnId
      });
    } catch (error) {
      throw classifyProviderError(error);
    } finally {
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

function serializeApprovalPolicy(
  policy: AgentRunProviderInput['approvalPolicy']
): 'on-request' {
  if (policy !== 'onRequest') throw new Error('Unsupported Relay approval policy');
  return 'on-request';
}

function serializeSandboxPolicy(
  policy: AgentRunProviderInput['sandboxPolicy']
):
  | {
      type: 'workspaceWrite';
      writableRoots: string[];
      networkAccess: false;
      excludeTmpdirEnvVar: true;
      excludeSlashTmp: true;
    }
  | { type: 'readOnly'; networkAccess: false } {
  if (policy.type === 'readOnly') return policy;
  return {
    type: policy.type,
    writableRoots: policy.writableRoots,
    networkAccess: policy.networkAccess,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true
  };
}

function parseApprovalRequest(
  message: ProtocolMessage & { id: string | number; method: string }
): ProviderActionRequest {
  const params = message.params ?? {};
  if (typeof params.threadId !== 'string'
    || typeof params.turnId !== 'string'
    || typeof params.itemId !== 'string') {
    throw new Error('Codex approval request was invalid');
  }
  const common = {
    providerRequestId: String(message.id),
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId
  };
  if (message.method === 'item/commandExecution/requestApproval') {
    return {
      ...common,
      kind: 'command',
      command: typeof params.command === 'string' ? params.command : null,
      cwd: typeof params.cwd === 'string' ? params.cwd : null,
      commandActions: readCommandActions(params.commandActions),
      networkHost: typeof asRecord(params.networkApprovalContext).host === 'string'
        ? asRecord(params.networkApprovalContext).host as string
        : null
    };
  }
  if (message.method === 'item/fileChange/requestApproval') {
    return {
      ...common,
      kind: 'file_change',
      grantRoot: typeof params.grantRoot === 'string' ? params.grantRoot : null
    };
  }
  if (!params.permissions || typeof params.permissions !== 'object'
    || typeof params.cwd !== 'string') {
    throw new Error('Codex permission request was invalid');
  }
  const permissions = asRecord(params.permissions);
  const network = permissions.network === null ? null : asRecord(permissions.network);
  const fileSystem = permissions.fileSystem === null ? null : asRecord(permissions.fileSystem);
  return {
    ...common,
    kind: 'permissions',
    cwd: params.cwd,
    permissions: {
      network: network === null ? null : {
        enabled: typeof network.enabled === 'boolean' ? network.enabled : null
      },
      fileSystem: fileSystem === null ? null : {
        read: readStringArray(fileSystem.read),
        write: readStringArray(fileSystem.write),
        entries: Array.isArray(fileSystem.entries)
          ? fileSystem.entries.map(asRecord)
          : []
      }
    }
  };
}

function readCommandActions(
  value: unknown
): Extract<ProviderActionRequest, { kind: 'command' }>['commandActions'] {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return null;
  const actions: NonNullable<Extract<ProviderActionRequest, { kind: 'command' }>['commandActions']> = [];
  for (const entry of value) {
    const action = asRecord(entry);
    if (action.type === 'unknown' && typeof action.command === 'string') {
      actions.push({ type: 'unknown', command: action.command });
    } else if (action.type === 'read'
      && typeof action.command === 'string'
      && typeof action.name === 'string'
      && typeof action.path === 'string') {
      actions.push({
        type: 'read', command: action.command, name: action.name, path: action.path
      });
    } else if ((action.type === 'listFiles' || action.type === 'search')
      && typeof action.command === 'string'
      && (action.path === null || typeof action.path === 'string')) {
      if (action.type === 'listFiles') {
        actions.push({ type: 'listFiles', command: action.command, path: action.path });
      } else if (action.query === null || typeof action.query === 'string') {
        actions.push({
          type: 'search', command: action.command, path: action.path, query: action.query
        });
      } else {
        return null;
      }
    } else {
      return null;
    }
  }
  return actions;
}

function deniedResponse(action: ProviderActionRequest['kind']): ProviderApprovalResponse {
  return action === 'permissions'
    ? { permissions: {}, scope: 'turn' }
    : { decision: 'decline' };
}

function readStringArray(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error('Codex permission request was invalid');
  }
  return value as string[];
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
