export type GitHubBrokerOperation =
  | 'clone'
  | 'read'
  | 'fetch'
  | 'create_branch'
  | 'commit'
  | 'update_branch'
  | 'pull_request_upsert'
  | 'delete_reference'
  | 'merge'
  | 'administration'
  | 'collaborators'
  | 'release'
  | 'deployment'
  | 'workflow'
  | 'secret';

export interface GitHubBrokerRequest {
  operation: GitHubBrokerOperation;
  repositoryId: string;
  agentRunId: string;
  attemptNumber: number;
  actorWorkspaceMemberId: string;
  branch?: string;
  commitSha?: string;
  commitMessage?: string;
  files?: Array<{ path: string; content: string | null; encoding?: 'utf-8' | 'base64' }>;
  pullRequestNumber?: number;
  pullRequestTitle?: string;
  pullRequestBody?: string;
  force?: boolean;
}

export interface GitHubBrokerBoundary {
  repositoryId: string;
  defaultBranch: string;
  releaseBranches: string[];
  agentRunId: string;
}

export interface GitHubBrokerDecision {
  decision: 'allow' | 'deny';
  reason: GitHubBrokerDecisionReason;
  assignedBranch: string;
}

export type GitHubBrokerDecisionReason =
  | 'operation_allowed'
  | 'alternate_repository'
  | 'alternate_agent_run'
  | 'force_update'
  | 'forbidden_operation'
  | 'protected_branch'
  | 'alternate_branch'
  | 'invalid_commit'
  | 'invalid_commit_content'
  | 'alternate_attempt'
  | 'alternate_actor'
  | 'repository_not_ready'
  | 'unknown_agent_run';

const READ_OPERATIONS = new Set<GitHubBrokerOperation>(['clone', 'read', 'fetch']);
const WRITE_OPERATIONS = new Set<GitHubBrokerOperation>([
  'create_branch', 'commit', 'update_branch', 'pull_request_upsert'
]);

export function decideGitHubBrokerOperation(
  boundary: GitHubBrokerBoundary,
  request: GitHubBrokerRequest
): GitHubBrokerDecision {
  const assignedBranch = `relay/${boundary.agentRunId}`;
  const deny = (reason: GitHubBrokerDecisionReason): GitHubBrokerDecision => ({
    decision: 'deny', reason, assignedBranch
  });

  if (request.repositoryId !== boundary.repositoryId) return deny('alternate_repository');
  if (request.agentRunId !== boundary.agentRunId) return deny('alternate_agent_run');
  if (request.force) return deny('force_update');
  if (READ_OPERATIONS.has(request.operation)) {
    return { decision: 'allow', reason: 'operation_allowed', assignedBranch };
  }
  if (!WRITE_OPERATIONS.has(request.operation)) return deny('forbidden_operation');
  if (request.branch !== assignedBranch) {
    if ([boundary.defaultBranch, ...boundary.releaseBranches].includes(request.branch ?? '')) {
      return deny('protected_branch');
    }
    return deny('alternate_branch');
  }
  if (request.operation !== 'pull_request_upsert'
    && (!request.commitSha || !/^[a-f0-9]{40,64}$/i.test(request.commitSha))) {
    return deny('invalid_commit');
  }
  if (request.operation === 'commit' && (
    !request.commitMessage?.trim()
    || !request.files?.length
    || request.files.reduce(
      (size, { content }) => size + (content === null ? 0 : Buffer.byteLength(content)), 0
    ) > 5_000_000
    || request.files.some(({ path }) =>
      !isSafeRepositoryPath(path) || path.toLowerCase().startsWith('.github/workflows/')
    )
  )) return deny('invalid_commit_content');
  return { decision: 'allow', reason: 'operation_allowed', assignedBranch };
}

function isSafeRepositoryPath(path: string): boolean {
  return path.length > 0
    && path.length <= 500
    && !path.startsWith('/')
    && !path.split('/').some((part) => part === '' || part === '.' || part === '..');
}
