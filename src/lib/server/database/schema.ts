import type { Pool } from 'pg';

export const MIGRATION_STREAMS = Object.freeze({
  auth: Object.freeze({ postgresSchema: 'auth', requiredVersion: 1 }),
  relay: Object.freeze({ postgresSchema: 'public', requiredVersion: 5 })
});

export type MigrationStreamName = keyof typeof MIGRATION_STREAMS;
export type MigrationStreamVersions = Record<MigrationStreamName, number>;

export const MIGRATION_STREAM_NAMES = Object.freeze(
  Object.keys(MIGRATION_STREAMS) as MigrationStreamName[]
);

export const REQUIRED_MIGRATION_STREAM_VERSIONS: MigrationStreamVersions = Object.freeze({
  auth: MIGRATION_STREAMS.auth.requiredVersion,
  relay: MIGRATION_STREAMS.relay.requiredVersion
});

export class IncompatibleSchemaError extends Error {
  readonly actualVersions: MigrationStreamVersions;
  readonly requiredVersions: MigrationStreamVersions;

  constructor(actualVersions: MigrationStreamVersions) {
    const mismatch = MIGRATION_STREAM_NAMES.find(
      (stream) => actualVersions[stream] !== REQUIRED_MIGRATION_STREAM_VERSIONS[stream]
    );
    const detail = mismatch
      ? `${mismatch} schema version ${actualVersions[mismatch]} is incompatible with required version ${REQUIRED_MIGRATION_STREAM_VERSIONS[mismatch]}`
      : 'database schema is incompatible';

    super(detail);
    this.name = 'IncompatibleSchemaError';
    this.actualVersions = actualVersions;
    this.requiredVersions = REQUIRED_MIGRATION_STREAM_VERSIONS;
  }
}

async function readMigrationStreamVersion(
  pool: Pool,
  stream: MigrationStreamName
): Promise<number> {
  const { postgresSchema } = MIGRATION_STREAMS[stream];
  const table = await pool.query<{ exists: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS exists',
    [`${postgresSchema}.schema_migrations`]
  );

  if (!table.rows[0]?.exists) return 0;

  const result = await pool.query<{ version: number }>(
    `SELECT COALESCE(MAX(version), 0)::integer AS version FROM ${postgresSchema}.schema_migrations`
  );
  return result.rows[0]?.version ?? 0;
}

export async function getMigrationStreamVersions(pool: Pool): Promise<MigrationStreamVersions> {
  const [relay, auth] = await Promise.all([
    readMigrationStreamVersion(pool, 'relay'),
    readMigrationStreamVersion(pool, 'auth')
  ]);
  return { relay, auth };
}

export async function assertCompatibleSchema(pool: Pool): Promise<MigrationStreamVersions> {
  const actualVersions = await getMigrationStreamVersions(pool);
  const compatible = MIGRATION_STREAM_NAMES.every(
    (stream) => actualVersions[stream] === REQUIRED_MIGRATION_STREAM_VERSIONS[stream]
  );

  if (!compatible) throw new IncompatibleSchemaError(actualVersions);
  return actualVersions;
}
