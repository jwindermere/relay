import type { Pool } from 'pg';

import { assertCompatibleSchema, type MigrationStreamVersions } from './database/schema.js';

export interface RuntimeReadiness {
  database: 'ready';
  schemas: MigrationStreamVersions;
}

export async function checkRuntimeReadiness(pool: Pool): Promise<RuntimeReadiness> {
  await pool.query('SELECT 1');
  return {
    database: 'ready',
    schemas: await assertCompatibleSchema(pool)
  };
}
