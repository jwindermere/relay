import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';

import { createGitHubBrokerRemote } from '../src/lib/server/github/api.js';

test('broker remote retains one repository-scoped installation token while returning repository data', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const requests: Array<{ path: string; authorization: string; body?: unknown }> = [];
  const remote = createGitHubBrokerRemote({
    appId: '17',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    fetch: async (url, init = {}) => {
      const parsed = new URL(String(url));
      const path = `${parsed.pathname}${parsed.search}`;
      requests.push({
        path,
        authorization: new Headers(init.headers).get('authorization') ?? '',
        ...(init.body ? { body: JSON.parse(String(init.body)) } : {})
      });
      if (path === '/app/installations/101/access_tokens') {
        return Response.json({
          token: 'installation-secret',
          expires_at: new Date(Date.now() + 3_600_000).toISOString()
        });
      }
      if (path === '/repos/relay-owner/pilot/git/ref/heads%2Fmain') {
        return Response.json({ object: { sha: 'a'.repeat(40) } });
      }
      if (path === `/repos/relay-owner/pilot/git/trees/${'a'.repeat(40)}?recursive=1`) {
        return Response.json({
          truncated: false,
          tree: [{ path: 'README.md', type: 'blob', sha: 'b'.repeat(40), size: 5 }]
        });
      }
      if (path === `/repos/relay-owner/pilot/git/blobs/${'b'.repeat(40)}`) {
        return Response.json({ content: Buffer.from('hello').toString('base64'), encoding: 'base64' });
      }
      return Response.json({ message: 'not found' }, { status: 404 });
    }
  });
  const common = {
    installationId: '101',
    repositoryId: '202',
    repositoryOwner: 'relay-owner',
    repositoryName: 'pilot',
    defaultBranch: 'main',
    assignedBranch: 'relay/run-25'
  };

  const clone = await remote.execute({
    ...common,
    request: {
      operation: 'clone', repositoryId: '202', agentRunId: 'run-25',
      attemptNumber: 1, actorWorkspaceMemberId: 'agent-member-25'
    }
  });
  await remote.execute({
    ...common,
    request: {
      operation: 'fetch', repositoryId: '202', agentRunId: 'run-25',
      attemptNumber: 1, actorWorkspaceMemberId: 'agent-member-25'
    }
  });

  assert.deepEqual(clone, {
    commitSha: 'a'.repeat(40),
    files: [{ path: 'README.md', content: Buffer.from('hello').toString('base64'), encoding: 'base64' }]
  });
  assert.equal(requests.filter(({ path }) => path.endsWith('/access_tokens')).length, 1);
  assert.deepEqual(requests[0]?.body, {
    repository_ids: [202],
    permissions: { metadata: 'read', contents: 'write', pull_requests: 'write' }
  });
  assert.ok(requests.slice(1).every(({ authorization }) => authorization === 'Bearer installation-secret'));
  assert.doesNotMatch(JSON.stringify(clone), /installation-secret|BEGIN PRIVATE/);
});

test('broker remote refuses to update a pull request from another branch', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const requests: Array<{ path: string; method: string }> = [];
  const remote = createGitHubBrokerRemote({
    appId: '17',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      requests.push({ path, method: init.method ?? 'GET' });
      if (path.endsWith('/access_tokens')) {
        return Response.json({ token: 'installation-secret' });
      }
      if (path.endsWith('/pulls/99')) {
        return Response.json({ head: { ref: 'unrelated', repo: { id: 202 } } });
      }
      return Response.json({ message: 'not found' }, { status: 404 });
    }
  });

  await assert.rejects(remote.execute({
    installationId: '101',
    repositoryId: '202',
    repositoryOwner: 'relay-owner',
    repositoryName: 'pilot',
    defaultBranch: 'main',
    assignedBranch: 'relay/run-25',
    request: {
      operation: 'pull_request_upsert',
      repositoryId: '202',
      agentRunId: 'run-25',
      attemptNumber: 1,
      actorWorkspaceMemberId: 'agent-member-25',
      branch: 'relay/run-25',
      pullRequestNumber: 99
    }
  }), /does not belong to the AgentRun branch/);
  assert.equal(requests.filter(({ path, method }) => path.endsWith('/pulls/99') && method === 'PATCH').length, 0);
});
