import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadFileBackedEnvironment } from '../src/lib/server/configuration.js';

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
