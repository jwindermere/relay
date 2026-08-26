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
  const responses: Array<{ id: number; result: unknown }> = [];
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
            params: { threadId: 'thread-1', turnId: 'turn-1', command: 'private command' }
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
      respond(id, result) { responses.push({ id, result }); },
      close() {}
    };
    return session;
  });
  const persisted: string[] = [];
  const notifications: Array<{ method: string; item?: Record<string, unknown> }> = [];

  await provider.execute({
    signal: new AbortController().signal,
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
    }
  });

  assert.deepEqual(persisted, ['thread:thread-1', 'turn:turn-1']);
  assert.deepEqual(notifications.map(({ method }) => method), ['item/started', 'turn/completed']);
  assert.deepEqual(responses, [{ id: 91, result: { decision: 'decline' } }]);
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
