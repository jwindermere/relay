import assert from 'node:assert/strict';
import test from 'node:test';

import { presentFindingEvidence } from '../src/lib/finding-presentation.js';
import {
  canResumeCoordinationPlan,
  renderCoordinationSynthesis
} from '../src/lib/coordination-presentation.js';
import { renderMarkdown } from '../src/lib/markdown.js';
import {
  normalizeFindingInput,
  parseFindingResult,
  selectProjectMemoryContext
} from '../src/lib/server/collaboration/findings.js';
import {
  normalizeCoordinationPlan,
  parseCoordinationPlanProposal,
  reserveCoordinationBudget
} from '../src/lib/server/collaboration/coordination.js';
import { decideMessageIntent } from '../src/lib/server/collaboration/message-intent.js';
import {
  compareCollaborationEvaluationFixtures,
  detectCollaborationQualitySignals,
  normalizeCollaborationEvaluationEvidence,
  normalizeCollaborationEvaluationText
} from '../src/lib/server/collaboration/accountability.js';
import {
  baselineCollaborationEvaluationFixture,
  createCandidateCollaborationEvaluationFixture
} from './fixtures/collaboration-evaluation-fixtures.js';
import { messageIntentEvaluationFixtures } from './fixtures/message-intent-evaluation-fixtures.js';

test('inaccessible Finding evidence renders retained provenance without an active link', () => {
  assert.deepEqual(presentFindingEvidence({
    type: 'message',
    stableReference: 'message-other-project',
    title: 'Release decision',
    retrievedAt: '2026-08-30T12:00:00.000Z',
    claim: 'The other Project chose a phased release.',
    accessible: false
  }), {
    href: null,
    status: 'inaccessible',
    provenance: 'Message · message-other-project · retrieved 2026-08-30T12:00:00.000Z',
    title: 'Release decision',
    claim: 'The other Project chose a phased release.'
  });
});

test('Finding evidence rendering only links available HTTPS sources', () => {
  assert.equal(presentFindingEvidence({
    type: 'external', stableReference: 'https://example.test/release', title: 'Release record',
    retrievedAt: '2026-08-30T12:00:00.000Z', claim: 'The release is current.', accessible: true
  }).href, 'https://example.test/release');
  assert.equal(presentFindingEvidence({
    type: 'external', stableReference: 'javascript:alert(1)', title: 'Unsafe',
    retrievedAt: '2026-08-30T12:00:00.000Z', claim: 'An unsafe claim.', accessible: true
  }).href, null);
});

test('source-backed findings reject unsafe and duplicate evidence', () => {
  assert.throws(() => normalizeFindingInput({
    summary: 'A result', confidence: 0.8, observedEvidence: ['Observed fact'],
    inferences: [], assumptions: [], openQuestions: [],
    evidence: [{
      type: 'external', stableReference: 'javascript:alert(1)', title: 'Unsafe',
      retrievedAt: '2026-08-30T12:00:00.000Z', claim: 'A claim'
    }]
  }), /safe HTTPS URL/);

  assert.throws(() => normalizeFindingInput({
    summary: 'A result', confidence: 0.8, observedEvidence: ['Observed fact'],
    inferences: [], assumptions: [], openQuestions: [],
    evidence: [1, 2].map(() => ({
      type: 'repository' as const, stableReference: 'src/index.ts:10', title: 'Source',
      retrievedAt: '2026-08-30T12:00:00.000Z', claim: 'A claim'
    }))
  }), /duplicate evidence/);
  assert.throws(() => normalizeFindingInput({
    summary: 'Unsafe repository reference', confidence: 0.4,
    observedEvidence: [], inferences: [], assumptions: [], openQuestions: [],
    evidence: [{
      type: 'repository', stableReference: 'https://other.example/repository/file.ts',
      title: 'Unscoped repository', retrievedAt: '2026-08-30T12:00:00Z', claim: 'A claim'
    }]
  }), /relative repository path/);

  for (const summary of [
    'Use AKIAIOSFODNN7EXAMPLE for access.',
    'Use sk-proj-abcdefghijklmnopqrstuv for access.',
    'Token: eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2lnbmF0dXJl',
    'Authorization: Basic cmVsYXk6cHJpdmF0ZQ==',
    'Connect with postgres://relay:private-password@database/relay.',
    'The password is correct-horse-battery-staple.',
    'Provider payload included providerEventId and encrypted_reasoning.',
    'Raw trace: {"method":"item/tool/requestUserInput","params":{"question":"why"}}',
    'User: explain the choice\nAssistant: my internal reasoning follows.'
  ]) {
    assert.throws(() => normalizeFindingInput({
      summary, confidence: 0.4, observedEvidence: [], inferences: [], assumptions: [],
      openQuestions: [], evidence: []
    }), /credentials or Provider traces/);
  }
});

test('structured findings keep a concise Channel Message', () => {
  const parsed = parseFindingResult(`The evidence is mixed.

\`\`\`relay-finding
{"summary":"The evidence is mixed.","confidence":0.55,"observedEvidence":["One source supports the claim"],"inferences":["More data may change the conclusion"],"assumptions":[],"openQuestions":["Is the source current?"],"evidence":[]}
\`\`\``);
  assert.equal(parsed?.message, 'The evidence is mixed.');
  assert.equal(parsed?.finding.confidence, 0.55);
});

test('Project memory context is active, deterministic, and bounded', () => {
  const entries = Array.from({ length: 12 }, (_, index) => ({
    id: `memory-${String(index).padStart(2, '0')}`,
    type: 'decision' as const,
    statement: `Decision ${index}`,
    lifecycle: index === 3 ? 'archived' as const : 'active' as const,
    createdAt: new Date(2026, 0, index + 1).toISOString()
  }));
  assert.deepEqual(
    selectProjectMemoryContext(entries, 3).map(({ id }) => id),
    ['memory-09', 'memory-10', 'memory-11']
  );
  assert.deepEqual(selectProjectMemoryContext(entries, 0), []);
});

test('coordination plans reject hidden participants and recursive handoffs', () => {
  assert.throws(() => normalizeCoordinationPlan({
    goal: 'Assess launch readiness', allowParallel: false,
    budget: { maxParticipants: 1, maxHandoffs: 1, maxDepth: 1, maxAgentRuns: 0, maxElapsedSeconds: 600 },
    steps: [
      { key: 'research', agentId: 'riley', instruction: 'Assess evidence', dependencies: [] },
      { key: 'security', agentId: 'sentinel', instruction: 'Assess risk', dependencies: ['research'] }
    ]
  }), /participant budget/);

  assert.throws(() => normalizeCoordinationPlan({
    goal: 'Assess launch readiness', allowParallel: false,
    budget: { maxParticipants: 2, maxHandoffs: 2, maxDepth: 2, maxAgentRuns: 0, maxElapsedSeconds: 600 },
    steps: [{ key: 'research', agentId: 'riley', instruction: 'Assess evidence', dependencies: [] }]
  }), /handoff depth cannot exceed 1/);

  assert.throws(() => normalizeCoordinationPlan({
    goal: 'Use the existing review artifact', allowParallel: false,
    budget: { maxParticipants: 1, maxHandoffs: 0, maxDepth: 0, maxAgentRuns: 0, maxElapsedSeconds: 600 },
    steps: [{
      key: 'review', agentId: 'alex', instruction: 'Review the existing result',
      dependencies: [], expectedOutput: 'artifact'
    }]
  }), /must reference an existing Artifact/);

  assert.equal(normalizeCoordinationPlan({
    goal: 'Use the existing review artifact', allowParallel: false,
    budget: { maxParticipants: 1, maxHandoffs: 0, maxDepth: 0, maxAgentRuns: 1, maxElapsedSeconds: 600 },
    steps: [{
      key: 'review', agentId: 'alex', instruction: 'Review the existing result',
      dependencies: [], expectedOutput: 'artifact', artifactId: 'artifact-1'
    }]
  }).steps[0]?.artifactId, 'artifact-1');
});

test('coordination plans cannot authorize unsupported work outputs', () => {
  assert.throws(() => parseCoordinationPlanProposal(`
\`\`\`relay-coordination-plan
{"goal":"Change the repository through coordination","allowParallel":false,"budget":{"maxParticipants":1,"maxHandoffs":1,"maxDepth":1,"maxAgentRuns":1,"maxElapsedSeconds":600},"steps":[{"key":"implement","agentId":"alex","instruction":"Commit the change","dependencies":[],"expectedOutput":"repository_change"}]}
\`\`\``), /output type is not allowed/);
});

test('Provider-usage-limited coordination cannot make unreservable parallel claims', () => {
  assert.throws(() => normalizeCoordinationPlan({
    goal: 'Assess two sources within a measurable Provider allowance',
    allowParallel: true,
    budget: {
      maxParticipants: 2, maxHandoffs: 2, maxDepth: 1,
      maxAgentRuns: 0, maxElapsedSeconds: 600, providerUsageLimit: 100
    },
    steps: [
      { key: 'first', agentId: 'riley', instruction: 'Assess the first source', dependencies: [] },
      { key: 'second', agentId: 'maya', instruction: 'Assess the second source', dependencies: [] }
    ]
  }), /Provider-usage-limited coordination must run sequentially/);
});

test('coordination synthesis summarizes and links every approved step output', () => {
  const synthesis = renderCoordinationSynthesis('Assess launch readiness', [{
    key: 'research', agentName: 'Riley', instruction: 'Assess the evidence',
    summary: 'Release evidence supports a phased launch.',
    resultMessageId: 'result:research', artifactId: null, artifactUrl: null,
    artifactResultMessageId: null
  }, {
    key: 'review', agentName: 'Alex', instruction: 'Review the existing pull request',
    summary: null, resultMessageId: null, artifactId: 'artifact-7',
    artifactUrl: 'https://github.test/acme/relay/pull/7',
    artifactResultMessageId: 'result:artifact-7'
  }]);
  assert.equal(synthesis, `Coordination synthesis: Assess launch readiness

Overall assessment: Release evidence supports a phased launch. Review the existing pull request

Supporting results:
1. Riley — research: Release evidence supports a phased launch. [View result](#message-result%3Aresearch)
2. Alex — review: Existing Artifact [artifact-7](https://github.test/acme/relay/pull/7) ([Channel record](#message-result%3Aartifact-7))`);
  const rendered = renderMarkdown(synthesis);
  assert.match(rendered, /href="#message-result%3Aresearch"/);
  assert.match(rendered, /href="https:\/\/github\.test\/acme\/relay\/pull\/7"/);
  assert.match(rendered, /href="#message-result%3Aartifact-7"/);
});

test('coordination resume controls only appear for safely resumable paused plans', () => {
  assert.equal(canResumeCoordinationPlan({
    status: 'paused', budgetState: 'available', stepStatuses: ['completed', 'ready']
  }), true);
  assert.equal(canResumeCoordinationPlan({
    status: 'paused', budgetState: 'exhausted', stepStatuses: ['ready']
  }), false);
  assert.equal(canResumeCoordinationPlan({
    status: 'paused', budgetState: 'available', stepStatuses: ['failed']
  }), false);
  assert.equal(canResumeCoordinationPlan({
    status: 'active', budgetState: 'available', stepStatuses: ['ready']
  }), false);
});

test('coordination budget reservations never overspend', () => {
  assert.deepEqual(reserveCoordinationBudget({ consumed: 1, limit: 2 }, 1), {
    consumed: 2, remaining: 0
  });
  assert.throws(
    () => reserveCoordinationBudget({ consumed: 2, limit: 2 }, 1),
    /coordination budget is exhausted/i
  );
});

test('coordination plan proposals keep concise prose separate from structured work', () => {
  const parsed = parseCoordinationPlanProposal(`I propose two bounded reviews.

\`\`\`relay-coordination-plan
{"goal":"Assess launch","allowParallel":false,"budget":{"maxParticipants":1,"maxHandoffs":1,"maxDepth":1,"maxAgentRuns":0,"maxElapsedSeconds":600},"steps":[{"key":"research","agentId":"riley","instruction":"Assess evidence","dependencies":[]}]}
\`\`\``);
  assert.equal(parsed?.message, 'I propose two bounded reviews.');
  assert.equal(parsed?.plan.steps[0]?.key, 'research');
});

test('intent fixtures stay deterministic for ambiguous, adversarial, status, and cross-specialty requests', () => {
  const agents = [
    { id: 'alex', name: 'Alex', agentType: 'engineering' as const },
    { id: 'riley', name: 'Riley', agentType: 'research' as const }
  ];
  for (const fixture of messageIntentEvaluationFixtures) {
    const decision = decideMessageIntent({
      body: fixture.body,
      parentMessageId: fixture.parentMessageId,
      agents
    });
    assert.equal(decision.intent, fixture.expected.intent, fixture.category);
    assert.equal(decision.targetAgentId, fixture.expected.targetAgentId, fixture.category);
    if (fixture.expected.maximumConfidence !== undefined) {
      assert.ok(decision.confidence <= fixture.expected.maximumConfidence, fixture.category);
    }
    if (fixture.expected.rationalePattern) {
      assert.match(decision.rationale, fixture.expected.rationalePattern, fixture.category);
    }
  }
});

test('explicit Agent mentions select one deterministic target from Message order', () => {
  const alex = { id: 'alex', name: 'Alex', agentType: 'engineering' as const };
  const riley = { id: 'riley', name: 'Riley', agentType: 'research' as const };
  const input = {
    body: '@Riley research the rollout evidence and ask @Alex for context.',
    parentMessageId: null
  };

  const first = decideMessageIntent({ ...input, agents: [alex, riley] });
  const reordered = decideMessageIntent({ ...input, agents: [riley, alex] });

  assert.equal(first.targetAgentId, 'riley');
  assert.deepEqual(reordered, first);
});

test('intent rules distinguish conversation from research and engineering from progress wording', () => {
  const agents = [
    { id: 'alex', name: 'Alex', agentType: 'engineering' as const },
    { id: 'riley', name: 'Riley', agentType: 'research' as const }
  ];

  assert.equal(decideMessageIntent({
    body: '@Riley hello!', parentMessageId: null, agents
  }).intent, 'conversation');
  assert.equal(decideMessageIntent({
    body: '@Alex fix the progress view.', parentMessageId: null, agents
  }).intent, 'engineering_delegation');
  assert.equal(decideMessageIntent({
    body: '@Riley research the progress of the rollout.', parentMessageId: null, agents
  }).intent, 'research_request');

  const unmentionedEngineering = decideMessageIntent({
    body: 'Please fix the retry bug.', parentMessageId: null, agents
  });
  assert.equal(unmentionedEngineering.intent, 'engineering_delegation');
  assert.equal(unmentionedEngineering.targetAgentId, 'alex');
  assert.equal(unmentionedEngineering.requiresConfirmation, true);

  const hedgedConsequence = decideMessageIntent({
    body: 'Maybe deploy this release.', parentMessageId: null, agents
  });
  assert.equal(hedgedConsequence.intent, 'conversation');
  assert.ok(hedgedConsequence.confidence <= 0.6);
  assert.match(hedgedConsequence.rationale, /Pilot member clarification/);

  const unmentionedResearch = decideMessageIntent({
    body: 'Research the market evidence.', parentMessageId: null, agents
  });
  assert.equal(unmentionedResearch.intent, 'research_request');
  assert.equal(unmentionedResearch.targetAgentId, 'riley');

  const multipleEngineeringAgents = [...agents, {
    id: 'sam', name: 'Sam', agentType: 'engineering' as const
  }];
  const untargetedConsequence = decideMessageIntent({
    body: 'Maybe deploy this release.', parentMessageId: null, agents: multipleEngineeringAgents
  });
  assert.equal(untargetedConsequence.intent, 'conversation');
  assert.equal(untargetedConsequence.targetAgentId, null);
  assert.ok(untargetedConsequence.confidence <= 0.6);

  const multipleResearchAgents = [...agents, {
    id: 'sage', name: 'Sage', agentType: 'research' as const
  }];
  const untargetedResearch = decideMessageIntent({
    body: 'Research the market evidence.', parentMessageId: null, agents: multipleResearchAgents
  });
  assert.equal(untargetedResearch.intent, 'research_request');
  assert.equal(untargetedResearch.targetAgentId, null);
});

test('quality evaluation identifies observable collaboration failures without private reasoning', () => {
  assert.deepEqual(detectCollaborationQualitySignals({
    handoffDepths: [0, 2],
    findings: [
      { id: 'one', summary: 'Same investigation', confidence: 0.9, evidenceReferences: [] },
      { id: 'two', summary: 'Same investigation', confidence: 0.5, evidenceReferences: [] }
    ],
    routingDecisions: [{ id: 'message', selectedIntent: 'conversation', correctedIntent: 'research_request' }]
  }).map(({ type }) => type), [
    'recursive_handoff_attempt', 'duplicate_investigation', 'unsupported_certainty', 'routing_disagreement'
  ]);
});

test('collaboration fixtures reproducibly compare policy and configuration behavior', () => {
  const baseline = baselineCollaborationEvaluationFixture;
  const candidate = createCandidateCollaborationEvaluationFixture();
  assert.equal(candidate.routingDecisions[0]?.selectedIntent, 'research_request');

  assert.deepEqual(compareCollaborationEvaluationFixtures(baseline, candidate), {
    baselineFixtureId: 'baseline-routing-v1',
    candidateFixtureId: candidate.id,
    baselineAttribution: baseline.attribution,
    candidateAttribution: candidate.attribution,
    deltas: {
      automatedSignals: { recursive_handoff_attempt: -1, unsupported_certainty: -1, routing_disagreement: -1 },
      completionOutcomes: { completed: 1, failed: -1 },
      pilotFeedback: { useful: 1, incorrect: -1, incomplete: -1 }
    }
  });
  assert.deepEqual(compareCollaborationEvaluationFixtures(baseline, candidate),
    compareCollaborationEvaluationFixtures(baseline, candidate));
});

test('collaboration evaluation evidence rejects credentials and private reasoning', () => {
  assert.deepEqual(normalizeCollaborationEvaluationEvidence({
    confidence: 0.75, evidenceCount: 2, selectedIntent: 'research_request'
  }), { confidence: 0.75, evidenceCount: 2, selectedIntent: 'research_request' });
  assert.throws(
    () => normalizeCollaborationEvaluationEvidence({ authorization: 'Bearer secret-value' }),
    /credentials or private reasoning/
  );
  assert.throws(
    () => normalizeCollaborationEvaluationEvidence({ rationale: 'The private chain-of-thought was retained' }),
    /credentials or private reasoning/
  );
  assert.equal(
    normalizeCollaborationEvaluationText('  Useful because the Finding cites its source.  '),
    'Useful because the Finding cites its source.'
  );
  assert.throws(
    () => normalizeCollaborationEvaluationText('authorization: Bearer retained-secret-value'),
    /credentials or private reasoning/
  );
});
