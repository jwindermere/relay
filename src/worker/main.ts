import { createDatabasePool } from '../lib/server/database/pool.js';
import { checkRuntimeReadiness } from '../lib/server/runtime.js';

const HEALTH_INTERVAL_MS = 30_000;
const pool = createDatabasePool();

try {
  const readiness = await checkRuntimeReadiness(pool);
  console.log(JSON.stringify({ event: 'worker.ready', ...readiness }));
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

const shutdown = async (signal: NodeJS.Signals) => {
  clearInterval(healthCheck);
  console.log(JSON.stringify({ event: 'worker.stopping', signal }));
  await pool.end();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
