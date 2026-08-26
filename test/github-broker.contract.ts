import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createGitHubBrokerRemote } from '../src/lib/server/github/api.js';
import { decideGitHubBrokerOperation, type GitHubBrokerRequest } from '../src/lib/server/github/broker-policy.js';

const requiredEnvironment = [
  'RELAY_GITHUB_APP_ID', 'RELAY_GITHUB_PRIVATE_KEY',
  'RELAY_GITHUB_CONTRACT_INSTALLATION_ID', 'RELAY_GITHUB_CONTRACT_REPOSITORY_ID',
  'RELAY_GITHUB_CONTRACT_REPOSITORY_OWNER', 'RELAY_GITHUB_CONTRACT_REPOSITORY_NAME',
  'RELAY_GITHUB_CONTRACT_DEFAULT_BRANCH'
] as const;
const missingEnvironment = requiredEnvironment.filter((name) => !process.env[name]);

test('disposable protected repository enforces the complete broker contract', {
  skip: missingEnvironment.length ? `missing contract environment: ${missingEnvironment.join(', ')}` : false,
  timeout: 120_000
}, async () => {
  const runId = `contract-${Date.now()}`;
  const repositoryId = process.env.RELAY_GITHUB_CONTRACT_REPOSITORY_ID!;
  const boundary = {
    repositoryId,
    defaultBranch: process.env.RELAY_GITHUB_CONTRACT_DEFAULT_BRANCH!,
    releaseBranches: (process.env.RELAY_GITHUB_CONTRACT_RELEASE_BRANCHES ?? '').split(',').filter(Boolean),
    agentRunId: runId
  };
  const remote = createGitHubBrokerRemote({
    appId: process.env.RELAY_GITHUB_APP_ID!,
    privateKey: process.env.RELAY_GITHUB_PRIVATE_KEY!.replace(/\\n/g, '\n')
  });
  const remoteBoundary = {
    installationId: process.env.RELAY_GITHUB_CONTRACT_INSTALLATION_ID!, repositoryId,
    repositoryOwner: process.env.RELAY_GITHUB_CONTRACT_REPOSITORY_OWNER!,
    repositoryName: process.env.RELAY_GITHUB_CONTRACT_REPOSITORY_NAME!,
    defaultBranch: boundary.defaultBranch, assignedBranch: `relay/${runId}`
  };
  const common = {
    repositoryId, agentRunId: runId, attemptNumber: 1,
    actorWorkspaceMemberId: `agent-${runId}`
  };
  const executeAllowed = async (request: GitHubBrokerRequest) => {
    assert.equal(decideGitHubBrokerOperation(boundary, request).decision, 'allow');
    return remote.execute({ ...remoteBoundary, request });
  };

  const clone = await executeAllowed({ ...common, operation: 'clone' });
  assert.ok(clone.commitSha);
  await executeAllowed({ ...common, operation: 'read' });
  await executeAllowed({ ...common, operation: 'fetch' });
  await executeAllowed({
    ...common, operation: 'create_branch', branch: remoteBoundary.assignedBranch,
    commitSha: clone.commitSha
  });
  const commit = await executeAllowed({
    ...common, operation: 'commit', branch: remoteBoundary.assignedBranch,
    commitSha: clone.commitSha, commitMessage: `Relay broker contract ${runId}`,
    files: [{ path: `.relay-contract/${runId}.txt`, content: `broker contract ${runId}\n` }]
  });
  assert.ok(commit.commitSha);
  await executeAllowed({
    ...common, operation: 'update_branch', branch: remoteBoundary.assignedBranch,
    commitSha: commit.commitSha
  });
  const pullRequest = await executeAllowed({
    ...common, operation: 'pull_request_upsert', branch: remoteBoundary.assignedBranch,
    pullRequestTitle: `Relay broker contract ${runId}`,
    pullRequestBody: 'Disposable protected-repository contract evidence.'
  });
  assert.ok(pullRequest.pullRequestNumber);
  assert.ok(pullRequest.pullRequestUrl);

  const forbidden: GitHubBrokerRequest[] = [
    { ...common, operation: 'update_branch', branch: boundary.defaultBranch, commitSha: commit.commitSha },
    { ...common, operation: 'update_branch', branch: remoteBoundary.assignedBranch, commitSha: commit.commitSha, force: true },
    { ...common, operation: 'delete_reference', branch: remoteBoundary.assignedBranch },
    { ...common, operation: 'merge', pullRequestNumber: pullRequest.pullRequestNumber },
    { ...common, operation: 'administration' }, { ...common, operation: 'collaborators' },
    { ...common, operation: 'release' }, { ...common, operation: 'deployment' },
    { ...common, operation: 'workflow' }, { ...common, operation: 'secret' },
    { ...common, operation: 'read', repositoryId: `${repositoryId}-alternate` }
  ];
  for (const request of forbidden) {
    assert.equal(decideGitHubBrokerOperation(boundary, request).decision, 'deny');
  }
});
