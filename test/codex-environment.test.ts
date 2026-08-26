import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCodexProcessEnvironment } from '../src/lib/server/provider/codex-runtime.js';

test('Codex processes never inherit Relay credential material', () => {
  const environment = createCodexProcessEnvironment({
    PATH: '/usr/bin',
    HOME: '/service/codex',
    DATABASE_URL: 'postgres://private',
    BETTER_AUTH_SECRET: 'auth-private',
    RELAY_GITHUB_PRIVATE_KEY: 'github-private',
    RELAY_GITHUB_WEBHOOK_SECRET: 'webhook-private',
    RELAY_EMAIL_DELIVERY_TOKEN: 'email-private',
    SAFE_SETTING: 'visible'
  });

  assert.deepEqual(environment, {
    PATH: '/usr/bin',
    HOME: '/service/codex',
    SAFE_SETTING: 'visible'
  });
});
