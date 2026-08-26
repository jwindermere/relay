import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

test('web replacement leaves the independently supervised worker running', async () => {
  const commands = await captureDeploymentCommands('web');
  assert.deepEqual(commands, [
    'compose build web',
    "compose run --rm --entrypoint /bin/sh backup -ec export DATABASE_URL=\"$(cat /run/secrets/database_url)\"; exec /ops/postgres/backup.sh",
    'compose run --rm migrate',
    'compose up --detach --no-deps web'
  ]);
  assert.doesNotMatch(commands.join('\n'), /worker/);
});

test('worker replacement drains before starting the compatible release', async () => {
  const commands = await captureDeploymentCommands('worker');
  assert.deepEqual(commands, [
    'compose build worker',
    'compose stop --timeout 1800 worker',
    "compose run --rm --entrypoint /bin/sh backup -ec export DATABASE_URL=\"$(cat /run/secrets/database_url)\"; exec /ops/postgres/backup.sh",
    'compose run --rm migrate',
    'compose up --detach --no-deps worker'
  ]);
});

async function captureDeploymentCommands(unit: 'web' | 'worker'): Promise<string[]> {
  const directory = await mkdtemp(join(tmpdir(), 'relay-deploy-test-'));
  const log = join(directory, 'commands');
  try {
    execFileSync('sh', [resolve('ops/deploy.sh'), unit], {
      env: {
        ...process.env,
        RELAY_COMPOSE_BIN: resolve('test/fixtures/fake-compose.sh'),
        RELAY_TEST_COMMAND_LOG: log
      }
    });
  } catch (error) {
    const failure = error as { message?: string; stderr?: Buffer; stdout?: Buffer };
    assert.fail([
      failure.message,
      failure.stdout?.toString(),
      failure.stderr?.toString()
    ].filter(Boolean).join('\n'));
  }
  return (await readFile(log, 'utf8')).trim().split('\n');
}
