import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';

import { createGitHubRepositoryGateway } from '../src/lib/server/github/api.js';

test('GitHub gateway resolves repository identity and branch rules server-side', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const responses = new Map<string, unknown>([
    ['/app/installations/101', {
      id: 101,
      app_id: 17,
      repository_selection: 'selected',
      permissions: { metadata: 'read', contents: 'write', pull_requests: 'write' }
    }],
    ['/installation/repositories?per_page=100', {
      total_count: 1,
      repositories: [{
        id: 202,
        node_id: 'R_202',
        name: 'pilot',
        owner: { login: 'relay-owner', node_id: 'O_303' },
        default_branch: 'main'
      }]
    }],
    ['/repositories/202', {
      id: 202,
      node_id: 'R_202',
      name: 'pilot',
      owner: { login: 'relay-owner', node_id: 'O_303' },
      default_branch: 'main'
    }],
    ['/repos/relay-owner/pilot/branches/main', { name: 'main' }],
    ['/repos/relay-owner/pilot/branches/release%2Fstable', { name: 'release/stable' }],
    ['/repos/relay-owner/pilot/rules/branches/main?per_page=100', [
      {
        ruleset_id: 401,
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 1,
          dismiss_stale_reviews_on_push: true,
          require_last_push_approval: true
        }
      },
      {
        ruleset_id: 401,
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: 'test' }] }
      },
      { ruleset_id: 401, type: 'non_fast_forward' },
      { ruleset_id: 401, type: 'deletion' }
    ]],
    ['/repos/relay-owner/pilot/rules/branches/release%2Fstable?per_page=100', [
      { ruleset_id: 402, type: 'non_fast_forward' }
    ]],
    ['/repos/relay-owner/pilot/rulesets/401?includes_parents=true', {
      id: 401,
      bypass_actors: [{ actor_type: 'Integration', actor_id: 999 }]
    }],
    ['/repos/relay-owner/pilot/rulesets/402?includes_parents=true', {
      id: 402,
      bypass_actors: []
    }]
  ]);
  let tokenRequest = 0;
  const gateway = createGitHubRepositoryGateway({
    appId: '17',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname + new URL(String(url)).search;
      requests.push({ url: path, init });
      if (path === '/app/installations/101/access_tokens') {
        tokenRequest += 1;
        return Response.json({ token: tokenRequest === 1 ? 'inspection-secret' : 'repository-secret' });
      }
      const response = responses.get(path);
      if (response === undefined) return Response.json({ message: 'not found' }, { status: 404 });
      return Response.json(response);
    }
  });

  const evidence = await gateway.inspect({
    installationId: '101',
    releaseBranches: ['release/stable']
  });

  assert.equal(evidence.repository.owner, 'relay-owner');
  assert.equal(evidence.repository.name, 'pilot');
  assert.deepEqual(evidence.installation.repositoryIds, [202]);
  assert.deepEqual(evidence.branches[0]?.rules[0]?.parameters, {
    requiredApprovingReviewCount: 1,
    dismissStaleReviewsOnPush: true,
    requireLastPushApproval: true,
    requiredStatusChecks: undefined
  });
  assert.deepEqual(evidence.branches[0]?.rulesets, [{ id: 401, bypassActorAppIds: [999] }]);
  assert.deepEqual(evidence.branches[1]?.rulesets, [{ id: 402, bypassActorAppIds: [] }]);

  const tokenBodies = requests
    .filter(({ url }) => url.endsWith('/access_tokens'))
    .map(({ init }) => JSON.parse(String(init.body)));
  assert.deepEqual(tokenBodies, [
    { permissions: { metadata: 'read' } },
    {
      repository_ids: [202],
      permissions: { metadata: 'read', contents: 'write', pull_requests: 'write' }
    }
  ]);
  assert.doesNotMatch(JSON.stringify(evidence), /inspection-secret|repository-secret|BEGIN PRIVATE/);
});
