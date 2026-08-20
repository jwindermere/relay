import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';

import { REQUIRED_SCHEMA_VERSIONS, type SchemaName } from './schema.js';

const SCHEMAS = Object.keys(REQUIRED_SCHEMA_VERSIONS) as SchemaName[];
const MIGRATION_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const MIGRATION_LOCK = 7_362_935_269;

export interface MigrateDatabaseOptions {
  migrationsDirectory?: string;
}

interface Migration {
  name: string;
  sql: string;
  version: number;
}

async function loadMigrations(directory: string, schema: SchemaName): Promise<Migration[]> {
  const schemaDirectory = resolve(directory, schema);
  const names = (await readdir(schemaDirectory)).filter((name) => MIGRATION_PATTERN.test(name)).sort();

  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(resolve(schemaDirectory, name), 'utf8'),
      version: Number(MIGRATION_PATTERN.exec(name)?.[1])
    }))
  );
}

async function prepareSchema(client: PoolClient, schema: SchemaName): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL UNIQUE,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function applySchemaMigrations(
  client: PoolClient,
  directory: string,
  schema: SchemaName
): Promise<void> {
  await prepareSchema(client, schema);
  const applied = await client.query<{ version: number }>(
    `SELECT version FROM ${schema}.schema_migrations ORDER BY version`
  );
  const appliedVersions = new Set(applied.rows.map(({ version }) => version));
  const migrations = await loadMigrations(directory, schema);

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue;

    await client.query(migration.sql);
    await client.query(
      `INSERT INTO ${schema}.schema_migrations (version, name) VALUES ($1, $2)`,
      [migration.version, migration.name]
    );
  }

  const latestVersion = migrations.at(-1)?.version ?? 0;
  if (latestVersion !== REQUIRED_SCHEMA_VERSIONS[schema]) {
    throw new Error(
      `${schema} migration set ends at version ${latestVersion}; runtime requires ${REQUIRED_SCHEMA_VERSIONS[schema]}`
    );
  }
}

export async function migrateDatabase(
  pool: Pool,
  options: MigrateDatabaseOptions = {}
): Promise<void> {
  const migrationsDirectory = options.migrationsDirectory ?? resolve(process.cwd(), 'migrations');
  const client = await pool.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query('BEGIN');
    for (const schema of SCHEMAS) {
      await applySchemaMigrations(client, migrationsDirectory, schema);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]);
    client.release();
  }
}
