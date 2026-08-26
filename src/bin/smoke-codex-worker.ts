import { hostname } from 'node:os';

import { createDatabasePool } from '../lib/server/database/pool.js';
import { loadFileBackedEnvironment } from '../lib/server/configuration.js';
import { LocalCodexAgentRunProvider } from '../lib/server/provider/codex-agent-run.js';
import { checkRuntimeReadiness } from '../lib/server/runtime.js';
import { processNextAgentRun } from '../worker/execution.js';

await loadFileBackedEnvironment(['DATABASE_URL', 'RELAY_GITHUB_PRIVATE_KEY']);
const pool = createDatabasePool();
try {
  await checkRuntimeReadiness(pool);
  const result = await processNextAgentRun(pool, new LocalCodexAgentRunProvider(), {
    workerId: `managed-login-smoke:${hostname()}:${process.pid}`,
    workspaceRoot: process.env.RELAY_AGENT_WORKSPACE_ROOT ?? '/var/lib/relay/agent-runs'
  });
  if (result.kind !== 'executed' || result.status !== 'completed') {
    throw new Error(`managed-login smoke did not complete a queued AgentRun: ${JSON.stringify(result)}`);
  }
  console.log(JSON.stringify({ event: 'worker.managed-login-smoke.completed', ...result }));
} finally {
  await pool.end();
}
