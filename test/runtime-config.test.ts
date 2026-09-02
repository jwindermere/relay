import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  buildJitsiMeetingUrl,
  getJitsiBaseUrl,
  getInvitationDeliveryMode,
  isJitsiEmbeddingEnabled,
  loadFileBackedEnvironment
} from '../src/lib/server/configuration.js';

test('email delivery remains the invitation default and manual delivery is explicit', () => {
  assert.equal(getInvitationDeliveryMode({}), 'email');
  assert.equal(getInvitationDeliveryMode({ RELAY_INVITATION_DELIVERY_MODE: 'manual' }), 'manual');
  assert.throws(
    () => getInvitationDeliveryMode({ RELAY_INVITATION_DELIVERY_MODE: 'disabled' }),
    /must be email or manual/
  );
});

test('service secrets load from independently mounted files without retaining file variables', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-secret-config-'));
  const secretFile = join(directory, 'authentication');
  await writeFile(secretFile, 'rotatable-secret\n', { mode: 0o600 });
  const environment: NodeJS.ProcessEnv = { BETTER_AUTH_SECRET_FILE: secretFile };

  await loadFileBackedEnvironment(['BETTER_AUTH_SECRET'], environment);

  assert.equal(environment.BETTER_AUTH_SECRET, 'rotatable-secret');
  assert.equal(environment.BETTER_AUTH_SECRET_FILE, undefined);
});

test('service startup rejects ambiguous inline and file-backed secret configuration', async () => {
  await assert.rejects(
    loadFileBackedEnvironment(['BETTER_AUTH_SECRET'], {
      BETTER_AUTH_SECRET: 'inline',
      BETTER_AUTH_SECRET_FILE: '/run/secrets/authentication'
    }),
    /must not both be set/
  );
});

test('local runtime scripts load an optional .env file', async () => {
  const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  for (const script of [
    'dev:web',
    'dev:worker',
    'db:migrate',
    'bootstrap:owner',
    'smoke:codex-worker',
    'verify:pilot'
  ]) {
    assert.match(
      packageJson.scripts[script] ?? '',
      /^node --env-file-if-exists=\.env /,
      `${script} must load local environment configuration`
    );
  }
});

test('Jitsi rooms use the public service by default and support a self-hosted base path', () => {
  assert.equal(getJitsiBaseUrl({}), 'https://meet.jit.si');
  assert.equal(
    buildJitsiMeetingUrl('relay-1234567890abcdef', {
      RELAY_JITSI_BASE_URL: 'https://calls.example.test/meet/'
    }),
    'https://calls.example.test/meet/relay-1234567890abcdef'
  );
});

test('Jitsi configuration rejects unsafe remote URLs and malformed room names', () => {
  assert.throws(
    () => getJitsiBaseUrl({ RELAY_JITSI_BASE_URL: 'http://calls.example.test' }),
    /must use HTTPS/
  );
  assert.throws(
    () => buildJitsiMeetingUrl('guessable', {}),
    /room name is invalid/
  );
});

test('Jitsi embedding is opt-in and limited to a dedicated self-hosted origin', () => {
  assert.equal(isJitsiEmbeddingEnabled({}), false);
  assert.equal(isJitsiEmbeddingEnabled({
    RELAY_JITSI_BASE_URL: 'https://meet.hades.ws',
    RELAY_JITSI_EMBED_ENABLED: 'true'
  }), true);
  assert.throws(
    () => isJitsiEmbeddingEnabled({ RELAY_JITSI_EMBED_ENABLED: 'true' }),
    /self-hosted/
  );
  assert.throws(
    () => isJitsiEmbeddingEnabled({
      RELAY_JITSI_BASE_URL: 'https://meet.hades.ws/jitsi',
      RELAY_JITSI_EMBED_ENABLED: 'true'
    }),
    /dedicated origin/
  );
});
