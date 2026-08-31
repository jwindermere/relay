import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createRulesetBypassAttestations,
  evaluateRepositoryProtection,
  type GitHubRepositoryEvidence
} from '../src/lib/server/github/protection.js';

const protectedRepository: GitHubRepositoryEvidence = {
  appId: 17,
  installation: {
    id: 101,
    repositorySelection: 'selected',
    permissions: {
      metadata: 'read',
      contents: 'write',
      pullRequests: 'write'
    },
    repositoryIds: [202]
  },
  repository: {
    id: 202,
    nodeId: 'R_202',
    ownerNodeId: 'O_303',
    owner: 'relay-owner',
    name: 'pilot',
    defaultBranch: 'main',
    branches: ['main', 'release']
  },
  branches: [
    {
      name: 'main',
      rules: [
        {
          rulesetId: 401,
          type: 'pull_request',
          parameters: {
            requiredApprovingReviewCount: 1,
            dismissStaleReviewsOnPush: true,
            requireLastPushApproval: false
          }
        },
        {
          rulesetId: 401,
          type: 'required_status_checks',
          parameters: { requiredStatusChecks: ['test'] }
        },
        { rulesetId: 401, type: 'non_fast_forward' },
        { rulesetId: 401, type: 'deletion' }
      ],
      rulesets: [{ id: 401, bypassActorAppIds: [] }]
    },
    {
      name: 'release',
      rules: [
        {
          rulesetId: 402,
          type: 'pull_request',
          parameters: {
            requiredApprovingReviewCount: 2,
            dismissStaleReviewsOnPush: true,
            requireLastPushApproval: false
          }
        },
        {
          rulesetId: 402,
          type: 'required_status_checks',
          parameters: { requiredStatusChecks: ['build', 'test'] }
        },
        { rulesetId: 402, type: 'non_fast_forward' },
        { rulesetId: 402, type: 'deletion' }
      ],
      rulesets: [{ id: 402, bypassActorAppIds: [] }]
    }
  ]
};

test('selected repository with human-reviewed branch controls enables autonomy', () => {
  assert.deepEqual(evaluateRepositoryProtection(protectedRepository, ['release']), {
    readyForAutonomousWork: true,
    failures: [],
    branches: [
      { name: 'main', protected: true, failures: [] },
      { name: 'release', protected: true, failures: [] }
    ]
  });
});

test('missing, unverifiable, or App-bypassed controls keep autonomy disabled', () => {
  const evidence = structuredClone(protectedRepository);
  evidence.installation.repositorySelection = 'all';
  evidence.installation.permissions = {
    metadata: 'read',
    contents: 'write',
    pullRequests: 'write',
    administration: 'read'
  };
  evidence.branches[0]!.rules = evidence.branches[0]!.rules.filter(
    ({ type }) => type !== 'required_status_checks' && type !== 'deletion'
  );
  evidence.branches[0]!.rulesets[0]!.bypassActorAppIds = [17];
  evidence.branches[1]!.rulesets[0]!.bypassActorAppIds = undefined;

  const result = evaluateRepositoryProtection(evidence, ['release']);

  assert.equal(result.readyForAutonomousWork, false);
  assert.deepEqual(result.failures, [
    'GitHub App installation must be limited to selected repositories',
    'GitHub App installation must contain exactly the linked repository',
    'GitHub App permissions must be exactly metadata:read, contents:write, pull_requests:write'
  ]);
  assert.deepEqual(result.branches, [
    {
      name: 'main',
      protected: false,
      failures: [
        'required status checks are absent',
        'branch deletion is not blocked',
        'Relay GitHub App can bypass a protecting ruleset'
      ]
    },
    {
      name: 'release',
      protected: false,
      failures: ['ruleset bypass actors could not be verified']
    }
  ]);
});

test('unknown or duplicated release branches fail closed', () => {
  const result = evaluateRepositoryProtection(protectedRepository, ['missing', 'release', 'release']);

  assert.equal(result.readyForAutonomousWork, false);
  assert.deepEqual(result.failures, [
    'release branches must be unique',
    'configured branch missing does not exist in the linked repository'
  ]);
});

test('owner bypass attestation is bound to the inspected ruleset version', () => {
  const evidence = structuredClone(protectedRepository);
  const ruleset = evidence.branches[0]!.rulesets[0]! as typeof evidence.branches[0]['rulesets'][number]
    & { updatedAt?: string };
  ruleset.bypassActorAppIds = undefined;
  ruleset.updatedAt = '2026-08-26T19:00:00Z';

  assert.deepEqual(evaluateRepositoryProtection(evidence, []), {
    readyForAutonomousWork: false,
    failures: [],
    branches: [{
      name: 'main',
      protected: false,
      failures: ['ruleset bypass actors could not be verified']
    }]
  });

  const attestation = [{ rulesetId: 401, rulesetUpdatedAt: '2026-08-26T19:00:00Z' }];
  assert.deepEqual(createRulesetBypassAttestations(evidence), attestation);
  assert.deepEqual(evaluateRepositoryProtection(evidence, [], attestation), {
    readyForAutonomousWork: true,
    failures: [],
    branches: [{ name: 'main', protected: true, failures: [] }],
    bypassAttestations: attestation
  });

  ruleset.updatedAt = '2026-08-26T20:00:00Z';
  assert.equal(
    evaluateRepositoryProtection(evidence, [], attestation).readyForAutonomousWork,
    false
  );

  ruleset.bypassActorAppIds = [17];
  assert.deepEqual(createRulesetBypassAttestations(evidence), []);
  assert.equal(
    evaluateRepositoryProtection(evidence, [], [{
      rulesetId: 401,
      rulesetUpdatedAt: '2026-08-26T20:00:00Z'
    }]).readyForAutonomousWork,
    false
  );
});
