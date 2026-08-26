import type { Pool } from 'pg';

import {
  decideGitHubBrokerOperation,
  type GitHubBrokerDecision,
  type GitHubBrokerRequest
} from './broker-policy.js';

interface BrokerBoundaryRow {
  workspace_id: string;
  attempt_number: number;
  agent_workspace_member_id: string;
  repository_id: string;
  repository_owner: string;
  repository_name: string;
  default_branch: string;
  release_branches: string[];
  installation_id: string;
  ready_for_autonomous_work: boolean;
  connection_status: string;
}

export interface GitHubBrokerRemote {
  execute(input: {
    installationId: string;
    repositoryId: string;
    repositoryOwner: string;
    repositoryName: string;
    defaultBranch: string;
    assignedBranch: string;
    request: GitHubBrokerRequest;
  }): Promise<{
    commitSha?: string;
    files?: Array<{ path: string; content: string; encoding: 'base64' }>;
    pullRequestNumber?: number;
    pullRequestUrl?: string;
  }>;
}

export class GitHubBrokerDeniedError extends Error {
  constructor(readonly reason: string) {
    super(`GitHub broker denied the operation: ${reason}`);
    this.name = 'GitHubBrokerDeniedError';
  }
}

export async function executeGitHubBrokerOperation(
  pool: Pool,
  remote: GitHubBrokerRemote,
  request: GitHubBrokerRequest
): Promise<{
  decision: GitHubBrokerDecision;
  result: Awaited<ReturnType<GitHubBrokerRemote['execute']>>;
}> {
  const boundary = await loadBoundary(pool, request.agentRunId);
  if (!boundary) throw new GitHubBrokerDeniedError('unknown_agent_run');

  const policyBoundary = {
    repositoryId: boundary.repository_id,
    defaultBranch: boundary.default_branch,
    releaseBranches: boundary.release_branches,
    agentRunId: request.agentRunId
  };
  let decision = decideGitHubBrokerOperation(policyBoundary, request);
  if (request.attemptNumber !== boundary.attempt_number) {
    decision = { ...decision, decision: 'deny', reason: 'alternate_attempt' };
  } else if (request.actorWorkspaceMemberId !== boundary.agent_workspace_member_id) {
    decision = { ...decision, decision: 'deny', reason: 'alternate_actor' };
  } else if (!boundary.ready_for_autonomous_work || boundary.connection_status !== 'active') {
    decision = { ...decision, decision: 'deny', reason: 'repository_not_ready' };
  }

  if (decision.decision === 'deny') {
    await recordDecision(pool, boundary, request, decision, undefined, 'denied');
    throw new GitHubBrokerDeniedError(decision.reason);
  }

  try {
    const result = await remote.execute({
      installationId: boundary.installation_id,
      repositoryId: boundary.repository_id,
      repositoryOwner: boundary.repository_owner,
      repositoryName: boundary.repository_name,
      defaultBranch: boundary.default_branch,
      assignedBranch: decision.assignedBranch,
      request
    });
    await recordDecision(pool, boundary, request, decision, result, 'completed');
    return { decision, result };
  } catch (error) {
    await recordDecision(pool, boundary, request, decision, undefined, 'remote_failed');
    throw error;
  }
}

async function loadBoundary(pool: Pool, agentRunId: string): Promise<BrokerBoundaryRow | undefined> {
  const result = await pool.query<BrokerBoundaryRow>(
    `SELECT run.workspace_id, run.attempt_number,
            agent_member.id AS agent_workspace_member_id,
            repository.repository_id, repository.repository_owner,
            repository.repository_name, repository.default_branch,
            repository.release_branches, repository.ready_for_autonomous_work,
            connection.installation_id, connection.status AS connection_status
     FROM public.agent_run run
     JOIN public.workspace_member agent_member
       ON agent_member.workspace_id = run.workspace_id
      AND agent_member.agent_id = run.agent_id
     JOIN public.linked_repository repository
       ON repository.id = run.linked_repository_id
      AND repository.workspace_id = run.workspace_id
     JOIN public.github_connection connection
       ON connection.id = repository.github_connection_id
      AND connection.workspace_id = run.workspace_id
     WHERE run.id = $1`,
    [agentRunId]
  );
  return result.rows[0];
}

async function recordDecision(
  pool: Pool,
  boundary: BrokerBoundaryRow,
  request: GitHubBrokerRequest,
  decision: GitHubBrokerDecision,
  result: Awaited<ReturnType<GitHubBrokerRemote['execute']>> | undefined,
  outcome: 'denied' | 'completed' | 'remote_failed'
): Promise<void> {
  await pool.query(
    `INSERT INTO public.github_broker_decision (
       workspace_id, actor_workspace_member_id, agent_run_id, attempt_number,
       repository_id, repository_owner, repository_name, operation, decision,
       reason, branch, commit_sha, pull_request_number, evidence
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      boundary.workspace_id,
      boundary.agent_workspace_member_id,
      request.agentRunId,
      request.attemptNumber,
      boundary.repository_id,
      boundary.repository_owner,
      boundary.repository_name,
      request.operation,
      decision.decision,
      decision.reason,
      request.branch ?? null,
      result?.commitSha ?? request.commitSha ?? null,
      result?.pullRequestNumber ?? request.pullRequestNumber ?? null,
      {
        assignedBranch: decision.assignedBranch,
        requestedActorWorkspaceMemberId: request.actorWorkspaceMemberId,
        requestedRepositoryId: request.repositoryId,
        force: request.force === true,
        outcome,
        ...(result?.pullRequestUrl ? { pullRequestUrl: result.pullRequestUrl } : {})
      }
    ]
  );
}
