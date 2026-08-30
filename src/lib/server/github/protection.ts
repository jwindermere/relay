export interface GitHubAppPermissions {
  metadata?: string;
  contents?: string;
  pullRequests?: string;
  [permission: string]: string | undefined;
}

export interface GitHubRepositoryEvidence {
  appId: number;
  installation: {
    id: number;
    repositorySelection: string;
    permissions: GitHubAppPermissions;
    repositoryIds: number[];
  };
  repository: {
    id: number;
    nodeId: string;
    ownerNodeId: string;
    owner: string;
    name: string;
    defaultBranch: string;
    branches: string[];
  };
  branches: Array<{
    name: string;
    rules: Array<{
      rulesetId: number;
      type: string;
      parameters?: {
        requiredApprovingReviewCount?: number;
        dismissStaleReviewsOnPush?: boolean;
        requireLastPushApproval?: boolean;
        requiredStatusChecks?: string[];
      };
    }>;
    rulesets: Array<{
      id: number;
      updatedAt?: string;
      bypassActorAppIds?: number[];
    }>;
  }>;
}

export interface RulesetBypassAttestation {
  rulesetId: number;
  rulesetUpdatedAt: string;
}

export interface RepositoryProtectionResult {
  readyForAutonomousWork: boolean;
  failures: string[];
  branches: Array<{ name: string; protected: boolean; failures: string[] }>;
  bypassAttestations?: RulesetBypassAttestation[];
}

const REQUIRED_PERMISSIONS: Record<string, string> = {
  contents: 'write',
  metadata: 'read',
  pullRequests: 'write'
};

function hasExactRequiredPermissions(permissions: GitHubAppPermissions): boolean {
  const entries = Object.entries(permissions)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  const required = Object.entries(REQUIRED_PERMISSIONS)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(entries) === JSON.stringify(required);
}

function evaluateBranch(
  evidence: GitHubRepositoryEvidence,
  branchName: string,
  bypassAttestations: RulesetBypassAttestation[]
): { name: string; protected: boolean; failures: string[] } {
  const branch = evidence.branches.find(({ name }) => name === branchName);
  if (!branch) {
    return {
      name: branchName,
      protected: false,
      failures: [`configured branch ${branchName} does not exist in the linked repository`]
    };
  }

  const failures: string[] = [];
  const pullRequestRules = branch.rules.filter(({ type }) => type === 'pull_request');
  if (!pullRequestRules.some(({ parameters }) =>
    (parameters?.requiredApprovingReviewCount ?? 0) >= 1
  )) failures.push('required pull-request review is absent');
  if (!pullRequestRules.some(({ parameters }) => parameters?.dismissStaleReviewsOnPush === true)) {
    failures.push('stale-approval dismissal is absent');
  }
  if (!branch.rules.some(({ type, parameters }) =>
    type === 'required_status_checks' && (parameters?.requiredStatusChecks?.length ?? 0) > 0
  )) failures.push('required status checks are absent');
  if (!branch.rules.some(({ type }) => type === 'non_fast_forward')) {
    failures.push('force pushes are not blocked');
  }
  if (!branch.rules.some(({ type }) => type === 'deletion')) {
    failures.push('branch deletion is not blocked');
  }
  if (branch.rulesets.some(({ id, updatedAt, bypassActorAppIds }) =>
    bypassActorAppIds === undefined && !bypassAttestations.some((attestation) =>
      attestation.rulesetId === id && attestation.rulesetUpdatedAt === updatedAt
    )
  )) {
    failures.push('ruleset bypass actors could not be verified');
  } else if (branch.rulesets.some(({ bypassActorAppIds }) =>
    bypassActorAppIds?.includes(evidence.appId)
  )) {
    failures.push('Relay GitHub App can bypass a protecting ruleset');
  }

  return { name: branchName, protected: failures.length === 0, failures };
}

export function createRulesetBypassAttestations(
  evidence: GitHubRepositoryEvidence
): RulesetBypassAttestation[] {
  const attestations = new Map<string, RulesetBypassAttestation>();
  for (const { rulesets } of evidence.branches) {
    for (const ruleset of rulesets) {
      if (!ruleset.updatedAt || ruleset.bypassActorAppIds !== undefined) continue;
      const attestation = {
        rulesetId: ruleset.id,
        rulesetUpdatedAt: ruleset.updatedAt
      };
      attestations.set(`${attestation.rulesetId}:${attestation.rulesetUpdatedAt}`, attestation);
    }
  }
  return [...attestations.values()].sort((left, right) =>
    left.rulesetId - right.rulesetId
      || left.rulesetUpdatedAt.localeCompare(right.rulesetUpdatedAt)
  );
}

export function evaluateRepositoryProtection(
  evidence: GitHubRepositoryEvidence,
  releaseBranches: string[],
  bypassAttestations: RulesetBypassAttestation[] = []
): RepositoryProtectionResult {
  const failures: string[] = [];
  if (new Set(releaseBranches).size !== releaseBranches.length) {
    failures.push('release branches must be unique');
  }
  for (const branchName of new Set(releaseBranches)) {
    if (!evidence.repository.branches.includes(branchName)) {
      failures.push(`configured branch ${branchName} does not exist in the linked repository`);
    }
  }
  if (evidence.installation.repositorySelection !== 'selected') {
    failures.push('GitHub App installation must be limited to selected repositories');
  }
  if (
    evidence.installation.repositorySelection !== 'selected'
    || evidence.installation.repositoryIds.length !== 1
    || evidence.installation.repositoryIds[0] !== evidence.repository.id
  ) {
    failures.push('GitHub App installation must contain exactly the linked repository');
  }
  if (!hasExactRequiredPermissions(evidence.installation.permissions)) {
    failures.push(
      'GitHub App permissions must be exactly metadata:read, contents:write, pull_requests:write'
    );
  }

  const configuredBranches = [...new Set([
    evidence.repository.defaultBranch,
    ...releaseBranches
  ])];
  const branches = configuredBranches.map((branchName) =>
    evaluateBranch(evidence, branchName, bypassAttestations)
  );
  return {
    readyForAutonomousWork: failures.length === 0 && branches.every(({ protected: value }) => value),
    failures,
    branches,
    ...(bypassAttestations.length > 0 ? { bypassAttestations } : {})
  };
}
