import { createSign } from 'node:crypto';

import type { GitHubRepositoryGateway } from './connection.js';
import type { GitHubBrokerRemote } from './broker.js';
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
let githubBrokerRemote: GitHubBrokerRemote | undefined;

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

export function createGitHubBrokerRemote(
  configuration: GitHubGatewayConfiguration
): GitHubBrokerRemote {
  const requestFetch = configuration.fetch ?? fetch;
  const apiBaseUrl = configuration.apiBaseUrl ?? 'https://api.github.com';
  const cachedTokens = new Map<string, { token: string; expiresAt: number }>();

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
        'user-agent': 'relay-agent-run-github-broker',
        'x-github-api-version': GITHUB_API_VERSION
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    });
    if (!response.ok) throw new Error(`GitHub broker request failed with status ${response.status}`);
    return await response.json() as T;
  }

  async function installationToken(installationId: string, repositoryId: string) {
    const cacheKey = `${installationId}:${repositoryId}`;
    const cached = cachedTokens.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const response = await request<{ token?: unknown; expires_at?: unknown }>(
      `/app/installations/${installationId}/access_tokens`,
      createAppJwt(configuration.appId, configuration.privateKey),
      {
        method: 'POST',
        body: {
          repository_ids: [Number(repositoryId)],
          permissions: MINIMUM_REPOSITORY_PERMISSIONS
        }
      }
    );
    const token = requiredString(response.token, 'installation token');
    const expiresAt = typeof response.expires_at === 'string'
      ? Date.parse(response.expires_at)
      : Date.now() + 50 * 60_000;
    cachedTokens.set(cacheKey, { token, expiresAt });
    return token;
  }

  return {
    async execute(input) {
      const token = await installationToken(input.installationId, input.repositoryId);
      const owner = encodeURIComponent(input.repositoryOwner);
      const repository = encodeURIComponent(input.repositoryName);
      const request = input.request;
      const refPath = (branch: string) => encodeURIComponent(`heads/${branch}`);

      if (request.operation === 'clone'
        || request.operation === 'read'
        || request.operation === 'fetch') {
        const ref = await requestJson<{ object?: { sha?: unknown } }>(
          `/repos/${owner}/${repository}/git/ref/${refPath(input.defaultBranch)}`,
          token
        );
        const commitSha = requiredString(ref.object?.sha, 'branch commit SHA');
        if (request.operation !== 'clone') return { commitSha };
        const tree = await requestJson<{
          truncated?: unknown;
          tree?: Array<{ path?: unknown; type?: unknown; sha?: unknown; size?: unknown }>;
        }>(`/repos/${owner}/${repository}/git/trees/${commitSha}?recursive=1`, token);
        if (tree.truncated === true || !Array.isArray(tree.tree)) {
          throw new Error('GitHub clone tree is too large or incomplete');
        }
        const blobs = tree.tree.filter((entry) => entry.type === 'blob').map((entry) => ({
          path: requiredString(entry.path, 'blob path'),
          sha: requiredString(entry.sha, 'blob SHA'),
          size: requiredNumber(entry.size, 'blob size')
        }));
        if (blobs.some(({ size }) => size > 5_000_000)
          || blobs.reduce((total, { size }) => total + size, 0) > 25_000_000) {
          throw new Error('GitHub clone exceeds the AgentRun workspace size limit');
        }
        const files = await Promise.all(blobs.map(async (blob) => {
          const response = await requestJson<{ content?: unknown; encoding?: unknown }>(
            `/repos/${owner}/${repository}/git/blobs/${encodeURIComponent(blob.sha)}`,
            token
          );
          if (response.encoding !== 'base64') throw new Error('GitHub blob encoding is unsupported');
          return {
            path: blob.path,
            content: requiredString(response.content, 'blob content').replace(/\s/g, ''),
            encoding: 'base64' as const
          };
        }));
        return { commitSha, files };
      }
      if (request.operation === 'create_branch') {
        try {
          const existing = await requestJson<{ object?: { sha?: unknown } }>(
            `/repos/${owner}/${repository}/git/ref/${refPath(input.assignedBranch)}`,
            token
          );
          const existingSha = requiredString(existing.object?.sha, 'branch commit SHA');
          if (existingSha !== request.commitSha) {
            throw new Error('existing AgentRun branch has an unexpected commit');
          }
          return { commitSha: existingSha };
        } catch (error) {
          if (!(error instanceof Error) || !/status 404$/.test(error.message)) throw error;
        }
        const ref = await requestJson<{ object?: { sha?: unknown } }>(
          `/repos/${owner}/${repository}/git/refs`,
          token,
          { method: 'POST', body: { ref: `refs/heads/${input.assignedBranch}`, sha: request.commitSha } }
        );
        return { commitSha: requiredString(ref.object?.sha, 'branch commit SHA') };
      }
      if (request.operation === 'commit') {
        const parent = await requestJson<{ tree?: { sha?: unknown } }>(
          `/repos/${owner}/${repository}/git/commits/${encodeURIComponent(request.commitSha ?? '')}`,
          token
        );
        const blobs = await Promise.all((request.files ?? []).map(async (file) => {
          if (file.content === null) {
            return { path: file.path, mode: '100644', type: 'blob', sha: null };
          }
          const blob = await requestJson<{ sha?: unknown }>(
            `/repos/${owner}/${repository}/git/blobs`,
            token,
            {
              method: 'POST',
              body: { content: file.content, encoding: file.encoding ?? 'utf-8' }
            }
          );
          return { path: file.path, mode: '100644', type: 'blob', sha: requiredString(blob.sha, 'blob SHA') };
        }));
        const tree = await requestJson<{ sha?: unknown }>(
          `/repos/${owner}/${repository}/git/trees`,
          token,
          {
            method: 'POST',
            body: { base_tree: requiredString(parent.tree?.sha, 'parent tree SHA'), tree: blobs }
          }
        );
        const commit = await requestJson<{ sha?: unknown }>(
          `/repos/${owner}/${repository}/git/commits`,
          token,
          {
            method: 'POST',
            body: {
              message: request.commitMessage,
              tree: requiredString(tree.sha, 'tree SHA'),
              parents: [request.commitSha]
            }
          }
        );
        return { commitSha: requiredString(commit.sha, 'commit SHA') };
      }
      if (request.operation === 'update_branch') {
        const ref = await requestJson<{ object?: { sha?: unknown } }>(
          `/repos/${owner}/${repository}/git/refs/${refPath(input.assignedBranch)}`,
          token,
          { method: 'PATCH', body: { sha: request.commitSha, force: false } }
        );
        return { commitSha: requiredString(ref.object?.sha, 'branch commit SHA') };
      }
      if (request.operation === 'pull_request_upsert') {
        let pullRequestNumber = request.pullRequestNumber;
        if (!pullRequestNumber) {
          const existing = await requestJson<Array<{ number?: unknown }>>(
            `/repos/${owner}/${repository}/pulls?state=open&head=${encodeURIComponent(
              `${input.repositoryOwner}:${input.assignedBranch}`
            )}`,
            token
          );
          if (existing.length > 1) throw new Error('GitHub returned multiple AgentRun pull requests');
          if (existing[0]) pullRequestNumber = requiredNumber(existing[0].number, 'pull request number');
        }
        const path = pullRequestNumber
          ? `/repos/${owner}/${repository}/pulls/${pullRequestNumber}`
          : `/repos/${owner}/${repository}/pulls`;
        const pullRequest = await requestJson<{
          number?: unknown;
          html_url?: unknown;
          head?: { sha?: unknown };
        }>(path, token, {
          method: pullRequestNumber ? 'PATCH' : 'POST',
          body: {
            title: request.pullRequestTitle ?? `Relay AgentRun ${request.agentRunId}`,
            body: request.pullRequestBody ?? 'Created by the Relay engineering Agent.',
            ...(!pullRequestNumber
              ? { head: input.assignedBranch, base: input.defaultBranch }
              : {})
          }
        });
        return {
          commitSha: typeof pullRequest.head?.sha === 'string' ? pullRequest.head.sha : undefined,
          pullRequestNumber: requiredNumber(pullRequest.number, 'pull request number'),
          pullRequestUrl: requiredString(pullRequest.html_url, 'pull request URL')
        };
      }
      throw new Error('GitHub broker remote received a forbidden operation');
    }
  };

  function requestJson<T>(
    path: string,
    token: string,
    options: { method?: string; body?: unknown } = {}
  ): Promise<T> {
    return request<T>(path, token, options);
  }
}

export function getGitHubBrokerRemote(): GitHubBrokerRemote {
  if (githubBrokerRemote) return githubBrokerRemote;
  const appId = process.env.RELAY_GITHUB_APP_ID;
  const privateKey = process.env.RELAY_GITHUB_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!appId || !/^\d+$/.test(appId) || !privateKey) {
    throw new Error('RELAY_GITHUB_APP_ID and RELAY_GITHUB_PRIVATE_KEY must configure the GitHub App');
  }
  githubBrokerRemote = createGitHubBrokerRemote({ appId, privateKey });
  return githubBrokerRemote;
}
