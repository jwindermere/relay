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
  assert.deepEqual(deployment.services['evaluation-retention']?.networks, ['backend']);
  assert.match(JSON.stringify(deployment.services.postgres?.volumes), /postgres-data/);
  assert.match(JSON.stringify(deployment.services.worker?.volumes), /codex-state/);
  assert.match(JSON.stringify(deployment.services.worker?.volumes), /agent-run-workspaces/);
});

test('the Portainer topology publishes only web and excludes Relay from Watchtower', async () => {
  const deployment = parse(await readFile(resolve('compose.portainer.yaml'), 'utf8')) as {
    services: Record<string, {
      image?: string;
      environment?: Record<string, string>;
      labels?: Record<string, string>;
      networks?: string[];
      ports?: string[];
      volumes?: unknown[];
    }>;
  };
  const published = Object.entries(deployment.services)
    .filter(([, service]) => service.ports?.length)
    .map(([name]) => name);

  assert.deepEqual(published, ['web']);
  assert.deepEqual(deployment.services.web?.ports, [
    '${RELAY_BIND_ADDRESS:-0.0.0.0}:${RELAY_PORT:-9095}:3000'
  ]);
  assert.deepEqual(deployment.services.postgres?.networks, ['backend']);
  assert.deepEqual(deployment.services.worker?.networks, ['backend']);
  assert.match(JSON.stringify(deployment.services.worker?.volumes), /codex-state/);
  assert.match(JSON.stringify(deployment.services.backup?.volumes), /database-backups/);
  assert.doesNotMatch(
    JSON.stringify(deployment),
    /["']type["']\s*:\s*["']bind|RELAY_SECRETS_DIRECTORY/
  );
  assert.equal(
    deployment.services.postgres?.environment?.POSTGRES_PASSWORD,
    '${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in Portainer}'
  );
  assert.equal(
    deployment.services.web?.environment?.DATABASE_URL,
    '${DATABASE_URL:?set DATABASE_URL in Portainer}'
  );
  assert.equal(
    deployment.services.web?.environment?.RELAY_INVITATION_DELIVERY_MODE,
    '${RELAY_INVITATION_DELIVERY_MODE:-manual}'
  );
  assert.equal(
    deployment.services.web?.environment?.RELAY_EMAIL_DELIVERY_URL,
    '${RELAY_EMAIL_DELIVERY_URL:-}'
  );
  for (const service of Object.values(deployment.services)) {
    assert.equal(service.labels?.['com.centurylinklabs.watchtower.enable'], 'false');
  }
});

test('the runtime image contains the worker and database operation executables', async () => {
  const dockerfile = await readFile(resolve('Dockerfile'), 'utf8');
  assert.match(dockerfile, /apk add --no-cache git postgresql-client/);
  assert.match(dockerfile, /COPY --from=build \/app\/ops\/postgres \/ops\/postgres/);
  assert.match(dockerfile, /chown -R node:node .* \/backups/);
});

test('expired collaboration evaluation is purged independently of project activity', async () => {
  const script = await readFile(resolve('ops/postgres/run-evaluation-retention.sh'), 'utf8');
  assert.match(script, /SELECT public\.purge_expired_collaboration_evaluation\(\)/);
  assert.match(script, /EVALUATION_RETENTION_INTERVAL_SECONDS/);
  const operations = await readFile(resolve('ops/README.md'), 'utf8');
  assert.match(
    operations,
    /restart `web`, `worker`, `migrate`, `backup`, and `evaluation-retention`/
  );
});

test('web replacement leaves the independently supervised worker running', async () => {
  const commands = await captureDeploymentCommands('web');
  assert.deepEqual(commands, [
    'compose build migrate web',
    "compose run --rm --no-deps --entrypoint /bin/sh backup -ec export DATABASE_URL=\"$(cat /run/secrets/database_url)\"; exec /ops/postgres/backup.sh",
    'compose run --rm --env RELAY_REQUIRE_EXPAND_ONLY=true migrate',
    'compose up --detach --no-deps web evaluation-retention'
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
    'compose up --detach --no-deps worker evaluation-retention'
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
    'compose up --detach --no-deps web worker evaluation-retention'
  ]);
});

test('a Portainer image replacement pulls through the existing Compose project', async () => {
  const commands = await captureDeploymentCommands('worker', {
    RELAY_COMPOSE_FILE: 'compose.portainer.yaml',
    RELAY_COMPOSE_PROJECT: 'relay',
    RELAY_DEPLOY_SOURCE: 'pull'
  });
  const prefix = 'compose --file compose.portainer.yaml --project-name relay ';
  assert.deepEqual(commands, [
    `${prefix}pull migrate worker`,
    `${prefix}stop --timeout 1800 worker`,
    `${prefix}run --rm --no-deps --entrypoint /bin/sh backup -ec export DATABASE_URL="$(cat /run/secrets/database_url)"; exec /ops/postgres/backup.sh`,
    `${prefix}run --rm --env RELAY_REQUIRE_EXPAND_ONLY=true migrate`,
    `${prefix}up --detach --no-deps worker evaluation-retention`
  ]);
});

async function captureDeploymentCommands(
  unit: 'web' | 'worker' | 'contract',
  environment: Record<string, string> = {}
): Promise<string[]> {
  const directory = await mkdtemp(join(tmpdir(), 'relay-deploy-test-'));
  const log = join(directory, 'commands');
  try {
    execFileSync('sh', [resolve('ops/deploy.sh'), unit], {
      env: {
        ...process.env,
        ...environment,
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
