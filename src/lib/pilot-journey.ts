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
  crossMemberCollaborativeRuns: number;
  cancelledRunsWithRequest: number;
  failedRuns: number;
  pausedRecoveries: number;
  pullRequestArtifacts: Array<{
    runId: string;
    completed: boolean;
    repositoryOwner: string;
    repositoryName: string;
    branch: string;
    commitSha: string;
    pullRequestNumber: number;
    url: string;
  }>;
  duplicateTasks: number;
  duplicateTerminalEvents: number;
  duplicateArtifacts: number;
  artifactResultAnomalies: number;
  duplicateProviderTurns: number;
  duplicateRepositoryOperations: number;
}

export interface PilotJourneyCheck {
  name: string;
  passed: boolean;
  failure: string;
}

export interface PilotJourneyDurableReport {
  workspace: PilotJourneyObservation['workspace'];
  passed: boolean;
  checks: PilotJourneyCheck[];
  failures: string[];
  pullRequests: string[];
}

export function evaluatePilotJourneyDurableEvidence(
  observation: PilotJourneyObservation
): PilotJourneyDurableReport {
  const activePilots = observation.pilotMembers.filter(({ active }) => active);
  const pullRequests = observation.pullRequestArtifacts
    .filter((artifact) => artifact.completed && isConsistentGitHubPullRequest(artifact))
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
      passed: observation.crossMemberCollaborativeRuns > 0,
      failure: 'The pilot has not exercised queued, working, and clarification states.'
    },
    {
      name: 'cross-member clarification',
      passed: observation.crossMemberCollaborativeRuns > 0,
      failure: "No Pilot member has answered another member's AgentRun clarification."
    },
    {
      name: 'cancelled and failed outcomes',
      passed: observation.cancelledRunsWithRequest > 0 && observation.failedRuns > 0,
      failure: 'The pilot has not produced both cancelled and failed AgentRun evidence.'
    },
    {
      name: 'safe worker recovery',
      passed: observation.pausedRecoveries > 0,
      failure: 'The pilot has not exercised recovering and human-reviewed paused states.'
    },
    {
      name: 'unique durable effects',
      passed: observation.duplicateTasks === 0
        && observation.duplicateTerminalEvents === 0
        && observation.duplicateArtifacts === 0
        && observation.artifactResultAnomalies === 0
        && observation.duplicateProviderTurns === 0
        && observation.duplicateRepositoryOperations === 0,
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

function isConsistentGitHubPullRequest(
  artifact: PilotJourneyObservation['pullRequestArtifacts'][number]
): boolean {
  try {
    const url = new URL(artifact.url);
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && url.pathname === `/${artifact.repositoryOwner}/${artifact.repositoryName}`
        + `/pull/${artifact.pullRequestNumber}`
      && artifact.branch === `relay/${artifact.runId}`
      && /^[0-9a-f]{40}$/u.test(artifact.commitSha);
  } catch {
    return false;
  }
}
