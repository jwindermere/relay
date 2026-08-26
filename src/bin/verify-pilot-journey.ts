import { loadFileBackedEnvironment } from '../lib/server/configuration.js';
import { createDatabasePool } from '../lib/server/database/pool.js';
import { assertCompatibleSchema } from '../lib/server/database/schema.js';
import { evaluatePilotJourney } from '../lib/pilot-journey.js';
import { observePilotJourney } from '../lib/server/pilot-journey.js';

function argument(name: string): string | undefined {
  const position = process.argv.indexOf(`--${name}`);
  return position >= 0 ? process.argv[position + 1] : undefined;
}

await loadFileBackedEnvironment(['DATABASE_URL']);
const pool = createDatabasePool();
try {
  await assertCompatibleSchema(pool);
  const report = evaluatePilotJourney(
    await observePilotJourney(pool, argument('workspace'))
  );
  console.log(JSON.stringify({ event: 'pilot.journey.verified', ...report }, null, 2));
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    event: 'pilot.journey.verification_failed',
    error: error instanceof Error ? error.message : String(error)
  }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
