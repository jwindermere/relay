import { createDatabasePool } from '../lib/server/database/pool.js';
import { migrateDatabase } from '../lib/server/database/migrations.js';
import { getSchemaVersions } from '../lib/server/database/schema.js';

const pool = createDatabasePool();

try {
  await migrateDatabase(pool);
  const schemas = await getSchemaVersions(pool);
  console.log(JSON.stringify({ event: 'database.migrated', schemas }));
} catch (error) {
  console.error(JSON.stringify({ event: 'database.migration.failed', error: formatError(error) }));
  process.exitCode = 1;
} finally {
  await pool.end();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
