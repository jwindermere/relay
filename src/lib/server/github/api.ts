import { createSign } from 'node:crypto';

import type { GitHubRepositoryGateway } from './connection.js';
import type {
  GitHubAppPermissions,
  GitHubRepositoryEvidence
} from './protection.js';

const GITHUB_API_VERSION = '2026-03-10';
const MINIMUM_REPOSITORY_PERMISSIONS = {
  metadata: 'read',
  contents: 'write',
  pull_requests: 'write'
} as const;

interface GitHubGatewayConfiguration {
  appId: string;
  privateKey: string;
  fetch?: typeof fetch;
  apiBaseUrl?: string;
}

function encodeJwtPart(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encodeJwtPart({ alg: 'RS256', typ: 'JWT' })}.${encodeJwtPart({
    iat: now - 60,
    exp: now + 540,
    iss: appId
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url');
  return `${unsigned}.${signature}`;
}

function normalizePermissions(permissions: Record<string, string>): GitHubAppPermissions {
  return Object.fromEntries(
    Object.entries(permissions).map(([name, level]) => [
      name === 'pull_requests' ? 'pullRequests' : name,
      level
    ])
  );
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`GitHub response omitted ${field}`);
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`GitHub response omitted ${field}`);
  }
  return value;
}

export function createGitHubRepositoryGateway(
  configuration: GitHubGatewayConfiguration
): GitHubRepositoryGateway {
  const requestFetch = configuration.fetch ?? fetch;
  const apiBaseUrl = configuration.apiBaseUrl ?? 'https://api.github.com';
  const appJwt = () => createAppJwt(configuration.appId, configuration.privateKey);

  async function request<T>(
    path: string,
    token: string,
    options: { method?: string; body?: unknown } = {}
  ): Promise<T> {
    const response = await requestFetch(`${apiBaseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'relay-linked-pilot-repository',
        'x-github-api-version': GITHUB_API_VERSION
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    });
    if (!response.ok) throw new Error(`GitHub API request failed with status ${response.status}`);
    return await response.json() as T;
  }

  async function createInstallationToken(
    installationId: string,
    body: object
  ): Promise<string> {
    const response = await request<{ token?: unknown }>(
      `/app/installations/${installationId}/access_tokens`,
      appJwt(),
      { method: 'POST', body }
    );
    return requiredString(response.token, 'installation token');
  }

  return {
    async inspect(input): Promise<GitHubRepositoryEvidence> {
      const installation = await request<{
        id?: unknown;
        app_id?: unknown;
        repository_selection?: unknown;
        permissions?: unknown;
      }>(`/app/installations/${input.installationId}`, appJwt());
      const installationId = requiredNumber(installation.id, 'installation ID');
      const installedAppId = requiredNumber(installation.app_id, 'App ID');
      if (String(installedAppId) !== configuration.appId) {
        throw new Error('GitHub installation belongs to a different App');
      }
      if (!installation.permissions || typeof installation.permissions !== 'object') {
        throw new Error('GitHub response omitted installation permissions');
      }

      const inspectionToken = await createInstallationToken(input.installationId, {
        permissions: { metadata: 'read' }
      });
      const installedRepositories = await request<{
        total_count?: unknown;
        repositories?: unknown;
      }>('/installation/repositories?per_page=100', inspectionToken);
      const repositoryList = Array.isArray(installedRepositories.repositories)
        ? installedRepositories.repositories
        : [];
      const repositoryIds = repositoryList.map((repository) =>
        requiredNumber((repository as { id?: unknown }).id, 'repository ID')
      );
      const totalCount = requiredNumber(installedRepositories.total_count, 'repository count');
      if (totalCount !== repositoryIds.length && totalCount <= 100) {
        throw new Error('GitHub returned an incomplete installation repository list');
      }

      if (totalCount !== 1 || repositoryIds.length !== 1) {
        throw new Error('GitHub App installation must contain exactly one selected repository');
      }
      const discoveredRepositoryId = String(repositoryIds[0]);
      if (input.repositoryId !== undefined && input.repositoryId !== discoveredRepositoryId) {
        throw new Error('stored repository is no longer the installation selected repository');
      }
      const numericRepositoryId = repositoryIds[0]!;
      const repositoryToken = await createInstallationToken(input.installationId, {
        repository_ids: [numericRepositoryId],
        permissions: MINIMUM_REPOSITORY_PERMISSIONS
      });
      const repository = await request<{
        id?: unknown;
        node_id?: unknown;
        name?: unknown;
        owner?: { login?: unknown; node_id?: unknown };
        default_branch?: unknown;
      }>(`/repositories/${discoveredRepositoryId}`, repositoryToken);
      const resolvedRepositoryId = requiredNumber(repository.id, 'repository ID');
      const owner = requiredString(repository.owner?.login, 'repository owner login');
      const name = requiredString(repository.name, 'repository name');
      const defaultBranch = requiredString(repository.default_branch, 'default branch');
      const branchNames = [...new Set([defaultBranch, ...input.releaseBranches])];

      await Promise.all(branchNames.map((branchName) => request(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches/${encodeURIComponent(branchName)}`,
        repositoryToken
      )));
      const branches = await Promise.all(branchNames.map(async (branchName) => {
        const rules = await request<Array<{
          ruleset_id?: unknown;
          type?: unknown;
          parameters?: {
            required_approving_review_count?: unknown;
            dismiss_stale_reviews_on_push?: unknown;
            require_last_push_approval?: unknown;
            required_status_checks?: Array<{ context?: unknown }>;
          };
        }>>(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/rules/branches/${encodeURIComponent(branchName)}?per_page=100`,
          repositoryToken
        );
        const normalizedRules = rules.map((rule) => ({
          rulesetId: requiredNumber(rule.ruleset_id, 'ruleset ID'),
          type: requiredString(rule.type, 'rule type'),
          ...(rule.parameters ? {
            parameters: {
              requiredApprovingReviewCount:
                typeof rule.parameters.required_approving_review_count === 'number'
                  ? rule.parameters.required_approving_review_count
                  : undefined,
              dismissStaleReviewsOnPush:
                typeof rule.parameters.dismiss_stale_reviews_on_push === 'boolean'
                  ? rule.parameters.dismiss_stale_reviews_on_push
                  : undefined,
              requireLastPushApproval:
                typeof rule.parameters.require_last_push_approval === 'boolean'
                  ? rule.parameters.require_last_push_approval
                  : undefined,
              requiredStatusChecks: Array.isArray(rule.parameters.required_status_checks)
                ? rule.parameters.required_status_checks.map((check) =>
                  requiredString(check.context, 'required status check context')
                )
                : undefined
            }
          } : {})
        }));
        const rulesetIds = [...new Set(normalizedRules.map(({ rulesetId }) => rulesetId))];
        const rulesets = await Promise.all(rulesetIds.map(async (rulesetId) => {
          const ruleset = await request<{
            id?: unknown;
            bypass_actors?: Array<{ actor_type?: unknown; actor_id?: unknown }>;
          }>(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/rulesets/${rulesetId}?includes_parents=true`,
            repositoryToken
          );
          return {
            id: requiredNumber(ruleset.id, 'ruleset ID'),
            bypassActorAppIds: Array.isArray(ruleset.bypass_actors)
              ? ruleset.bypass_actors
                .filter(({ actor_type: actorType }) => actorType === 'Integration')
                .map(({ actor_id: actorId }) => requiredNumber(actorId, 'ruleset bypass App ID'))
              : undefined
          };
        }));
        return { name: branchName, rules: normalizedRules, rulesets };
      }));

      return {
        appId: installedAppId,
        installation: {
          id: installationId,
          repositorySelection: requiredString(
            installation.repository_selection,
            'repository selection'
          ),
          permissions: normalizePermissions(installation.permissions as Record<string, string>),
          repositoryIds
        },
        repository: {
          id: resolvedRepositoryId,
          nodeId: requiredString(repository.node_id, 'repository node ID'),
          ownerNodeId: requiredString(repository.owner?.node_id, 'repository owner node ID'),
          owner,
          name,
          defaultBranch,
          branches: branchNames
        },
        branches
      };
    }
  };
}

let githubRepositoryGateway: GitHubRepositoryGateway | undefined;

export function getGitHubRepositoryGateway(): GitHubRepositoryGateway {
  if (githubRepositoryGateway) return githubRepositoryGateway;
  const appId = process.env.RELAY_GITHUB_APP_ID;
  const privateKey = process.env.RELAY_GITHUB_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!appId || !/^\d+$/.test(appId) || !privateKey) {
    throw new Error('RELAY_GITHUB_APP_ID and RELAY_GITHUB_PRIVATE_KEY must configure the GitHub App');
  }
  githubRepositoryGateway = createGitHubRepositoryGateway({ appId, privateKey });
  return githubRepositoryGateway;
}
