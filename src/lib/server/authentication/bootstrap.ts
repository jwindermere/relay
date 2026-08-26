import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import type { Pool } from 'pg';

const BOOTSTRAP_LOCK = 7_329_381_112;

export interface BootstrapOwnerInput {
  email: string;
  name: string;
  password: string;
  workspaceName: string;
}

export interface BootstrapOwnerResult {
  userId: string;
  workspaceId: string;
}

export async function bootstrapOwner(
  pool: Pool,
  input: BootstrapOwnerInput
): Promise<BootstrapOwnerResult> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  const workspaceName = input.workspaceName.trim();
  if (!email || !name || !workspaceName) throw new Error('email, name, and workspace name are required');
  if (input.password.length < 8 || input.password.length > 128) {
    throw new Error('password must contain between 8 and 128 characters');
  }

  const passwordHash = await hashPassword(input.password);
  const client = await pool.connect();
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const membershipId = randomUUID();

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [BOOTSTRAP_LOCK]);
    const existing = await client.query<{ bootstrapped: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM public.workspace
        UNION ALL
        SELECT 1 FROM public.workspace_membership
        UNION ALL
        SELECT 1 FROM auth."user"
      ) AS bootstrapped
    `);
    if (existing.rows[0]?.bootstrapped) throw new Error('Relay is already bootstrapped');

    await client.query(
      `INSERT INTO auth."user" (
         id, name, email, "emailVerified", "createdAt", "updatedAt"
       ) VALUES ($1, $2, $3, true, now(), now())`,
      [userId, name, email]
    );
    await client.query(
      `INSERT INTO auth.account (
         id, issuer, "accountId", "providerId", "userId", password, "createdAt", "updatedAt"
       ) VALUES ($1, 'local:credential', $2, 'credential', $2, $3, now(), now())`,
      [randomUUID(), userId, passwordHash]
    );
    await client.query('INSERT INTO public.workspace (id, name) VALUES ($1, $2)', [
      workspaceId,
      workspaceName
    ]);
    await client.query(
      `INSERT INTO public.workspace_membership (id, workspace_id, user_id, role)
       VALUES ($1, $2, $3, 'owner')`,
      [membershipId, workspaceId, userId]
    );
    await client.query(
      `INSERT INTO public.audit_event (
         workspace_id, actor_user_id, actor_membership_id,
         event_type, subject_type, subject_id, evidence
       ) VALUES ($1, $2, $3, 'workspace.bootstrapped', 'workspace', $1,
         jsonb_build_object('ownerUserId', $2::text))`,
      [workspaceId, userId, membershipId]
    );
    await client.query('COMMIT');
    return { userId, workspaceId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
