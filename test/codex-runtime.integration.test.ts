import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LocalCodexAppServerRuntime,
  type CodexAppServerSession
} from '../src/lib/server/provider/codex-runtime.js';

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
