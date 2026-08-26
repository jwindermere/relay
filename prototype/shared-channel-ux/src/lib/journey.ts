import type { JourneyScene, Message, Viewer } from './types';

export const scenes: JourneyScene[] = [
  {
    key: 'mention',
    eyebrow: 'Request accepted',
    status: 'Queued',
    statusTone: 'neutral',
    title: 'Fix flaky reconnect coverage',
    summary: 'Jules mentioned Alex in the shared project channel. The request passed readiness checks and created one Task and one AgentRun.',
    activity: ['Task REL-24 created', 'Repository jwindermere/relay linked'],
    connection: 'Live',
    durableSequence: 1,
    nextLabel: 'Alex starts planning',
    event: 'request'
  },
  {
    key: 'planning',
    eyebrow: 'Concise activity',
    status: 'Planning',
    statusTone: 'info',
    title: 'Alex is planning the change',
    summary: 'The channel shows useful progress without exposing raw model output or internal reasoning.',
    activity: ['Reading reconnect tests', 'Checking durable event contract', 'Preparing a focused change'],
    connection: 'Live',
    durableSequence: 4,
    nextLabel: 'Alex asks a question',
    event: 'status'
  },
  {
    key: 'clarification',
    eyebrow: 'Human input needed',
    status: 'Waiting for input',
    statusTone: 'warning',
    title: 'Clarify the test boundary',
    summary: 'Should the regression cover a dropped wake-up only, or also a complete web-process restart?',
    activity: ['Work safely paused', 'Either pilot member may answer'],
    connection: 'Live',
    durableSequence: 6,
    nextLabel: 'Answer as current pilot',
    event: 'question'
  },
  {
    key: 'answered',
    eyebrow: 'Clarification answered',
    status: 'Queued',
    statusTone: 'info',
    title: 'The shared answer resumes the Task',
    summary: 'The reply is attributable to the authenticated pilot member and becomes Task context rather than a second Task.',
    activity: ['Answer attached to AgentRun', 'Run requeued on the same provider thread'],
    connection: 'Live',
    durableSequence: 8,
    nextLabel: 'Continue implementation',
    event: 'answer'
  },
  {
    key: 'working',
    eyebrow: 'Work in progress',
    status: 'Working',
    statusTone: 'info',
    title: 'Alex is implementing and testing',
    summary: 'The channel remains calm while the durable AgentRun records meaningful milestones.',
    activity: ['Updated reconnect test harness', 'Regression test now passes', 'Preparing pull request'],
    connection: 'Live',
    durableSequence: 12,
    nextLabel: 'Simulate Relay restart',
    event: 'working'
  },
  {
    key: 'recovering',
    eyebrow: 'Service restarted',
    status: 'Recovering',
    statusTone: 'warning',
    title: 'Reconnecting to durable work',
    summary: 'The web process restarted. The AgentRun and its history remain durable while both browsers reconcile missed events.',
    activity: ['Socket reconnected', 'Fetching events after sequence 12', 'Worker lease remains healthy'],
    connection: 'Reconnecting',
    durableSequence: 12,
    nextLabel: 'Recovery completes',
    event: 'recovery'
  },
  {
    key: 'resumed',
    eyebrow: 'Recovery complete',
    status: 'Working',
    statusTone: 'success',
    title: 'Run recovered without replay',
    summary: 'Both pilot views caught up to the same sequence. Alex continued from the existing provider turn and workspace.',
    activity: ['No duplicate channel updates', 'Both pilot cursors at sequence 14', 'Final checks running'],
    connection: 'Live',
    durableSequence: 14,
    nextLabel: 'Show completed work',
    event: 'resumed'
  },
  {
    key: 'completed',
    eyebrow: 'Reviewable outcome',
    status: 'Completed',
    statusTone: 'success',
    title: 'Reconnect regression fixed',
    summary: 'Alex added restart coverage and opened a pull request. Relay did not merge or deploy it.',
    activity: ['4 checks passed', 'Pull request ready for human review'],
    connection: 'Live',
    durableSequence: 18,
    nextLabel: 'Replay journey',
    event: 'result'
  }
];

export function messagesThrough(step: number, answerer: Viewer): Message[] {
  const messages: Message[] = [
    {
      author: 'Jules',
      role: 'Pilot member',
      time: '10:42',
      text: '@Alex fix the flaky reconnect coverage. Please include a regression test and open a PR.'
    }
  ];

  if (step >= 1) {
    messages.push({
      author: 'Alex',
      role: 'Engineering agent',
      time: '10:43',
      text: 'I’m reviewing the reconnect path and existing durable-event tests.',
      accent: true
    });
  }
  if (step >= 2) {
    messages.push({
      author: 'Alex',
      role: 'Engineering agent',
      time: '10:46',
      text: 'Quick clarification: should the regression cover a dropped wake-up only, or also a complete web-process restart?',
      accent: true
    });
  }
  if (step >= 3) {
    messages.push({
      author: answerer,
      role: 'Pilot member',
      time: '10:48',
      text: 'Cover both. The important proof is that a restart catches up without duplicate updates.'
    });
  }
  if (step >= 6) {
    messages.push({
      author: 'Alex',
      role: 'Engineering agent',
      time: '10:56',
      text: 'Recovered. Both pilot views are caught up and I’m continuing from the existing run—nothing was replayed.',
      accent: true
    });
  }
  if (step >= 7) {
    messages.push({
      author: 'Alex',
      role: 'Engineering agent',
      time: '11:04',
      text: 'Done. I added coverage for dropped wake-ups and web restarts. All four focused checks pass.',
      accent: true
    });
  }
  return messages;
}
