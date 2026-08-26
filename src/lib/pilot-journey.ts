export interface PilotJourneyObservation {
  workspace: { id: string; name: string };
  pilotMembers: Array<{
    id: string;
    name: string;
    active: boolean;
    acceptedDelegations: number;
  }>;
  acceptedMentions: number;
  rejectedMentions: number;
  eventTypes: string[];
  crossMemberClarifications: number;
  cancelledRuns: number;
  failedRuns: number;
  pullRequestArtifacts: Array<{
    runId: string;
    runStatus: string;
    pullRequestNumber: number;
    url: string;
  }>;
  duplicateTasks: number;
  duplicateTerminalEvents: number;
  duplicateArtifacts: number;
  artifactResultAnomalies: number;
}

export interface PilotJourneyCheck {
  name: string;
  passed: boolean;
  failure: string;
}

export interface PilotJourneyReport {
  workspace: PilotJourneyObservation['workspace'];
  passed: boolean;
  checks: PilotJourneyCheck[];
  failures: string[];
  pullRequests: string[];
}

export function evaluatePilotJourney(
  observation: PilotJourneyObservation
): PilotJourneyReport {
  const activePilots = observation.pilotMembers.filter(({ active }) => active);
  const pullRequests = observation.pullRequestArtifacts
    .filter((artifact) => artifact.runStatus === 'completed' && isGitHubPullRequest(artifact.url))
    .map(({ url }) => url);
  const checks: PilotJourneyCheck[] = [
    {
      name: 'independent delegation',
      passed: activePilots.length === 2
        && activePilots.every(({ acceptedDelegations }) => acceptedDelegations > 0),
      failure: 'Both active Pilot members have not independently delegated accepted work.'
    },
    {
      name: 'mention outcomes',
      passed: observation.acceptedMentions >= 2 && observation.rejectedMentions > 0,
      failure: 'The pilot has not retained both accepted and rejected Agent mentions.'
    },
    {
      name: 'collaborative execution',
      passed: includesEvery(observation.eventTypes, [
        'run.queued',
        'provider.turn.started',
        'run.clarification_requested',
        'run.clarification_answered'
      ]),
      failure: 'The pilot has not exercised queued, working, and clarification states.'
    },
    {
      name: 'cross-member clarification',
      passed: observation.crossMemberClarifications > 0,
      failure: "No Pilot member has answered another member's AgentRun clarification."
    },
    {
      name: 'cancelled and failed outcomes',
      passed: observation.cancelledRuns > 0
        && observation.failedRuns > 0
        && observation.eventTypes.includes('run.cancellation_requested'),
      failure: 'The pilot has not produced both cancelled and failed AgentRun evidence.'
    },
    {
      name: 'safe worker recovery',
      passed: includesEvery(observation.eventTypes, ['run.recovering', 'run.paused']),
      failure: 'The pilot has not exercised recovering and human-reviewed paused states.'
    },
    {
      name: 'unique durable effects',
      passed: observation.duplicateTasks === 0
        && observation.duplicateTerminalEvents === 0
        && observation.duplicateArtifacts === 0
        && observation.artifactResultAnomalies === 0,
      failure: 'Duplicate durable effects or an incomplete Artifact result were found.'
    },
    {
      name: 'pull-request Artifact',
      passed: pullRequests.length > 0,
      failure: 'No completed AgentRun has a real github.com pull-request Artifact.'
    }
  ];

  return {
    workspace: observation.workspace,
    passed: checks.every(({ passed }) => passed),
    checks,
    failures: checks.filter(({ passed }) => !passed).map(({ failure }) => failure),
    pullRequests
  };
}

function includesEvery(values: string[], required: string[]): boolean {
  const observed = new Set(values);
  return required.every((value) => observed.has(value));
}

function isGitHubPullRequest(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && /^\/[^/]+\/[^/]+\/pull\/\d+\/?$/u.test(url.pathname);
  } catch {
    return false;
  }
}
