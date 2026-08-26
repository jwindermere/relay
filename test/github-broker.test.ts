import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  decideGitHubBrokerOperation,
  type GitHubBrokerRequest
} from '../src/lib/server/github/broker-policy.js';
import {
  executeGitHubBrokerBoundary,
  GitHubBrokerDeniedError,
  type GitHubBrokerRemote
} from '../src/lib/server/github/broker.js';
import { collectWorkspaceChanges } from '../src/lib/server/github/workspace.js';

const boundary = {
  repositoryId: '202',
  defaultBranch: 'main',
  releaseBranches: ['release/stable'],
  agentRunId: 'run-25'
};

function request(overrides: Partial<GitHubBrokerRequest> = {}): GitHubBrokerRequest {
  return {
    operation: 'read',
    repositoryId: '202',
    agentRunId: 'run-25',
    attemptNumber: 1,
    actorWorkspaceMemberId: 'agent-member-25',
    ...overrides
  };
}

test('workspace changes include executable mode changes without content changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-workspace-mode-'));
  try {
    const content = Buffer.from('#!/bin/sh\n').toString('base64');
    const path = join(directory, 'script.sh');
    await writeFile(path, Buffer.from(content, 'base64'), { mode: 0o600 });
    await chmod(path, 0o700);

    assert.deepEqual(await collectWorkspaceChanges(directory, new Map([
      ['script.sh', { content, mode: '100644' }]
    ])), [{ path: 'script.sh', content, encoding: 'base64', mode: '100755' }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('broker allows only the AgentRun repository and assigned branch workflow', () => {
  const assignedBranch = 'relay/run-25';
  const allowed: GitHubBrokerRequest[] = [
    request({ operation: 'clone' }),
    request({ operation: 'read' }),
    request({ operation: 'fetch' }),
    request({ operation: 'create_branch', branch: assignedBranch, commitSha: 'a'.repeat(40) }),
    request({
      operation: 'commit',
      branch: assignedBranch,
      commitSha: 'b'.repeat(40),
      commitMessage: 'Implement the requested change',
      files: [{ path: 'src/change.ts', content: 'export {};' }]
    }),
    request({ operation: 'update_branch', branch: assignedBranch, commitSha: 'b'.repeat(40) }),
    request({
      operation: 'pull_request_upsert', branch: assignedBranch, pullRequestNumber: 17
    })
  ];

  for (const operation of allowed) {
    assert.deepEqual(decideGitHubBrokerOperation(boundary, operation), {
      decision: 'allow',
      reason: 'operation_allowed',
      assignedBranch
    });
  }
});

test('broker denies destructive, privileged, protected-branch, and alternate-repository operations', () => {
  const denied: GitHubBrokerRequest[] = [
    request({ repositoryId: '999' }),
    request({ agentRunId: 'another-run' }),
    request({ operation: 'update_branch', branch: 'main', commitSha: 'a'.repeat(40) }),
    request({ operation: 'update_branch', branch: 'release/stable', commitSha: 'a'.repeat(40) }),
    request({ operation: 'update_branch', branch: 'relay/run-25', force: true }),
    request({ operation: 'update_branch', branch: 'relay/run-25' }),
    request({ operation: 'commit', branch: 'relay/run-25', commitSha: 'not-a-sha' }),
    request({
      operation: 'commit',
      branch: 'relay/run-25',
      commitSha: 'a'.repeat(40),
      commitMessage: 'Change CI',
      files: [{ path: '.github/workflows/release.yml', content: 'on: push' }]
    }),
    request({ operation: 'delete_reference', branch: 'relay/run-25' }),
    request({ operation: 'merge', pullRequestNumber: 17 }),
    request({ operation: 'administration' }),
    request({ operation: 'collaborators' }),
    request({ operation: 'release' }),
    request({ operation: 'deployment' }),
    request({ operation: 'workflow' }),
    request({ operation: 'secret' }),
    request({ operation: 'pull_request_upsert', branch: 'feature/not-assigned' })
  ];

  for (const operation of denied) {
    assert.equal(decideGitHubBrokerOperation(boundary, operation).decision, 'deny');
  }
});

test('broker records decisions before remote access and records successful results append-only', async () => {
  const evidence: string[] = [];
  const remote: GitHubBrokerRemote = {
    async execute() {
      evidence.push('remote');
      return { commitSha: 'a'.repeat(40) };
    }
  };
  const executionBoundary = {
    policy: boundary,
    remote: {
      installationId: '101', repositoryId: '202', repositoryOwner: 'relay-owner',
      repositoryName: 'pilot', defaultBranch: 'main'
    }
  };
  await executeGitHubBrokerBoundary(
    executionBoundary,
    remote,
    request({ operation: 'fetch' }),
    async (_decision, phase) => { evidence.push(phase); }
  );
  assert.deepEqual(evidence, ['decision', 'remote', 'result']);

  await assert.rejects(executeGitHubBrokerBoundary(
    executionBoundary,
    remote,
    request({ operation: 'merge' }),
    async (_decision, phase) => { evidence.push(`deny:${phase}`); }
  ), GitHubBrokerDeniedError);
  assert.deepEqual(evidence.slice(-1), ['deny:decision']);
});
