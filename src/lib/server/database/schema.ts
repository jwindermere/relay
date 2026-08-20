import type { Pool } from 'pg';

export const REQUIRED_SCHEMA_VERSIONS = Object.freeze({
  relay: 1,
  auth: 1
});

export type SchemaName = keyof typeof REQUIRED_SCHEMA_VERSIONS;
export type SchemaVersions = Record<SchemaName, number>;

export class IncompatibleSchemaError extends Error {
  readonly actualVersions: SchemaVersions;
  readonly requiredVersions: SchemaVersions;

  constructor(actualVersions: SchemaVersions) {
    const mismatch = (Object.keys(REQUIRED_SCHEMA_VERSIONS) as SchemaName[]).find(
      (schema) => actualVersions[schema] !== REQUIRED_SCHEMA_VERSIONS[schema]
    );
    const detail = mismatch
      ? `${mismatch} schema version ${actualVersions[mismatch]} is incompatible with required version ${REQUIRED_SCHEMA_VERSIONS[mismatch]}`
      : 'database schema is incompatible';

    super(detail);
    this.name = 'IncompatibleSchemaError';
    this.actualVersions = actualVersions;
    this.requiredVersions = REQUIRED_SCHEMA_VERSIONS;
  }
}

async function readSchemaVersion(pool: Pool, schema: SchemaName): Promise<number> {
  const table = await pool.query<{ exists: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS exists',
    [`${schema}.schema_migrations`]
  );

  if (!table.rows[0]?.exists) return 0;

  const result = await pool.query<{ version: number }>(
    `SELECT COALESCE(MAX(version), 0)::integer AS version FROM ${schema}.schema_migrations`
  );
  return result.rows[0]?.version ?? 0;
}

export async function getSchemaVersions(pool: Pool): Promise<SchemaVersions> {
  const [relay, auth] = await Promise.all([
    readSchemaVersion(pool, 'relay'),
    readSchemaVersion(pool, 'auth')
  ]);
  return { relay, auth };
}

export async function assertCompatibleSchema(pool: Pool): Promise<SchemaVersions> {
  const actualVersions = await getSchemaVersions(pool);
  const compatible = (Object.keys(REQUIRED_SCHEMA_VERSIONS) as SchemaName[]).every(
    (schema) => actualVersions[schema] === REQUIRED_SCHEMA_VERSIONS[schema]
  );

  if (!compatible) throw new IncompatibleSchemaError(actualVersions);
  return actualVersions;
}
