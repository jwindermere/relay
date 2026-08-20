import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';

import { migrateDatabase } from '../src/lib/server/database/migrations.js';
import {
  assertCompatibleSchema,
  IncompatibleSchemaError,
  REQUIRED_SCHEMA_VERSIONS
} from '../src/lib/server/database/schema.js';

let container: StartedPostgreSqlContainer | undefined;
let connectionString = process.env.TEST_DATABASE_URL;

if (!connectionString) {
  try {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    connectionString = container.getConnectionUri();
  } catch {
    test('the production PostgreSQL seam', {
      skip: 'requires TEST_DATABASE_URL or an available Docker daemon'
    });
  }
}

if (connectionString) {
  const pool = new Pool({ connectionString });
  after(async () => {
    await pool.end();
    await container?.stop();
  });

  test('migrations isolate and version Relay and authentication data', async () => {
    await migrateDatabase(pool);

    const result = await pool.query<{ table_schema: string; table_name: string }>(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_schema IN ('relay', 'auth')
      ORDER BY table_schema, table_name
    `);

    assert.deepEqual(result.rows, [
      { table_schema: 'auth', table_name: 'schema_migrations' },
      { table_schema: 'auth', table_name: 'sessions' },
      { table_schema: 'relay', table_name: 'runtime_state' },
      { table_schema: 'relay', table_name: 'schema_migrations' }
    ]);
    await assert.doesNotReject(assertCompatibleSchema(pool));
  });

  test('a runtime rejects an incompatible schema version', async () => {
    await pool.query('UPDATE relay.schema_migrations SET version = 99');

    try {
      await assert.rejects(assertCompatibleSchema(pool), (error: unknown) => {
        assert.ok(error instanceof IncompatibleSchemaError);
        assert.match(error.message, /relay schema version 99 is incompatible/);
        assert.deepEqual(error.requiredVersions, REQUIRED_SCHEMA_VERSIONS);
        return true;
      });
    } finally {
      await pool.query('UPDATE relay.schema_migrations SET version = 1');
    }
  });
}
