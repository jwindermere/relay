import { betterAuth } from 'better-auth';
import { Pool } from 'pg';

import { requireDatabaseUrl } from './database/pool.js';

export function createAuthDatabasePool(connectionString = requireDatabaseUrl()): Pool {
  return new Pool({
    connectionString,
    options: '-c search_path=auth'
  });
}

interface RelayAuthOptions {
  pool: Pool;
  baseURL?: string;
  secret?: string;
}

async function recordSessionAudit(
  pool: Pool,
  session: { id: string; userId: string },
  eventType: 'authentication.session.created' | 'authentication.session.revoked'
): Promise<void> {
  await pool.query(
    `INSERT INTO public.audit_event (
       workspace_id, actor_user_id, event_type, subject_type, subject_id, evidence
     )
     SELECT workspace_id, $1, $2, 'session', $3, jsonb_build_object('userId', $1::text)
     FROM public.workspace_membership
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY joined_at
     LIMIT 1`,
    [session.userId, eventType, session.id]
  );
}

async function notifyAccessRevoked(pool: Pool, userId: string): Promise<void> {
  await pool.query(`SELECT pg_notify('relay_access_revoked', $1)`, [userId]);
}

export function createRelayAuth({ pool, baseURL, secret }: RelayAuthOptions) {
  return betterAuth({
    database: pool,
    baseURL,
    secret,
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: true
    },
    databaseHooks: {
      session: {
        create: {
          after: async (session) => {
            await recordSessionAudit(pool, session, 'authentication.session.created');
          }
        },
        delete: {
          after: async (session) => {
            await recordSessionAudit(pool, session, 'authentication.session.revoked');
            await notifyAccessRevoked(pool, session.userId);
          }
        }
      }
    }
  });
}

export type RelayAuth = ReturnType<typeof createRelayAuth>;

let authDatabasePool: Pool | undefined;
let auth: RelayAuth | undefined;

export function getAuthDatabasePool(): Pool {
  authDatabasePool ??= createAuthDatabasePool();
  return authDatabasePool;
}

export function getRelayAuth(): RelayAuth {
  auth ??= createRelayAuth({ pool: getAuthDatabasePool() });
  return auth;
}
