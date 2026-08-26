import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import {
  assertCurrentWorkspaceOwner,
  type WorkspaceAccess
} from '../authentication/authorization.js';
import {
  evaluateRepositoryProtection,
  type GitHubRepositoryEvidence,
  type RepositoryProtectionResult
} from './protection.js';

export interface GitHubRepositoryGateway {
  inspect(input: {
    installationId: string;
    repositoryId?: string;
    releaseBranches: string[];
  }): Promise<GitHubRepositoryEvidence>;
}

export interface SafeLinkedRepository {
  state: 'not_linked' | 'linked' | 'disabled';
  readyForAutonomousWork: boolean;
  canManage: boolean;
  configuration?: {
    connectionId: string;
    installationId: string;
    repositoryId: string;
    repository: {
      owner: string;
      name: string;
      defaultBranch: string;
      releaseBranches: string[];
    };
    protection: RepositoryProtectionResult;
    checkedAt: Date;
  };
}

export class LinkedRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinkedRepositoryError';
  }
}

interface LinkedRepositoryRow {
  id: string;
  installation_id: string;
  repository_id: string;
  repository_owner: string;
  repository_name: string;
  default_branch: string;
  release_branches: string[];
  status: 'linked' | 'disabled';
  ready_for_autonomous_work: boolean;
  verification: RepositoryProtectionResult;
  checked_at: Date;
}

async function readConnection(
  client: Pick<Pool, 'query'> | PoolClient,
  workspaceId: string
): Promise<LinkedRepositoryRow | undefined> {
  const result = await client.query<LinkedRepositoryRow>(
    `SELECT id, installation_id, repository_id, repository_owner, repository_name,
       default_branch, release_branches, status, ready_for_autonomous_work,
       verification, checked_at
     FROM public.github_repository_connection
     WHERE workspace_id = $1`,
    [workspaceId]
  );
  return result.rows[0];
}

function safeConnection(
  row: LinkedRepositoryRow | undefined,
  canManage: boolean
): SafeLinkedRepository {
  if (!row) {
    return { state: 'not_linked', readyForAutonomousWork: false, canManage };
  }
  return {
    state: row.status,
    readyForAutonomousWork: row.status === 'linked' && row.ready_for_autonomous_work,
    canManage,
    ...(canManage ? {
      configuration: {
        connectionId: row.id,
        installationId: row.installation_id,
        repositoryId: row.repository_id,
        repository: {
          owner: row.repository_owner,
          name: row.repository_name,
          defaultBranch: row.default_branch,
          releaseBranches: row.release_branches
        },
        protection: row.verification,
        checkedAt: row.checked_at
      }
    } : {})
  };
}

function validateLinkInput(input: {
  installationId: string;
  repositoryId?: string;
  releaseBranches: string[];
}): void {
  if (!/^\d+$/.test(input.installationId) || (
    input.repositoryId !== undefined && !/^\d+$/.test(input.repositoryId)
  )) {
    throw new LinkedRepositoryError('GitHub installation and repository IDs must be integers');
  }
  if (
    input.releaseBranches.length > 20
    || input.releaseBranches.some((branch) => !branch || branch.length > 255)
  ) {
    throw new LinkedRepositoryError('release branch configuration is invalid');
  }
}

async function withCurrentOwner<T>(
  pool: Pool,
  access: WorkspaceAccess,
  operation: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertCurrentWorkspaceOwner(client, access);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function inspectRepository(
  gateway: GitHubRepositoryGateway,
  input: { installationId: string; repositoryId?: string; releaseBranches: string[] }
): Promise<{ evidence: GitHubRepositoryEvidence; protection: RepositoryProtectionResult }> {
  let evidence: GitHubRepositoryEvidence;
  try {
    evidence = await gateway.inspect(input);
  } catch {
    throw new LinkedRepositoryError('GitHub repository configuration could not be verified');
  }
  if (
    String(evidence.installation.id) !== input.installationId
    || (input.repositoryId !== undefined && String(evidence.repository.id) !== input.repositoryId)
  ) {
    throw new LinkedRepositoryError('GitHub returned a different installation or repository identity');
  }
  return {
    evidence,
    protection: evaluateRepositoryProtection(evidence, input.releaseBranches)
  };
}

export async function loadLinkedRepository(
  pool: Pool,
  access: WorkspaceAccess
): Promise<SafeLinkedRepository> {
  if (access.membership.role !== 'owner') {
    return safeConnection(await readConnection(pool, access.workspace.id), false);
  }
  return withCurrentOwner(pool, access, async (client) =>
    safeConnection(await readConnection(client, access.workspace.id), true)
  );
}

export async function linkGitHubRepository(
  pool: Pool,
  access: WorkspaceAccess,
  input: { installationId: string; repositoryId?: string; releaseBranches: string[] },
  gateway: GitHubRepositoryGateway
): Promise<SafeLinkedRepository> {
  validateLinkInput(input);
  await withCurrentOwner(pool, access, async () => undefined);
  const { evidence, protection } = await inspectRepository(gateway, input);

  return withCurrentOwner(pool, access, async (client) => {
    const project = await client.query<{ id: string }>(
      `SELECT id FROM public.project WHERE workspace_id = $1 ORDER BY id LIMIT 2`,
      [access.workspace.id]
    );
    if (project.rows.length !== 1) {
      throw new LinkedRepositoryError('the MVP Workspace must contain exactly one Project');
    }
    const existing = await readConnection(client, access.workspace.id);
    const connectionId = existing?.id ?? randomUUID();
    await client.query(
      `INSERT INTO public.github_repository_connection (
         id, workspace_id, project_id, owner_membership_id, app_id,
         installation_id, repository_id, repository_node_id, owner_node_id,
         repository_owner, repository_name, default_branch, release_branches,
         status, ready_for_autonomous_work, verification
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         'linked', $14, $15
       )
       ON CONFLICT (workspace_id) DO UPDATE
       SET project_id = EXCLUDED.project_id,
           owner_membership_id = EXCLUDED.owner_membership_id,
           app_id = EXCLUDED.app_id,
           installation_id = EXCLUDED.installation_id,
           repository_id = EXCLUDED.repository_id,
           repository_node_id = EXCLUDED.repository_node_id,
           owner_node_id = EXCLUDED.owner_node_id,
           repository_owner = EXCLUDED.repository_owner,
           repository_name = EXCLUDED.repository_name,
           default_branch = EXCLUDED.default_branch,
           release_branches = EXCLUDED.release_branches,
           status = 'linked',
           ready_for_autonomous_work = EXCLUDED.ready_for_autonomous_work,
           verification = EXCLUDED.verification,
           checked_at = now(),
           linked_at = now(),
           updated_at = now()`,
      [
        connectionId,
        access.workspace.id,
        project.rows[0]!.id,
        access.membership.id,
        String(evidence.appId),
        input.installationId,
        String(evidence.repository.id),
        evidence.repository.nodeId,
        evidence.repository.ownerNodeId,
        evidence.repository.owner,
        evidence.repository.name,
        evidence.repository.defaultBranch,
        input.releaseBranches,
        protection.readyForAutonomousWork,
        JSON.stringify(protection)
      ]
    );
    await client.query(
      `INSERT INTO public.audit_event (
         workspace_id, actor_user_id, actor_membership_id,
         event_type, subject_type, subject_id, evidence
       ) VALUES ($1, $2, $3, $4, 'github_repository_connection', $5,
         jsonb_build_object(
           'installationId', $6::text,
           'repositoryId', $7::text,
           'readyForAutonomousWork', $8::boolean
         ))`,
      [
        access.workspace.id,
        access.identity.userId,
        access.membership.id,
        existing ? 'github.repository.replaced' : 'github.repository.linked',
        connectionId,
        input.installationId,
        String(evidence.repository.id),
        protection.readyForAutonomousWork
      ]
    );
    return safeConnection(await readConnection(client, access.workspace.id), true);
  });
}

export async function verifyLinkedRepository(
  pool: Pool,
  access: WorkspaceAccess,
  gateway: GitHubRepositoryGateway
): Promise<SafeLinkedRepository> {
  const current = await withCurrentOwner(pool, access, async (client) => {
    const row = await readConnection(client, access.workspace.id);
    if (!row) throw new LinkedRepositoryError('a Linked pilot repository is required');
    return row;
  });
  const input = {
    installationId: current.installation_id,
    repositoryId: current.repository_id,
    releaseBranches: current.release_branches
  };
  let inspected: { evidence: GitHubRepositoryEvidence; protection: RepositoryProtectionResult };
  try {
    inspected = await inspectRepository(gateway, input);
  } catch {
    const protection: RepositoryProtectionResult = {
      readyForAutonomousWork: false,
      failures: ['GitHub repository configuration could not be verified'],
      branches: [...new Set([current.default_branch, ...current.release_branches])].map((name) => ({
        name,
        protected: false,
        failures: ['branch controls could not be verified']
      }))
    };
    return withCurrentOwner(pool, access, async (client) => {
      const updated = await client.query<{ id: string }>(
        `UPDATE public.github_repository_connection
         SET ready_for_autonomous_work = false, verification = $4,
             checked_at = now(), updated_at = now()
         WHERE workspace_id = $1 AND installation_id = $2 AND repository_id = $3
         RETURNING id`,
        [
          access.workspace.id,
          input.installationId,
          input.repositoryId,
          JSON.stringify(protection)
        ]
      );
      if (!updated.rows[0]) {
        throw new LinkedRepositoryError('the Linked pilot repository changed during verification');
      }
      await client.query(
        `INSERT INTO public.audit_event (
           workspace_id, actor_user_id, actor_membership_id,
           event_type, subject_type, subject_id, evidence
         ) VALUES ($1, $2, $3, 'github.repository.verification_failed',
           'github_repository_connection', $4,
           jsonb_build_object('readyForAutonomousWork', false))`,
        [
          access.workspace.id,
          access.identity.userId,
          access.membership.id,
          updated.rows[0].id
        ]
      );
      return safeConnection(await readConnection(client, access.workspace.id), true);
    });
  }
  const { evidence, protection } = inspected;

  return withCurrentOwner(pool, access, async (client) => {
    const updated = await client.query<{ id: string }>(
      `UPDATE public.github_repository_connection
       SET app_id = $4, repository_node_id = $5, owner_node_id = $6,
           repository_owner = $7, repository_name = $8, default_branch = $9,
           status = 'linked', ready_for_autonomous_work = $10,
           verification = $11, checked_at = now(), updated_at = now()
       WHERE workspace_id = $1 AND installation_id = $2 AND repository_id = $3
       RETURNING id`,
      [
        access.workspace.id,
        input.installationId,
        input.repositoryId,
        String(evidence.appId),
        evidence.repository.nodeId,
        evidence.repository.ownerNodeId,
        evidence.repository.owner,
        evidence.repository.name,
        evidence.repository.defaultBranch,
        protection.readyForAutonomousWork,
        JSON.stringify(protection)
      ]
    );
    if (!updated.rows[0]) {
      throw new LinkedRepositoryError('the Linked pilot repository changed during verification');
    }
    await client.query(
      `INSERT INTO public.audit_event (
         workspace_id, actor_user_id, actor_membership_id,
         event_type, subject_type, subject_id, evidence
       ) VALUES ($1, $2, $3, 'github.repository.verified',
         'github_repository_connection', $4,
         jsonb_build_object('readyForAutonomousWork', $5::boolean))`,
      [
        access.workspace.id,
        access.identity.userId,
        access.membership.id,
        updated.rows[0].id,
        protection.readyForAutonomousWork
      ]
    );
    return safeConnection(await readConnection(client, access.workspace.id), true);
  });
}

export async function disableLinkedRepository(
  pool: Pool,
  access: WorkspaceAccess
): Promise<SafeLinkedRepository> {
  return withCurrentOwner(pool, access, async (client) => {
    const disabled = await client.query<{ id: string }>(
      `UPDATE public.github_repository_connection
       SET status = 'disabled', ready_for_autonomous_work = false, updated_at = now()
       WHERE workspace_id = $1 AND status = 'linked'
       RETURNING id`,
      [access.workspace.id]
    );
    if (!disabled.rows[0]) throw new LinkedRepositoryError('a linked GitHub repository is required');
    await client.query(
      `INSERT INTO public.audit_event (
         workspace_id, actor_user_id, actor_membership_id,
         event_type, subject_type, subject_id, evidence
       ) VALUES ($1, $2, $3, 'github.repository.disabled',
         'github_repository_connection', $4, '{}'::jsonb)`,
      [access.workspace.id, access.identity.userId, access.membership.id, disabled.rows[0].id]
    );
    return safeConnection(await readConnection(client, access.workspace.id), true);
  });
}

export async function requireAutonomousLinkedRepository(
  pool: Pool,
  workspaceId: string
): Promise<{
  connectionId: string;
  installationId: string;
  repositoryId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  releaseBranches: string[];
}> {
  const row = await readConnection(pool, workspaceId);
  if (row?.status !== 'linked' || !row.ready_for_autonomous_work) {
    throw new LinkedRepositoryError('a verified Linked pilot repository is required');
  }
  return {
    connectionId: row.id,
    installationId: row.installation_id,
    repositoryId: row.repository_id,
    owner: row.repository_owner,
    name: row.repository_name,
    defaultBranch: row.default_branch,
    releaseBranches: row.release_branches
  };
}
