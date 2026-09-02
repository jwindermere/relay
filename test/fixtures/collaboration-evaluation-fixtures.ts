import type { CollaborationEvaluationFixture } from '../../src/lib/server/collaboration/accountability.js';
import { decideMessageIntent } from '../../src/lib/server/collaboration/message-intent.js';

export const baselineCollaborationEvaluationFixture = {
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
} as const satisfies CollaborationEvaluationFixture;

export function createCandidateCollaborationEvaluationFixture(): CollaborationEvaluationFixture {
  const routing = decideMessageIntent({
    body: '@Riley investigate the launch risk', parentMessageId: null,
    agents: [{ id: 'riley', name: 'Riley', agentType: 'research' }]
  });
  return {
    id: `candidate-${routing.policyVersion}`,
    attribution: {
      agentType: 'research', routingPolicyVersion: routing.policyVersion, promptVersion: 'research-v1',
      permissionPolicyVersion: 'read-only-v1', agentConfigurationVersion: 'research-config-v2'
    },
    handoffDepths: [0, 1],
    findings: [{ id: 'finding-1', summary: 'Launch risk', confidence: 0.7, evidenceReferences: ['source-1'] }],
    routingDecisions: [{ id: 'message-1', selectedIntent: routing.intent, correctedIntent: null }],
    outcomes: ['completed', 'completed'],
    pilotFeedback: ['useful']
  };
}
