import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  evaluatePilotJourneyDurableEvidence,
  type PilotJourneyObservation
} from '../src/lib/pilot-journey.js';

function completeObservation(): PilotJourneyObservation {
  return {
    workspace: { id: 'workspace-pilot', name: 'MVP pilot workspace' },
    pilotMembers: [
      {
        id: 'pilot-owner',
        name: 'Owner',
        active: true,
        acceptedDelegations: 1
      },
      {
        id: 'pilot-member',
        name: 'Member',
        active: true,
        acceptedDelegations: 1
      }
    ],
    acceptedMentions: 2,
    rejectedMentions: 1,
    crossMemberCollaborativeRuns: 1,
    cancelledRunsWithRequest: 1,
    failedRuns: 1,
    pausedRecoveries: 1,
    pullRequestArtifacts: [
      {
        runId: 'run-completed',
        completed: true,
        repositoryOwner: 'jwindermere',
        repositoryName: 'relay',
        branch: 'relay/run-completed',
        commitSha: 'a'.repeat(40),
        pullRequestNumber: 28,
        url: 'https://github.com/jwindermere/relay/pull/28'
      }
    ],
    duplicateTasks: 0,
    duplicateTerminalEvents: 0,
    duplicateArtifacts: 0,
    artifactResultAnomalies: 0,
    duplicateProviderTurns: 0,
    duplicateRepositoryOperations: 0
  };
}

test('a complete two-member pilot journey passes every durable evidence gate', () => {
  const report = evaluatePilotJourneyDurableEvidence(completeObservation());

  assert.equal(report.passed, true);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.pullRequests, ['https://github.com/jwindermere/relay/pull/28']);
  assert.equal(report.checks.every(({ passed }) => passed), true);
});

test('the report explains missing independent delegation and real pull-request evidence', () => {
  const observation = completeObservation();
  observation.pilotMembers[1]!.acceptedDelegations = 0;
  observation.pullRequestArtifacts[0]!.url = 'https://github.test/relay/pull/28';

  const report = evaluatePilotJourneyDurableEvidence(observation);

  assert.equal(report.passed, false);
  assert.deepEqual(report.failures, [
    'Both active Pilot members have not independently delegated accepted work.',
    'No completed AgentRun has a real github.com pull-request Artifact.'
  ]);
  assert.deepEqual(report.pullRequests, []);
});

test('pull-request evidence must match its Linked pilot repository and AgentRun branch', () => {
  const observation = completeObservation();
  observation.pullRequestArtifacts[0]!.branch = 'relay/a-different-run';

  const report = evaluatePilotJourneyDurableEvidence(observation);

  assert.deepEqual(report.failures, [
    'No completed AgentRun has a real github.com pull-request Artifact.'
  ]);
});

test('the report requires the collaboration and recovery lifecycle exercised by the pilot', () => {
  const observation = completeObservation();
  observation.rejectedMentions = 0;
  observation.crossMemberCollaborativeRuns = 0;
  observation.cancelledRunsWithRequest = 0;
  observation.failedRuns = 0;
  observation.pausedRecoveries = 0;

  const report = evaluatePilotJourneyDurableEvidence(observation);

  assert.deepEqual(report.failures, [
    'The pilot has not retained both accepted and rejected Agent mentions.',
    'The pilot has not exercised queued, working, and clarification states.',
    'No Pilot member has answered another member\'s AgentRun clarification.',
    'The pilot has not produced both cancelled and failed AgentRun evidence.',
    'The pilot has not exercised recovering and human-reviewed paused states.'
  ]);
});

test('the report rejects duplicate durable repository and Channel effects', () => {
  const observation = completeObservation();
  observation.duplicateTasks = 1;
  observation.duplicateTerminalEvents = 1;
  observation.duplicateArtifacts = 1;
  observation.artifactResultAnomalies = 1;
  observation.duplicateProviderTurns = 1;
  observation.duplicateRepositoryOperations = 1;

  const report = evaluatePilotJourneyDurableEvidence(observation);

  assert.deepEqual(report.failures, [
    'Duplicate durable effects or an incomplete Artifact result were found.'
  ]);
});
