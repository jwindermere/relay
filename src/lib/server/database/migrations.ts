import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';

import {
  MIGRATION_STREAM_NAMES,
  MIGRATION_STREAMS,
  type MigrationStreamName
} from './schema.js';

const MIGRATION_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const MINIMUM_RUNTIME_PATTERN = /^-- minimum-runtime-version: (\d+)$/m;
const MIGRATION_LOCK = 7_362_935_269;

interface Migration {
  checksum: string;
  minimumRuntimeVersion: number;
  name: string;
  sql: string;
  version: number;
}

async function loadMigrations(directory: string, stream: MigrationStreamName): Promise<Migration[]> {
  const streamDirectory = resolve(directory, stream);
  const names = (await readdir(streamDirectory)).filter((name) => MIGRATION_PATTERN.test(name)).sort();

  return Promise.all(names.map(async (name) => {
    const sql = await readFile(resolve(streamDirectory, name), 'utf8');
    const version = Number(MIGRATION_PATTERN.exec(name)?.[1]);
    const declaredMinimum = MINIMUM_RUNTIME_PATTERN.exec(sql)?.[1];
    const minimumRuntimeVersion = declaredMinimum ? Number(declaredMinimum) : version;
    if (minimumRuntimeVersion > version) {
      throw new Error(`${name} requires a runtime schema interface newer than its version`);
    }
    const checksum = createHash('sha256').update(sql).digest('hex');
    return { checksum, minimumRuntimeVersion, name, sql, version };
  }));
}

async function prepareSchema(client: PoolClient, stream: MigrationStreamName): Promise<void> {
  const { postgresSchema } = MIGRATION_STREAMS[stream];
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${postgresSchema}`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${postgresSchema}.schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL UNIQUE,
      minimum_runtime_version integer NOT NULL,
      checksum text,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    ALTER TABLE ${postgresSchema}.schema_migrations
      ADD COLUMN IF NOT EXISTS minimum_runtime_version integer
  `);
  await client.query(`
    ALTER TABLE ${postgresSchema}.schema_migrations
      ADD COLUMN IF NOT EXISTS checksum text
  `);
  await client.query(`
    UPDATE ${postgresSchema}.schema_migrations
    SET minimum_runtime_version = version
    WHERE minimum_runtime_version IS NULL
  `);
  await client.query(`
    ALTER TABLE ${postgresSchema}.schema_migrations
      ALTER COLUMN minimum_runtime_version SET NOT NULL
  `);
}

async function applySchemaMigrations(
  client: PoolClient,
  directory: string,
  stream: MigrationStreamName,
  expandOnly: boolean
): Promise<void> {
  await prepareSchema(client, stream);
  const { postgresSchema, requiredVersion } = MIGRATION_STREAMS[stream];
  await client.query(`SET LOCAL search_path TO ${postgresSchema}`);
  const applied = await client.query<{ checksum: string | null; name: string; version: number }>(
    `SELECT version, name, checksum
     FROM ${postgresSchema}.schema_migrations ORDER BY version`
  );
  const appliedVersions = new Set(applied.rows.map(({ version }) => version));
  const deployedRuntimeVersion = applied.rows.at(-1)?.version ?? 0;
  const migrations = await loadMigrations(directory, stream);

  for (const record of applied.rows) {
    const migration = migrations.find(({ version }) => version === record.version);
    if (!migration || migration.name !== record.name) {
      throw new Error(
        `${stream} applied migration ${record.version} does not match the versioned migration set`
      );
    }
    if (record.checksum && record.checksum !== migration.checksum) {
      throw new Error(`${stream} applied migration ${record.name} has been modified`);
    }
    if (!record.checksum) {
      await client.query(
        `UPDATE ${postgresSchema}.schema_migrations SET checksum = $1 WHERE version = $2`,
        [migration.checksum, migration.version]
      );
    }
  }

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue;
    if (expandOnly && migration.minimumRuntimeVersion > deployedRuntimeVersion) {
      throw new Error(
        `${stream} migration ${migration.name} is a contract change requiring runtime schema interface ${migration.minimumRuntimeVersion}; drain old runtimes before applying it`
      );
    }

    await client.query(migration.sql);
    await client.query(
      `INSERT INTO ${postgresSchema}.schema_migrations (
         version, name, minimum_runtime_version, checksum
       ) VALUES ($1, $2, $3, $4)`,
      [
        migration.version,
        migration.name,
        migration.minimumRuntimeVersion,
        migration.checksum
      ]
    );
  }

  const latestVersion = migrations.at(-1)?.version ?? 0;
  if (latestVersion !== requiredVersion) {
    throw new Error(
      `${stream} migration set ends at version ${latestVersion}; runtime requires ${requiredVersion}`
    );
  }
}

export async function migrateDatabase(
  pool: Pool,
  options: { expandOnly?: boolean } = {}
): Promise<void> {
  const migrationsDirectory = resolve(process.cwd(), 'migrations');
  const client = await pool.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query('BEGIN');
    for (const stream of MIGRATION_STREAM_NAMES) {
      await applySchemaMigrations(client, migrationsDirectory, stream, options.expandOnly === true);
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
