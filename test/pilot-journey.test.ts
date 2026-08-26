import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  evaluatePilotJourney,
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
    eventTypes: [
      'run.queued',
      'provider.thread.started',
      'provider.turn.started',
      'run.clarification_requested',
      'run.clarification_answered',
      'run.cancellation_requested',
      'provider.turn.completed',
      'run.failed',
      'run.recovering',
      'run.paused'
    ],
    crossMemberClarifications: 1,
    cancelledRuns: 1,
    failedRuns: 1,
    pullRequestArtifacts: [
      {
        runId: 'run-completed',
        runStatus: 'completed',
        pullRequestNumber: 28,
        url: 'https://github.com/jwindermere/relay/pull/28'
      }
    ],
    duplicateTasks: 0,
    duplicateTerminalEvents: 0,
    duplicateArtifacts: 0,
    artifactResultAnomalies: 0
  };
}

test('a complete two-member pilot journey passes every durable evidence gate', () => {
  const report = evaluatePilotJourney(completeObservation());

  assert.equal(report.passed, true);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.pullRequests, ['https://github.com/jwindermere/relay/pull/28']);
  assert.equal(report.checks.every(({ passed }) => passed), true);
});

test('the report explains missing independent delegation and real pull-request evidence', () => {
  const observation = completeObservation();
  observation.pilotMembers[1]!.acceptedDelegations = 0;
  observation.pullRequestArtifacts[0]!.url = 'https://github.test/relay/pull/28';

  const report = evaluatePilotJourney(observation);

  assert.equal(report.passed, false);
  assert.deepEqual(report.failures, [
    'Both active Pilot members have not independently delegated accepted work.',
    'No completed AgentRun has a real github.com pull-request Artifact.'
  ]);
  assert.deepEqual(report.pullRequests, []);
});

test('the report requires the collaboration and recovery lifecycle exercised by the pilot', () => {
  const observation = completeObservation();
  observation.rejectedMentions = 0;
  observation.eventTypes = ['run.queued', 'provider.turn.completed'];
  observation.crossMemberClarifications = 0;
  observation.cancelledRuns = 0;
  observation.failedRuns = 0;

  const report = evaluatePilotJourney(observation);

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

  const report = evaluatePilotJourney(observation);

  assert.deepEqual(report.failures, [
    'Duplicate durable effects or an incomplete Artifact result were found.'
  ]);
});
