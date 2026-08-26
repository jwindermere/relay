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

export interface RepositoryInspectionInput {
  installationId: string;
  repositoryId?: string;
  releaseBranches: string[];
}

export interface GitHubRepositoryGateway {
  inspect(input: RepositoryInspectionInput): Promise<GitHubRepositoryEvidence>;
}

export interface SafeLinkedRepository {
  linkState: 'not_linked' | 'linked';
  githubConnectionState: 'not_connected' | 'active' | 'disabled';
  readyForAutonomousWork: boolean;
  canManage: boolean;
  configuration?: {
    githubConnectionId: string;
    linkedRepositoryId: string;
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
  github_connection_id: string;
  linked_repository_id: string;
  app_id: string;
  installation_id: string;
  repository_id: string;
  repository_owner: string;
  repository_name: string;
  default_branch: string;
  release_branches: string[];
  connection_status: 'active' | 'disabled';
  ready_for_autonomous_work: boolean;
  verification: RepositoryProtectionResult;
  checked_at: Date;
}

async function readConnection(
  client: Pick<Pool, 'query'> | PoolClient,
  workspaceId: string
): Promise<LinkedRepositoryRow | undefined> {
  const result = await client.query<LinkedRepositoryRow>(
    `SELECT
       connection.id AS github_connection_id,
       repository.id AS linked_repository_id,
       connection.app_id,
       connection.installation_id,
       repository.repository_id,
       repository.repository_owner,
       repository.repository_name,
       repository.default_branch,
       repository.release_branches,
       connection.status AS connection_status,
       repository.ready_for_autonomous_work,
       repository.verification,
       repository.checked_at
     FROM public.github_connection connection
     JOIN public.linked_repository repository
       ON repository.github_connection_id = connection.id
       AND repository.workspace_id = connection.workspace_id
     WHERE connection.workspace_id = $1`,
    [workspaceId]
  );
  return result.rows[0];
}

function safeConnection(
  row: LinkedRepositoryRow | undefined,
  canManage: boolean
): SafeLinkedRepository {
  if (!row) {
    return {
      linkState: 'not_linked',
      githubConnectionState: 'not_connected',
      readyForAutonomousWork: false,
      canManage
    };
  }
  return {
    linkState: 'linked',
    githubConnectionState: row.connection_status,
    readyForAutonomousWork:
      row.connection_status === 'active' && row.ready_for_autonomous_work,
    canManage,
    ...(canManage ? {
      configuration: {
        githubConnectionId: row.github_connection_id,
        linkedRepositoryId: row.linked_repository_id,
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

function validateLinkInput(input: RepositoryInspectionInput): void {
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
  input: RepositoryInspectionInput
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
  input: RepositoryInspectionInput,
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
    const existingConnection = await client.query<{ id: string }>(
      'SELECT id FROM public.github_connection WHERE workspace_id = $1',
      [access.workspace.id]
    );
    const existingRepository = await client.query<{ id: string }>(
      'SELECT id FROM public.linked_repository WHERE workspace_id = $1',
      [access.workspace.id]
    );
    const githubConnectionId = existingConnection.rows[0]?.id ?? randomUUID();
    const linkedRepositoryId = existingRepository.rows[0]?.id ?? randomUUID();
    await client.query(
      `INSERT INTO public.github_connection (
         id, workspace_id, owner_membership_id, app_id, installation_id, status
       ) VALUES ($1, $2, $3, $4, $5, 'active')
       ON CONFLICT (workspace_id) DO UPDATE
       SET owner_membership_id = EXCLUDED.owner_membership_id,
           app_id = EXCLUDED.app_id,
           installation_id = EXCLUDED.installation_id,
           status = 'active',
           connected_at = now(),
           updated_at = now()`,
      [
        githubConnectionId,
        access.workspace.id,
        access.membership.id,
        String(evidence.appId),
        input.installationId
      ]
    );
    await client.query(
      `INSERT INTO public.linked_repository (
         id, workspace_id, project_id, github_connection_id, repository_id,
         repository_node_id, owner_node_id, repository_owner, repository_name,
         default_branch, release_branches, ready_for_autonomous_work, verification
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (workspace_id) DO UPDATE
       SET project_id = EXCLUDED.project_id,
           github_connection_id = EXCLUDED.github_connection_id,
           repository_id = EXCLUDED.repository_id,
           repository_node_id = EXCLUDED.repository_node_id,
           owner_node_id = EXCLUDED.owner_node_id,
           repository_owner = EXCLUDED.repository_owner,
           repository_name = EXCLUDED.repository_name,
           default_branch = EXCLUDED.default_branch,
           release_branches = EXCLUDED.release_branches,
           ready_for_autonomous_work = EXCLUDED.ready_for_autonomous_work,
           verification = EXCLUDED.verification,
           checked_at = now(),
           linked_at = now(),
           updated_at = now()`,
      [
        linkedRepositoryId,
        access.workspace.id,
        project.rows[0]!.id,
        githubConnectionId,
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
       ) VALUES ($1, $2, $3, $4, 'linked_repository', $5,
         jsonb_build_object(
           'installationId', $6::text,
           'repositoryId', $7::text,
           'readyForAutonomousWork', $8::boolean
         ))`,
      [
        access.workspace.id,
        access.identity.userId,
        access.membership.id,
        existingRepository.rows[0] ? 'github.repository.replaced' : 'github.repository.linked',
        linkedRepositoryId,
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
        `UPDATE public.linked_repository repository
         SET ready_for_autonomous_work = false, verification = $4,
             checked_at = now(), updated_at = now()
         FROM public.github_connection connection
         WHERE repository.workspace_id = $1
           AND repository.github_connection_id = connection.id
           AND connection.installation_id = $2
           AND repository.repository_id = $3
         RETURNING repository.id`,
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
           'linked_repository', $4,
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
    const updated = await client.query<{ id: string; ready_for_autonomous_work: boolean }>(
      `UPDATE public.linked_repository repository
       SET repository_node_id = $4, owner_node_id = $5,
           repository_owner = $6, repository_name = $7, default_branch = $8,
           ready_for_autonomous_work = CASE
             WHEN connection.status = 'active' THEN $9::boolean ELSE false
           END,
           verification = $10, checked_at = now(), updated_at = now()
       FROM public.github_connection connection
       WHERE repository.workspace_id = $1
         AND repository.github_connection_id = connection.id
         AND connection.installation_id = $2
         AND repository.repository_id = $3
       RETURNING repository.id, repository.ready_for_autonomous_work`,
      [
        access.workspace.id,
        input.installationId,
        input.repositoryId,
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
         'linked_repository', $4,
         jsonb_build_object('readyForAutonomousWork', $5::boolean))`,
      [
        access.workspace.id,
        access.identity.userId,
        access.membership.id,
        updated.rows[0].id,
        updated.rows[0].ready_for_autonomous_work
      ]
    );
    return safeConnection(await readConnection(client, access.workspace.id), true);
  });
}

export async function disableGitHubConnection(
  pool: Pool,
  access: WorkspaceAccess
): Promise<SafeLinkedRepository> {
  return withCurrentOwner(pool, access, async (client) => {
    const disabled = await client.query<{ id: string }>(
      `UPDATE public.github_connection
       SET status = 'disabled', updated_at = now()
       WHERE workspace_id = $1 AND status = 'active'
       RETURNING id`,
      [access.workspace.id]
    );
    if (!disabled.rows[0]) throw new LinkedRepositoryError('a linked GitHub repository is required');
    await client.query(
      `INSERT INTO public.audit_event (
         workspace_id, actor_user_id, actor_membership_id,
         event_type, subject_type, subject_id, evidence
       ) VALUES ($1, $2, $3, 'github.connection.disabled',
         'github_connection', $4, '{}'::jsonb)`,
      [access.workspace.id, access.identity.userId, access.membership.id, disabled.rows[0].id]
    );
    return safeConnection(await readConnection(client, access.workspace.id), true);
  });
}

export async function requireAutonomousLinkedRepository(
  pool: Pool,
  workspaceId: string,
  gateway: GitHubRepositoryGateway
): Promise<{
  githubConnectionId: string;
  linkedRepositoryId: string;
  installationId: string;
  repositoryId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  releaseBranches: string[];
}> {
  const row = await readConnection(pool, workspaceId);
  if (row?.connection_status !== 'active' || !row.ready_for_autonomous_work) {
    throw new LinkedRepositoryError('a verified Linked pilot repository is required');
  }
  const input = {
    installationId: row.installation_id,
    repositoryId: row.repository_id,
    releaseBranches: row.release_branches
  };
  let evidence: GitHubRepositoryEvidence | undefined;
  let protection: RepositoryProtectionResult;
  try {
    const inspected = await inspectRepository(gateway, input);
    evidence = inspected.evidence;
    protection = inspected.protection;
  } catch {
    protection = {
      readyForAutonomousWork: false,
      failures: ['GitHub repository configuration could not be verified'],
      branches: [...new Set([row.default_branch, ...row.release_branches])].map((name) => ({
        name,
        protected: false,
        failures: ['branch controls could not be verified']
      }))
    };
  }

  const verified = await pool.query<{ ready: boolean }>(
    `WITH refreshed AS (
       UPDATE public.linked_repository repository
       SET repository_node_id = COALESCE($5, repository.repository_node_id),
           owner_node_id = COALESCE($6, repository.owner_node_id),
           repository_owner = COALESCE($7, repository.repository_owner),
           repository_name = COALESCE($8, repository.repository_name),
           default_branch = COALESCE($9, repository.default_branch),
           ready_for_autonomous_work = connection.status = 'active' AND $10::boolean,
           verification = $11,
           checked_at = now(),
           updated_at = now()
       FROM public.github_connection connection
       WHERE repository.id = $1
         AND repository.workspace_id = $2
         AND repository.github_connection_id = connection.id
         AND connection.installation_id = $3
         AND repository.repository_id = $4
       RETURNING repository.id, repository.ready_for_autonomous_work
     ), audited AS (
       INSERT INTO public.audit_event (
         workspace_id, event_type, subject_type, subject_id, evidence
       )
       SELECT $2, 'github.repository.execution_verified', 'linked_repository', id,
         jsonb_build_object('readyForAutonomousWork', ready_for_autonomous_work)
       FROM refreshed
     )
     SELECT ready_for_autonomous_work AS ready FROM refreshed`,
    [
      row.linked_repository_id,
      workspaceId,
      row.installation_id,
      row.repository_id,
      evidence?.repository.nodeId ?? null,
      evidence?.repository.ownerNodeId ?? null,
      evidence?.repository.owner ?? null,
      evidence?.repository.name ?? null,
      evidence?.repository.defaultBranch ?? null,
      protection.readyForAutonomousWork,
      JSON.stringify(protection)
    ]
  );
  if (!verified.rows[0]?.ready) {
    throw new LinkedRepositoryError('a verified Linked pilot repository is required');
  }
  return {
    githubConnectionId: row.github_connection_id,
    linkedRepositoryId: row.linked_repository_id,
    installationId: row.installation_id,
    repositoryId: row.repository_id,
    owner: evidence?.repository.owner ?? row.repository_owner,
    name: evidence?.repository.name ?? row.repository_name,
    defaultBranch: evidence?.repository.defaultBranch ?? row.default_branch,
    releaseBranches: row.release_branches
  };
}
