import { spawn } from 'node:child_process';

const CONTAINER_NAME = 'relay-dev-postgres';
const VOLUME_NAME = 'relay-dev-postgres-data';
const MANAGED_LABEL = 'dev.relay.managed-postgres=true';
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 500;

function runDocker(arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', arguments_, {
      env: options.env ?? process.env,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function requireLocalDatabaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error('DATABASE_URL is required; add it to .env');

  const url = new URL(value);
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use the postgres: or postgresql: protocol');
  }
  if (!localHosts.has(url.hostname)) {
    throw new Error(`Refusing to manage a development database at non-local host ${url.hostname}`);
  }
  if (!url.username || !url.password || url.pathname.length <= 1) {
    throw new Error('DATABASE_URL must include a username, password, and database name');
  }

  return {
    hostPort: url.port || '5432',
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1))
  };
}

async function requireDockerDaemon() {
  const result = await runDocker(['info', '--format', '{{.ServerVersion}}'], { capture: true });
  if (result.code !== 0) {
    throw new Error('Docker is installed but its daemon is unavailable; start Docker and try again');
  }
}

async function inspectContainer() {
  const result = await runDocker([
    'inspect',
    '--format',
    '{{json .Config.Labels}}|{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}',
    CONTAINER_NAME
  ], { capture: true });

  if (result.code !== 0) return undefined;
  const [labelsJson, running, health] = result.stdout.trim().split('|');
  const labels = JSON.parse(labelsJson || '{}');
  if (labels['dev.relay.managed-postgres'] !== 'true') {
    throw new Error(
      `Docker container ${CONTAINER_NAME} already exists but is not managed by Relay`
    );
  }
  return { running: running === 'true', health };
}

async function waitUntilReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const container = await inspectContainer();
    if (container?.health === 'healthy') return;
    if (container?.health === 'unhealthy') {
      throw new Error(`PostgreSQL became unhealthy; inspect it with: docker logs ${CONTAINER_NAME}`);
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  throw new Error(`PostgreSQL did not become ready within ${READY_TIMEOUT_MS / 1_000} seconds`);
}

async function up() {
  await requireDockerDaemon();
  const database = requireLocalDatabaseUrl();
  const existing = await inspectContainer();

  if (existing?.running) {
    await waitUntilReady();
    console.log(`PostgreSQL is ready on 127.0.0.1:${database.hostPort}`);
    return;
  }

  if (existing) {
    const result = await runDocker(['start', CONTAINER_NAME]);
    if (result.code !== 0) throw new Error(`Could not start ${CONTAINER_NAME}`);
  } else {
    const dockerEnvironment = {
      ...process.env,
      POSTGRES_USER: database.user,
      POSTGRES_PASSWORD: database.password,
      POSTGRES_DB: database.database
    };
    const result = await runDocker([
      'run',
      '--detach',
      '--name', CONTAINER_NAME,
      '--label', MANAGED_LABEL,
      '--publish', `127.0.0.1:${database.hostPort}:5432`,
      '--volume', `${VOLUME_NAME}:/var/lib/postgresql/data`,
      '--env', 'POSTGRES_USER',
      '--env', 'POSTGRES_PASSWORD',
      '--env', 'POSTGRES_DB',
      '--health-cmd', 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
      '--health-interval', '1s',
      '--health-timeout', '5s',
      '--health-retries', '20',
      'postgres:17-alpine'
    ], { env: dockerEnvironment });
    if (result.code !== 0) throw new Error(`Could not create ${CONTAINER_NAME}`);
  }

  await waitUntilReady();
  console.log(`PostgreSQL is ready on 127.0.0.1:${database.hostPort}`);
}

async function down() {
  await requireDockerDaemon();
  const existing = await inspectContainer();
  if (!existing) {
    console.log('Relay development PostgreSQL is not installed');
    return;
  }
  if (!existing.running) {
    console.log('Relay development PostgreSQL is already stopped');
    return;
  }

  const result = await runDocker(['stop', CONTAINER_NAME]);
  if (result.code !== 0) throw new Error(`Could not stop ${CONTAINER_NAME}`);
  console.log('Relay development PostgreSQL stopped; its data volume was preserved');
}

const command = process.argv[2];
try {
  if (command === 'up') await up();
  else if (command === 'down') await down();
  else throw new Error('Usage: dev-postgres.mjs <up|down>');
} catch (error) {
  if (error?.code === 'ENOENT') {
    console.error('Docker is required but was not found on PATH');
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
}
