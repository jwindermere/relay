import { betterAuth } from 'better-auth';
import { Pool } from 'pg';

import { requireDatabaseUrl } from './database/pool.js';

export const authDatabasePool = new Pool({
  connectionString: requireDatabaseUrl(),
  options: '-c search_path=auth'
});

export const auth = betterAuth({
  database: authDatabasePool,
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true
  }
});
