import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

test('only the TLS proxy is published and it cannot reach the backend network', async () => {
  const deployment = parse(await readFile(resolve('compose.yaml'), 'utf8')) as {
    services: Record<string, { networks?: string[]; ports?: string[]; volumes?: unknown[] }>;
  };
  const published = Object.entries(deployment.services)
    .filter(([, service]) => service.ports?.length)
    .map(([name]) => name);
  assert.deepEqual(published, ['proxy']);
  assert.deepEqual(deployment.services.proxy?.ports, ['443:443']);
  assert.deepEqual(deployment.services.proxy?.networks, ['edge']);
  assert.deepEqual(deployment.services.postgres?.networks, ['backend']);
  assert.deepEqual(deployment.services.worker?.networks, ['backend']);
  assert.match(JSON.stringify(deployment.services.postgres?.volumes), /postgres-data/);
  assert.match(JSON.stringify(deployment.services.worker?.volumes), /codex-state/);
  assert.match(JSON.stringify(deployment.services.worker?.volumes), /agent-run-workspaces/);
});

test('web replacement leaves the independently supervised worker running', async () => {
  const commands = await captureDeploymentCommands('web');
  assert.deepEqual(commands, [
    'compose build migrate web',
    "compose run --rm --no-deps --entrypoint /bin/sh backup -ec export DATABASE_URL=\"$(cat /run/secrets/database_url)\"; exec /ops/postgres/backup.sh",
    'compose run --rm --env RELAY_REQUIRE_EXPAND_ONLY=true migrate',
    'compose up --detach --no-deps web'
  ]);
  assert.doesNotMatch(commands.join('\n'), /worker/);
});

test('worker replacement drains before starting the compatible release', async () => {
  const commands = await captureDeploymentCommands('worker');
  assert.deepEqual(commands, [
    'compose build migrate worker',
    'compose stop --timeout 1800 worker',
    "compose run --rm --no-deps --entrypoint /bin/sh backup -ec export DATABASE_URL=\"$(cat /run/secrets/database_url)\"; exec /ops/postgres/backup.sh",
    'compose run --rm --env RELAY_REQUIRE_EXPAND_ONLY=true migrate',
    'compose up --detach --no-deps worker'
  ]);
});

test('contract migrations run only after both old runtime types have stopped', async () => {
  const commands = await captureDeploymentCommands('contract');
  assert.deepEqual(commands, [
    'compose build migrate web worker',
    'compose stop --timeout 1800 worker',
    'compose stop web',
    "compose run --rm --no-deps --entrypoint /bin/sh backup -ec export DATABASE_URL=\"$(cat /run/secrets/database_url)\"; exec /ops/postgres/backup.sh",
    'compose run --rm migrate',
    'compose up --detach --no-deps web worker'
  ]);
});

async function captureDeploymentCommands(unit: 'web' | 'worker' | 'contract'): Promise<string[]> {
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
