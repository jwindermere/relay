import { parseArgs } from 'node:util';

import { loadFileBackedEnvironment } from '../lib/server/configuration.js';
import { createDatabasePool } from '../lib/server/database/pool.js';
import { assertCompatibleSchema } from '../lib/server/database/schema.js';
import { evaluatePilotJourneyDurableEvidence } from '../lib/pilot-journey.js';
import { observePilotJourney } from '../lib/server/pilot-journey.js';

await loadFileBackedEnvironment(['DATABASE_URL']);
const pool = createDatabasePool();
try {
  const { values } = parseArgs({
    options: {
      workspace: { type: 'string' },
      since: { type: 'string' }
    }
  });
  const since = values.since ? new Date(values.since) : undefined;
  if (since && Number.isNaN(since.getTime())) {
    throw new Error('--since must be an ISO-8601 timestamp');
  }
  await assertCompatibleSchema(pool);
  const report = evaluatePilotJourneyDurableEvidence(
    await observePilotJourney(pool, { workspaceId: values.workspace, since })
  );
  console.log(JSON.stringify({
    event: 'pilot.journey.durable_evidence_audited',
    ...report
  }, null, 2));
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
