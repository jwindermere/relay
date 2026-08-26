export type VisibleAgentRunStatus =
  | 'queued'
  | 'planning'
  | 'working'
  | 'waiting_for_input'
  | 'waiting_for_approval'
  | 'recovering'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentRunEventUpdate {
  sequence: number;
  status: VisibleAgentRunStatus;
  summary: string;
}

export interface PullRequestArtifact {
  kind: 'github_pull_request';
  pullRequestNumber: number;
  url: string;
}

export interface AgentRunUpdate {
  id: string;
  sourceMessageId: string;
  attemptNumber: number;
  status: VisibleAgentRunStatus;
  summary: string;
  sequence: number;
  events: AgentRunEventUpdate[];
  artifact?: PullRequestArtifact;
}

export interface ChannelReconciliationUpdate {
  channelId: string;
  runs: AgentRunUpdate[];
}

export interface VisibleAgentRun {
  id: string;
  sourceMessageId: string;
  attemptNumber: number;
  status: VisibleAgentRunStatus;
  summary: string;
  sequence: number;
  milestones: AgentRunEventUpdate[];
  artifact?: PullRequestArtifact;
}

export type VisibleAgentRuns = Record<string, VisibleAgentRun>;
export type AgentRunCursors = Record<string, number>;

export function encodeAgentRunCursors(cursors: Readonly<AgentRunCursors>): string {
  return JSON.stringify(cursors);
}

export function decodeAgentRunCursors(value: string | null): AgentRunCursors {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(
      (entry): entry is [string, number] => Boolean(entry[0])
        && Number.isSafeInteger(entry[1])
        && (entry[1] as number) >= 0
    ));
  } catch {
    return {};
  }
}

export function applyChannelReconciliation(
  current: Readonly<VisibleAgentRuns>,
  update: ChannelReconciliationUpdate
): VisibleAgentRuns {
  let next = current as VisibleAgentRuns;
  for (const run of update.runs) {
    const previousSequence = current[run.id]?.sequence ?? 0;
    if (run.sequence <= previousSequence) continue;
    const unseenEvents = run.events.filter(({ sequence }) => sequence > previousSequence);
    if (!isCompleteOrderedRange(unseenEvents, previousSequence + 1, run.sequence)) continue;
    const milestones = [...(current[run.id]?.milestones ?? [])];
    for (const event of unseenEvents) {
      const previousEntry = milestones.at(-1);
      if (previousEntry?.status === event.status && previousEntry.summary === event.summary) continue;
      milestones.push(event);
    }
    if (next === current) next = { ...current };
    next[run.id] = {
      id: run.id,
      sourceMessageId: run.sourceMessageId,
      attemptNumber: run.attemptNumber,
      status: run.status,
      summary: run.summary,
      sequence: run.sequence,
      milestones,
      ...((run.artifact ?? current[run.id]?.artifact)
        ? { artifact: run.artifact ?? current[run.id]?.artifact }
        : {})
    };
  }
  return next;
}

export function latestVisibleAgentRunForSource(
  runs: Readonly<VisibleAgentRuns>,
  sourceMessageId: string
): VisibleAgentRun | undefined {
  return Object.values(runs)
    .filter((run) => run.sourceMessageId === sourceMessageId)
    .sort((left, right) => right.attemptNumber - left.attemptNumber)[0];
}

export function mergeChannelMessages<T extends { id: string; createdAt: string }>(
  current: readonly T[],
  incoming: readonly T[]
): T[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  );
}

function isCompleteOrderedRange(
  events: readonly AgentRunEventUpdate[],
  firstSequence: number,
  lastSequence: number
): boolean {
  if (events.length !== lastSequence - firstSequence + 1) return false;
  return events.every((event, index) => event.sequence === firstSequence + index);
}
