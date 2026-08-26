import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LocalCodexAppServerRuntime,
  type CodexAppServerSession
} from '../src/lib/server/provider/codex-runtime.js';
import { LocalCodexAgentRunProvider } from '../src/lib/server/provider/codex-agent-run.js';

test('the local Codex adapter uses managed device login and logout without API credentials', async () => {
  const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const sessions: CodexAppServerSession[] = [];
  const runtime = new LocalCodexAppServerRuntime('codex-fixture', () => {
    const session: CodexAppServerSession = {
      async initialize() {},
      async send(method, params) {
        requests.push({ method, params });
        if (method === 'account/login/start') {
          setTimeout(() => session.onNotification?.({
            method: 'account/login/completed',
            params: { loginId: 'managed-login', success: true, error: null }
          }), 0);
          return {
            type: 'chatgptDeviceCode',
            loginId: 'managed-login',
            verificationUrl: 'https://auth.openai.com/codex/device',
            userCode: 'MANAGED-CODE'
          };
        }
        return {};
      },
      close() {}
    };
    sessions.push(session);
    return session;
  });
  let resolveCompletion!: (value: unknown) => void;
  const completion = new Promise<unknown>((resolve) => {
    resolveCompletion = resolve;
  });
  const login = await runtime.startManagedLogin({
    credentialStoreReference: 'codex:test-reference',
    loginType: 'chatgptDeviceCode',
    async onCompleted(result) {
      resolveCompletion(result);
    }
  });
  assert.deepEqual(login, {
    type: 'chatgptDeviceCode',
    loginId: 'managed-login',
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: 'MANAGED-CODE'
  });
  assert.deepEqual(await completion, { success: true, authMode: 'chatgpt', error: undefined });
  await runtime.logout({ credentialStoreReference: 'codex:test-reference' });
  assert.equal(sessions.length, 2);
  assert.deepEqual(requests, [
    { method: 'account/login/start', params: { type: 'chatgptDeviceCode' } },
    { method: 'account/logout', params: undefined }
  ]);
  assert.doesNotMatch(JSON.stringify(requests), /api.?key/i);
});

test('the AgentRun adapter uses restricted app-server stdio turns and waits for terminal evidence', async () => {
  const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const responses: Array<{ id: string | number; result: unknown }> = [];
  let session!: CodexAppServerSession;
  const provider = new LocalCodexAgentRunProvider('codex-fixture', () => {
    session = {
      async initialize() {},
      async send(method, params) {
        requests.push({ method, params });
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') {
          session.onRequest?.({
            id: 91,
            method: 'item/commandExecution/requestApproval',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'item-approval',
              startedAtMs: 1,
              command: 'curl -H "Authorization: Bearer private" https://example.test',
              cwd: '/tmp/relay-run-1',
              commandActions: [{
                type: 'unknown',
                command: 'curl -H "Authorization: Bearer private" https://example.test'
              }]
            }
          });
          session.onNotification?.({
            method: 'item/started',
            params: {
              turnId: 'turn-1',
              item: { id: 'item-1', type: 'commandExecution', command: 'private command' }
            }
          });
          session.onNotification?.({
            method: 'turn/completed',
            params: { turn: { id: 'turn-1', status: 'completed' } }
          });
          return { turn: { id: 'turn-1', status: 'inProgress' } };
        }
        return {};
      },
      async respond(id, result) { responses.push({ id, result }); },
      close() {}
    };
    return session;
  });
  const persisted: string[] = [];
  const notifications: Array<{ method: string; item?: Record<string, unknown> }> = [];

  await provider.execute({
    signal: new AbortController().signal,
    credentialStoreReference: 'codex:test-reference',
    workspaceDirectory: '/tmp/relay-run-1',
    prompt: 'Inspect the test',
    approvalPolicy: 'onRequest',
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: ['/tmp/relay-run-1'],
      readOnlyAccess: {
        type: 'restricted',
        includePlatformDefaults: true,
        readableRoots: ['/tmp/relay-run-1']
      },
      networkAccess: false
    }
  }, {
    async threadStarted(threadId) { persisted.push(`thread:${threadId}`); },
    async turnStarted(turnId) { persisted.push(`turn:${turnId}`); },
    async notification(notification) {
      assert.deepEqual(persisted, ['thread:thread-1', 'turn:turn-1']);
      notifications.push(notification);
    },
    async clarificationRequested() { assert.fail('no clarification was requested'); },
    async clarificationDelivered() { assert.fail('no clarification was delivered'); },
    async approvalRequested(request) {
      assert.deepEqual(request, {
        providerRequestId: '91',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-approval',
        actionKind: 'command',
        scopeHash: request.scopeHash,
        summary: 'Run one elevated curl command for example.test'
      });
      assert.match(request.scopeHash, /^[a-f0-9]{64}$/);
      assert.doesNotMatch(JSON.stringify(request), /private/);
      return 'approved';
    },
    async actionRejected() { assert.fail('no action was rejected'); }
  });

  assert.deepEqual(persisted, ['thread:thread-1', 'turn:turn-1']);
  assert.deepEqual(notifications.map(({ method }) => method), ['item/started', 'turn/completed']);
  assert.deepEqual(responses, [{ id: 91, result: { decision: 'accept' } }]);
  assert.deepEqual(requests, [
    {
      method: 'thread/start',
      params: {
        cwd: '/tmp/relay-run-1',
        approvalPolicy: 'onRequest',
        sandbox: 'workspaceWrite',
        serviceName: 'relay-worker'
      }
    },
    {
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'Inspect the test' }],
        cwd: '/tmp/relay-run-1',
        approvalPolicy: 'onRequest',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: ['/tmp/relay-run-1'],
          readOnlyAccess: {
            type: 'restricted',
            includePlatformDefaults: true,
            readableRoots: ['/tmp/relay-run-1']
          },
          networkAccess: false
        }
      }
    }
  ]);
});

test('the AgentRun adapter interrupts a started turn and still waits for terminal evidence', async () => {
  const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const cancellation = new AbortController();
  let session!: CodexAppServerSession;
  const provider = new LocalCodexAgentRunProvider('codex-fixture', () => {
    session = {
      async initialize() {},
      async send(method, params) {
        requests.push({ method, params });
        if (method === 'thread/start') return { thread: { id: 'thread-cancel' } };
        if (method === 'turn/start') {
          setTimeout(() => cancellation.abort(), 0);
          return { turn: { id: 'turn-cancel', status: 'inProgress' } };
        }
        if (method === 'turn/interrupt') {
          setTimeout(() => session.onNotification?.({
            method: 'turn/completed',
            params: { turn: { id: 'turn-cancel', status: 'interrupted' } }
          }), 0);
          return {};
        }
        return {};
      },
      close() {}
    };
    return session;
  });
  const outcomes: string[] = [];

  await provider.execute({
    signal: new AbortController().signal,
    cancellationSignal: cancellation.signal,
    credentialStoreReference: 'codex:test-reference',
    workspaceDirectory: '/tmp/relay-run-cancel',
    prompt: 'Inspect the test',
    approvalPolicy: 'onRequest',
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: ['/tmp/relay-run-cancel'],
      readOnlyAccess: {
        type: 'restricted',
        includePlatformDefaults: true,
        readableRoots: ['/tmp/relay-run-cancel']
      },
      networkAccess: false
    }
  }, {
    async threadStarted() {},
    async turnStarted() {},
    async notification(notification) {
      if (notification.turn) outcomes.push(notification.turn.status);
    },
    async clarificationRequested() { assert.fail('no clarification was requested'); },
    async clarificationDelivered() { assert.fail('no clarification was delivered'); },
    async approvalRequested() { assert.fail('no approval was requested'); },
    async actionRejected() { assert.fail('no action was rejected'); }
  });

  assert.deepEqual(requests.map(({ method }) => method), [
    'thread/start', 'turn/start', 'turn/interrupt'
  ]);
  assert.deepEqual(requests[2]?.params, {
    threadId: 'thread-cancel', turnId: 'turn-cancel'
  });
  assert.deepEqual(outcomes, ['interrupted']);
});

test('the AgentRun adapter keeps a clarification on the same Provider turn', async () => {
  const responses: Array<{ id: string | number; result: unknown }> = [];
  let session!: CodexAppServerSession;
  const provider = new LocalCodexAgentRunProvider('codex-fixture', () => {
    session = {
      async initialize() {},
      async send(method) {
        if (method === 'thread/start') return { thread: { id: 'thread-clarification' } };
        if (method === 'turn/start') {
          setTimeout(() => session.onRequest?.({
            id: 'request-92',
            method: 'item/tool/requestUserInput',
            params: {
              threadId: 'thread-clarification',
              turnId: 'turn-clarification',
              itemId: 'item-clarification',
              isBlocking: true,
              autoResolutionMs: null,
              questions: [{
                id: 'coverage',
                header: 'Coverage',
                question: 'Should the regression cover a complete web-process restart?',
                isOther: true,
                isSecret: false,
                options: null
              }]
            }
          }), 0);
          return { turn: { id: 'turn-clarification', status: 'inProgress' } };
        }
        return {};
      },
      async respond(id, result) {
        responses.push({ id, result });
        setTimeout(() => session.onNotification?.({
          method: 'turn/completed',
          params: { turn: { id: 'turn-clarification', status: 'completed' } }
        }), 0);
      },
      close() {}
    };
    return session;
  });
  const requests: unknown[] = [];
  const delivered: string[] = [];

  await provider.execute({
    signal: new AbortController().signal,
    credentialStoreReference: 'codex:test-reference',
    workspaceDirectory: '/tmp/relay-run-clarification',
    prompt: 'Inspect the test',
    approvalPolicy: 'onRequest',
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: ['/tmp/relay-run-clarification'],
      readOnlyAccess: {
        type: 'restricted',
        includePlatformDefaults: true,
        readableRoots: ['/tmp/relay-run-clarification']
      },
      networkAccess: false
    }
  }, {
    async threadStarted() {},
    async turnStarted() {},
    async notification() {},
    async clarificationRequested(request) {
      requests.push(request);
      return { coverage: ['Yes, cover a complete web-process restart.'] };
    },
    async clarificationDelivered(providerRequestId) {
      delivered.push(providerRequestId);
    },
    async approvalRequested() { assert.fail('no approval was requested'); },
    async actionRejected() { assert.fail('no action was rejected'); }
  });

  assert.deepEqual(requests, [{
    providerRequestId: 'request-92',
    threadId: 'thread-clarification',
    turnId: 'turn-clarification',
    itemId: 'item-clarification',
    questions: [{
      id: 'coverage',
      header: 'Coverage',
      question: 'Should the regression cover a complete web-process restart?',
      options: null
    }]
  }]);
  assert.deepEqual(delivered, ['request-92']);
  assert.deepEqual(responses, [{
    id: 'request-92',
    result: { answers: { coverage: { answers: ['Yes, cover a complete web-process restart.'] } } }
  }]);
});

test('the AgentRun adapter resumes a stored Provider thread for a clarification follow-up', async () => {
  const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let session!: CodexAppServerSession;
  const provider = new LocalCodexAgentRunProvider('codex-fixture', () => {
    session = {
      async initialize() {},
      async send(method, params) {
        requests.push({ method, params });
        if (method === 'thread/resume') return { thread: { id: 'thread-existing' } };
        if (method === 'turn/start') {
          setTimeout(() => session.onNotification?.({
            method: 'turn/completed',
            params: { turn: { id: 'turn-follow-up', status: 'completed' } }
          }), 0);
          return { turn: { id: 'turn-follow-up', status: 'inProgress' } };
        }
        return {};
      },
      close() {}
    };
    return session;
  });

  await provider.execute({
    signal: new AbortController().signal,
    credentialStoreReference: 'codex:test-reference',
    workspaceDirectory: '/tmp/relay-run-follow-up',
    prompt: 'Yes, include the complete web-process restart.',
    providerThreadId: 'thread-existing',
    approvalPolicy: 'onRequest',
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: ['/tmp/relay-run-follow-up'],
      readOnlyAccess: {
        type: 'restricted',
        includePlatformDefaults: true,
        readableRoots: ['/tmp/relay-run-follow-up']
      },
      networkAccess: false
    }
  }, {
    async threadStarted(threadId) { assert.equal(threadId, 'thread-existing'); },
    async turnStarted(turnId) { assert.equal(turnId, 'turn-follow-up'); },
    async notification() {},
    async clarificationRequested() { assert.fail('no clarification was requested'); },
    async clarificationDelivered() { assert.fail('no clarification was delivered'); },
    async approvalRequested() { assert.fail('no approval was requested'); },
    async actionRejected() { assert.fail('no action was rejected'); }
  });

  assert.deepEqual(requests.map(({ method }) => method), ['thread/resume', 'turn/start']);
  assert.deepEqual(requests[1]?.params?.input, [{
    type: 'text', text: 'Yes, include the complete web-process restart.'
  }]);
});
