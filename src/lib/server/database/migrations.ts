import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';

import {
  MIGRATION_STREAM_NAMES,
  MIGRATION_STREAMS,
  type MigrationStreamName
} from './schema.js';

const MIGRATION_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const MIGRATION_LOCK = 7_362_935_269;

interface Migration {
  name: string;
  sql: string;
  version: number;
}

async function loadMigrations(directory: string, stream: MigrationStreamName): Promise<Migration[]> {
  const streamDirectory = resolve(directory, stream);
  const names = (await readdir(streamDirectory)).filter((name) => MIGRATION_PATTERN.test(name)).sort();

  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(resolve(streamDirectory, name), 'utf8'),
      version: Number(MIGRATION_PATTERN.exec(name)?.[1])
    }))
  );
}

async function prepareSchema(client: PoolClient, stream: MigrationStreamName): Promise<void> {
  const { postgresSchema } = MIGRATION_STREAMS[stream];
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${postgresSchema}`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${postgresSchema}.schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL UNIQUE,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function applySchemaMigrations(
  client: PoolClient,
  directory: string,
  stream: MigrationStreamName
): Promise<void> {
  await prepareSchema(client, stream);
  const { postgresSchema, requiredVersion } = MIGRATION_STREAMS[stream];
  await client.query(`SET LOCAL search_path TO ${postgresSchema}`);
  const applied = await client.query<{ version: number }>(
    `SELECT version FROM ${postgresSchema}.schema_migrations ORDER BY version`
  );
  const appliedVersions = new Set(applied.rows.map(({ version }) => version));
  const migrations = await loadMigrations(directory, stream);

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue;

    await client.query(migration.sql);
    await client.query(
      `INSERT INTO ${postgresSchema}.schema_migrations (version, name) VALUES ($1, $2)`,
      [migration.version, migration.name]
    );
  }

  const latestVersion = migrations.at(-1)?.version ?? 0;
  if (latestVersion !== requiredVersion) {
    throw new Error(
      `${stream} migration set ends at version ${latestVersion}; runtime requires ${requiredVersion}`
    );
  }
}

export async function migrateDatabase(pool: Pool): Promise<void> {
  const migrationsDirectory = resolve(process.cwd(), 'migrations');
  const client = await pool.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query('BEGIN');
    for (const stream of MIGRATION_STREAM_NAMES) {
      await applySchemaMigrations(client, migrationsDirectory, stream);
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
