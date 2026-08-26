import { createDatabasePool } from '../lib/server/database/pool.js';
import { migrateDatabase } from '../lib/server/database/migrations.js';
import { getMigrationStreamVersions } from '../lib/server/database/schema.js';
import { loadFileBackedEnvironment } from '../lib/server/configuration.js';
import { formatError } from '../lib/server/errors.js';

await loadFileBackedEnvironment(['DATABASE_URL']);
const pool = createDatabasePool();

try {
  await migrateDatabase(pool, {
    expandOnly: process.env.RELAY_REQUIRE_EXPAND_ONLY === 'true'
  });
  const schemas = await getMigrationStreamVersions(pool);
  console.log(JSON.stringify({ event: 'database.migrated', schemas }));
} catch (error) {
  console.error(JSON.stringify({ event: 'database.migration.failed', error: formatError(error) }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
