import { betterAuth } from 'better-auth';
import { Pool } from 'pg';

import { requireDatabaseUrl } from './database/pool.js';
import { publishAccessRevoked } from './authentication/access-revocation.js';

export function createAuthDatabasePool(connectionString = requireDatabaseUrl()): Pool {
  return new Pool({
    connectionString,
    options: '-c search_path=auth'
  });
}

interface VerificationEmail {
  user: { email: string };
  url: string;
}

interface RelayAuthOptions {
  pool: Pool;
  baseURL?: string;
  secret?: string;
  sendVerificationEmail?: (data: VerificationEmail) => Promise<void>;
}

async function recordSessionAudit(
  pool: Pool,
  session: { id: string; userId: string },
  eventType: 'authentication.session.created' | 'authentication.session.revoked'
): Promise<void> {
  await pool.query(
    `INSERT INTO public.audit_event (
       workspace_id, actor_user_id, actor_membership_id,
       event_type, subject_type, subject_id, evidence
     )
     SELECT workspace_id, $1, id, $2, 'session', $3,
       jsonb_build_object('userId', $1::text)
     FROM public.workspace_membership
     WHERE user_id = $1
     UNION ALL
     SELECT i.workspace_id, $1, NULL, $2, 'session', $3,
       jsonb_build_object('userId', $1::text, 'pendingInvitationId', i.id)
     FROM public.workspace_invitation i
     JOIN auth."user" u ON lower(u.email) = i.email
     WHERE u.id = $1
       AND i.accepted_at IS NULL
       AND i.revoked_at IS NULL
       AND i.expires_at > now()
     ORDER BY actor_membership_id NULLS LAST
     LIMIT 1`,
    [session.userId, eventType, session.id]
  );
}

async function recordEmailVerificationAudit(
  pool: Pool,
  user: { id: string; email: string }
): Promise<void> {
  await pool.query(
    `INSERT INTO public.audit_event (
       workspace_id, actor_user_id, event_type, subject_type, subject_id, evidence
     )
     SELECT i.workspace_id, $1, 'authentication.email.verified', 'user', $1,
       jsonb_build_object('invitationId', i.id, 'email', i.email)
     FROM public.workspace_invitation i
     WHERE i.email = lower($2)
       AND i.accepted_at IS NULL
       AND i.revoked_at IS NULL
       AND i.expires_at > now()
     ORDER BY i.created_at DESC
     LIMIT 1`,
    [user.id, user.email]
  );
}

export function createRelayAuth({
  pool,
  baseURL,
  secret,
  sendVerificationEmail
}: RelayAuthOptions) {
  return betterAuth({
    database: pool,
    baseURL,
    secret,
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: true
    },
    emailVerification: sendVerificationEmail
      ? {
          sendVerificationEmail,
          sendOnSignIn: true,
          afterEmailVerification: async (user) => recordEmailVerificationAudit(pool, user)
        }
      : { afterEmailVerification: async (user) => recordEmailVerificationAudit(pool, user) },
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
            await publishAccessRevoked(pool, {
              kind: 'session',
              sessionId: session.id,
              userId: session.userId
            });
          }
        }
      }
    }
  });
}

export type RelayAuth = ReturnType<typeof createRelayAuth>;

let authDatabasePool: Pool | undefined;
let auth: RelayAuth | undefined;

function createVerificationEmailSender(): RelayAuthOptions['sendVerificationEmail'] {
  const endpoint = process.env.RELAY_EMAIL_DELIVERY_URL;
  if (!endpoint) return undefined;

  return async ({ user, url }) => {
    const headers = new Headers({ 'content-type': 'application/json' });
    const deliveryToken = process.env.RELAY_EMAIL_DELIVERY_TOKEN;
    if (deliveryToken) headers.set('authorization', `Bearer ${deliveryToken}`);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        to: user.email,
        template: 'verify-relay-email',
        verificationUrl: url
      })
    });
    if (!response.ok) {
      throw new Error(`verification email delivery failed with status ${response.status}`);
    }
  };
}

export function getAuthDatabasePool(): Pool {
  authDatabasePool ??= createAuthDatabasePool();
  return authDatabasePool;
}

export function getRelayAuth(): RelayAuth {
  auth ??= createRelayAuth({
    pool: getAuthDatabasePool(),
    sendVerificationEmail: createVerificationEmailSender()
  });
  return auth;
}
