import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import type { Pool, PoolClient } from 'pg';

import type { RelayAuth } from '../auth.js';
import { addPilotToCollaborationProject } from '../collaboration/setup.js';
import { WorkspaceAccessError, type WorkspaceAccess } from './authorization.js';

const INVITATION_LIFETIME_MS = 24 * 60 * 60 * 1_000;

export interface WorkspaceInvitation {
  id: string;
  email: string;
  expiresAt: Date;
  token: string;
}

export interface AcceptedWorkspaceInvitation {
  workspace: WorkspaceAccess['workspace'];
  membership: WorkspaceAccess['membership'];
}

export interface InvitedAccount {
  userId: string;
  email: string;
}

export class WorkspaceInvitationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceInvitationError';
  }
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(normalized)) {
    throw new WorkspaceInvitationError('a valid invitation email is required');
  }
  return normalized;
}

function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface AvailableInvitation {
  id: string;
  workspace_id: string;
  workspace_name: string;
  email: string;
}

async function lockAvailableInvitation(
  client: PoolClient,
  token: string
): Promise<AvailableInvitation> {
  const invitation = await client.query<AvailableInvitation>(
    `SELECT i.id, i.workspace_id, w.name AS workspace_name, i.email
     FROM public.workspace_invitation i
     JOIN public.workspace w ON w.id = i.workspace_id
     WHERE i.token_hash = $1
       AND i.accepted_at IS NULL
       AND i.revoked_at IS NULL
       AND i.expires_at > now()
     FOR UPDATE OF i`,
    [hashInvitationToken(token)]
  );
  const available = invitation.rows[0];
  if (!available) throw new WorkspaceInvitationError('invitation is no longer available');
  return available;
}

export async function issueWorkspaceInvitation(
  pool: Pool,
  actor: WorkspaceAccess,
  input: { email: string }
): Promise<WorkspaceInvitation> {
  if (actor.membership.role !== 'owner') {
    throw new WorkspaceAccessError('Workspace owner access is required');
  }

  const email = normalizeEmail(input.email);
  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashInvitationToken(token);
  const expiresAt = new Date(Date.now() + INVITATION_LIFETIME_MS);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const currentActor = await client.query<{ membership_id: string }>(
      `SELECT m.id AS membership_id
       FROM public.workspace_membership m
       JOIN auth.session s ON s."userId" = m.user_id
       WHERE m.workspace_id = $1
         AND m.user_id = $2
         AND m.role = 'owner'
         AND m.revoked_at IS NULL
         AND s.id = $3
         AND s."expiresAt" > now()
       FOR UPDATE OF m, s`,
      [actor.workspace.id, actor.identity.userId, actor.identity.sessionId]
    );
    if (currentActor.rows[0]?.membership_id !== actor.membership.id) {
      throw new WorkspaceAccessError('current Workspace owner access is required');
    }

    const workspace = await client.query(
      'SELECT id FROM public.workspace WHERE id = $1 FOR UPDATE',
      [actor.workspace.id]
    );
    if (!workspace.rows[0]) throw new WorkspaceAccessError();

    const members = await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM public.workspace_membership
       WHERE workspace_id = $1 AND revoked_at IS NULL`,
      [actor.workspace.id]
    );
    if ((members.rows[0]?.count ?? 0) >= 2) {
      throw new WorkspaceInvitationError('Workspace already has both Pilot members');
    }

    const existingMember = await client.query(
      `SELECT 1
       FROM public.workspace_membership m
       JOIN auth."user" u ON u.id = m.user_id
       WHERE m.workspace_id = $1 AND m.revoked_at IS NULL AND lower(u.email) = $2`,
      [actor.workspace.id, email]
    );
    if (existingMember.rows[0]) {
      throw new WorkspaceInvitationError('email already belongs to an active Workspace member');
    }

    const pendingInvitation = await client.query(
      `SELECT 1
       FROM public.workspace_invitation
       WHERE workspace_id = $1
         AND accepted_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > now()`,
      [actor.workspace.id]
    );
    if (pendingInvitation.rows[0]) {
      throw new WorkspaceInvitationError('Workspace already has an active invitation');
    }

    await client.query(
      `INSERT INTO public.workspace_invitation (
         id, workspace_id, email, token_hash, inviter_membership_id, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, actor.workspace.id, email, tokenHash, actor.membership.id, expiresAt]
    );
    await client.query(
      `INSERT INTO public.audit_event (
         workspace_id, actor_user_id, actor_membership_id,
         event_type, subject_type, subject_id, evidence
       ) VALUES ($1, $2, $3, 'invitation.issued', 'workspace_invitation', $4,
         jsonb_build_object('email', $5::text, 'expiresAt', $6::timestamptz))`,
      [
        actor.workspace.id,
        actor.identity.userId,
        actor.membership.id,
        id,
        email,
        expiresAt
      ]
    );
    await client.query('COMMIT');
    return { id, email, expiresAt, token };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function registerInvitedAccount(
  pool: Pool,
  auth: RelayAuth,
  token: string,
  input: { name: string; password: string }
): Promise<InvitedAccount> {
  const name = input.name.trim();
  if (!name) throw new WorkspaceInvitationError('a name is required');
  if (input.password.length < 8 || input.password.length > 128) {
    throw new WorkspaceInvitationError('password must contain between 8 and 128 characters');
  }

  const passwordHash = await hashPassword(input.password);
  const client = await pool.connect();
  let invitedAccount: InvitedAccount | undefined;

  try {
    await client.query('BEGIN');
    const pending = await lockAvailableInvitation(client, token);

    const existing = await client.query<{ id: string; email_verified: boolean }>(
      `SELECT id, "emailVerified" AS email_verified
       FROM auth."user"
       WHERE lower(email) = $1
       FOR UPDATE`,
      [pending.email]
    );
    if (existing.rows[0]?.email_verified) {
      throw new WorkspaceInvitationError('verified account already exists; sign in to accept');
    }

    if (existing.rows[0]) {
      invitedAccount = { userId: existing.rows[0].id, email: pending.email };
    } else {
      const userId = randomUUID();
      await client.query(
        `INSERT INTO auth."user" (
           id, name, email, "emailVerified", "createdAt", "updatedAt"
         ) VALUES ($1, $2, $3, false, now(), now())`,
        [userId, name, pending.email]
      );
      await client.query(
        `INSERT INTO auth.account (
           id, issuer, "accountId", "providerId", "userId", password, "createdAt", "updatedAt"
         ) VALUES ($1, 'local:credential', $2, 'credential', $2, $3, now(), now())`,
        [randomUUID(), userId, passwordHash]
      );
      await client.query(
        `INSERT INTO public.audit_event (
           workspace_id, event_type, subject_type, subject_id, evidence
         ) VALUES ($1, 'authentication.invited_account.created', 'user', $2,
           jsonb_build_object('invitationId', $3::text, 'email', $4::text))`,
        [pending.workspace_id, userId, pending.id, pending.email]
      );
      invitedAccount = { userId, email: pending.email };
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  if (!invitedAccount) throw new WorkspaceInvitationError('invited account could not be created');
  await auth.api.sendVerificationEmail({
    body: { email: invitedAccount.email, callbackURL: '/sign-in' }
  });
  return invitedAccount;
}

export async function acceptWorkspaceInvitation(
  pool: Pool,
  auth: RelayAuth,
  headers: Headers,
  token: string
): Promise<AcceptedWorkspaceInvitation> {
  const authenticated = await auth.api.getSession({
    headers,
    query: { disableCookieCache: true }
  });
  if (!authenticated?.user.emailVerified) {
    throw new WorkspaceInvitationError('an authenticated verified email is required');
  }

  const client = await pool.connect();
  const membershipId = randomUUID();

  try {
    await client.query('BEGIN');
    const pending = await lockAvailableInvitation(client, token);
    if (normalizeEmail(authenticated.user.email) !== pending.email) {
      throw new WorkspaceInvitationError('verified email does not match invitation');
    }

    await client.query('SELECT id FROM public.workspace WHERE id = $1 FOR UPDATE', [
      pending.workspace_id
    ]);
    const members = await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM public.workspace_membership
       WHERE workspace_id = $1 AND revoked_at IS NULL`,
      [pending.workspace_id]
    );
    if ((members.rows[0]?.count ?? 0) >= 2) {
      throw new WorkspaceInvitationError('Workspace already has both Pilot members');
    }

    const membership = await client.query<{
      id: string;
      user_id: string;
      role: 'member';
      joined_at: Date;
    }>(
      `INSERT INTO public.workspace_membership (id, workspace_id, user_id, role)
       VALUES ($1, $2, $3, 'member')
       RETURNING id, user_id, role, joined_at`,
      [membershipId, pending.workspace_id, authenticated.user.id]
    );
    const joined = membership.rows[0];
    if (!joined) throw new WorkspaceInvitationError('membership could not be created');

    await addPilotToCollaborationProject(client, pending.workspace_id, joined.id);

    await client.query(
      `UPDATE public.workspace_invitation
       SET accepted_at = now(), accepted_membership_id = $2
       WHERE id = $1`,
      [pending.id, joined.id]
    );
    await client.query(
      `INSERT INTO public.audit_event (
         workspace_id, actor_user_id, actor_membership_id,
         event_type, subject_type, subject_id, evidence
       ) VALUES
         ($1, $2, $3, 'membership.joined', 'workspace_membership', $3,
           jsonb_build_object('invitationId', $4::text, 'role', 'member')),
         ($1, $2, $3, 'invitation.accepted', 'workspace_invitation', $4,
           jsonb_build_object('membershipId', $3::text))`,
      [pending.workspace_id, authenticated.user.id, joined.id, pending.id]
    );
    await client.query('COMMIT');

    return {
      workspace: { id: pending.workspace_id, name: pending.workspace_name },
      membership: {
        id: joined.id,
        userId: joined.user_id,
        role: joined.role,
        joinedAt: joined.joined_at
      }
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
