import { hostname } from 'node:os';

import { createDatabasePool } from '../lib/server/database/pool.js';
import { loadFileBackedEnvironment } from '../lib/server/configuration.js';
import { formatError } from '../lib/server/errors.js';
import { getGitHubBrokerRemote } from '../lib/server/github/api.js';
import { AgentRunGitHubWorkspaceBroker } from '../lib/server/github/workspace.js';
import { LocalCodexAgentRunProvider } from '../lib/server/provider/codex-agent-run.js';
import { checkRuntimeReadiness } from '../lib/server/runtime.js';
import { processNextAgentRun } from './execution.js';

await loadFileBackedEnvironment(['DATABASE_URL', 'RELAY_GITHUB_PRIVATE_KEY']);

const HEALTH_INTERVAL_MS = 30_000;
const POLL_INTERVAL_MS = 1_000;
const pool = createDatabasePool();
const provider = new LocalCodexAgentRunProvider();
const githubWorkspaceBroker = new AgentRunGitHubWorkspaceBroker(pool, getGitHubBrokerRemote());
const workerId = process.env.RELAY_WORKER_ID ?? `${hostname()}:${process.pid}`;
const workspaceRoot = process.env.RELAY_AGENT_WORKSPACE_ROOT ?? '/var/lib/relay/agent-runs';
let draining = false;

try {
  const readiness = await checkRuntimeReadiness(pool);
  console.log(JSON.stringify({ event: 'worker.ready', workerId, workspaceRoot, ...readiness }));
} catch (error) {
  console.error(JSON.stringify({ event: 'worker.startup.failed', error: formatError(error) }));
  await pool.end();
  process.exit(1);
}

const healthCheck = setInterval(async () => {
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    console.error(JSON.stringify({ event: 'worker.database.unavailable', error: formatError(error) }));
  }
}, HEALTH_INTERVAL_MS);

const shutdown = (signal: NodeJS.Signals) => {
  if (draining) return;
  draining = true;
  clearInterval(healthCheck);
  console.log(JSON.stringify({ event: 'worker.draining', signal }));
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

while (!draining) {
  try {
    const result = await processNextAgentRun(pool, provider, {
      workerId, workspaceRoot, githubWorkspaceBroker
    });
    if (result.kind !== 'idle') console.log(JSON.stringify({ event: 'worker.cycle', ...result }));
  } catch (error) {
    console.error(JSON.stringify({ event: 'worker.cycle.failed', error: formatError(error) }));
  }
  if (!draining) await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
}

await pool.end();
console.log(JSON.stringify({ event: 'worker.stopped', workerId }));
