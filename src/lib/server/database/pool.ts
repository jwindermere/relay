import { Pool } from 'pg';

let databasePool: Pool | undefined;

export function requireDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  return databaseUrl;
}

export function createDatabasePool(connectionString = requireDatabaseUrl()): Pool {
  return new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5_000
  });
}

export function getDatabasePool(): Pool {
  databasePool ??= createDatabasePool();
  return databasePool;
}
