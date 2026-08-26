import { createDatabasePool } from '../lib/server/database/pool.js';
import { assertCompatibleSchema } from '../lib/server/database/schema.js';
import { loadFileBackedEnvironment } from '../lib/server/configuration.js';
import { bootstrapOwner } from '../lib/server/authentication/bootstrap.js';

function argument(name: string): string | undefined {
  const position = process.argv.indexOf(`--${name}`);
  return position >= 0 ? process.argv[position + 1] : undefined;
}

await loadFileBackedEnvironment(['DATABASE_URL', 'RELAY_OWNER_PASSWORD']);
const email = argument('email');
const name = argument('name');
const workspaceName = argument('workspace');
const password = process.env.RELAY_OWNER_PASSWORD;

if (!email || !name || !workspaceName || !password) {
  console.error(
    'Usage: RELAY_OWNER_PASSWORD=... npm run bootstrap:owner -- --email owner@example.com --name "Owner" --workspace "MVP pilot workspace"'
  );
  process.exit(1);
}

const pool = createDatabasePool();
try {
  await assertCompatibleSchema(pool);
  const result = await bootstrapOwner(pool, { email, name, password, workspaceName });
  console.log(JSON.stringify({ event: 'workspace.owner.bootstrapped', ...result }));
} catch (error) {
  console.error(
    JSON.stringify({
      event: 'workspace.owner.bootstrap.failed',
      error: error instanceof Error ? error.message : String(error)
    })
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
