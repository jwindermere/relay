import type { Pool } from 'pg';

import { assertCompatibleSchema, type SchemaVersions } from './database/schema.js';

export interface RuntimeReadiness {
  database: 'ready';
  schemas: SchemaVersions;
}

export async function checkRuntimeReadiness(pool: Pool): Promise<RuntimeReadiness> {
  await pool.query('SELECT 1');
  return {
    database: 'ready',
    schemas: await assertCompatibleSchema(pool)
  };
}
