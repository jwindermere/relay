import type { CollaborationEvaluationFixture } from '../../src/lib/server/collaboration/accountability.js';

export const collaborationEvaluationFixtures = {
  baseline: {
    id: 'baseline-routing-v1',
    attribution: {
      agentType: 'research', routingPolicyVersion: 'routing-v1', promptVersion: 'research-v1',
      permissionPolicyVersion: 'read-only-v1', agentConfigurationVersion: 'research-config-v1'
    },
    handoffDepths: [0, 2],
    findings: [{ id: 'finding-1', summary: 'Launch risk', confidence: 0.9, evidenceReferences: [] }],
    routingDecisions: [{ id: 'message-1', selectedIntent: 'conversation', correctedIntent: 'research_request' }],
    outcomes: ['completed', 'failed'],
    pilotFeedback: ['incorrect', 'incomplete']
  },
  candidate: {
    id: 'candidate-routing-v2',
    attribution: {
      agentType: 'research', routingPolicyVersion: 'routing-v2', promptVersion: 'research-v1',
      permissionPolicyVersion: 'read-only-v1', agentConfigurationVersion: 'research-config-v2'
    },
    handoffDepths: [0, 1],
    findings: [{ id: 'finding-1', summary: 'Launch risk', confidence: 0.7, evidenceReferences: ['source-1'] }],
    routingDecisions: [{ id: 'message-1', selectedIntent: 'research_request', correctedIntent: null }],
    outcomes: ['completed', 'completed'],
    pilotFeedback: ['useful']
  }
} as const satisfies Record<'baseline' | 'candidate', CollaborationEvaluationFixture>;
