export interface CoordinationSynthesisStep {
  key: string;
  agentName: string;
  instruction: string;
  summary: string | null;
  resultMessageId: string | null;
  artifactId: string | null;
  artifactUrl: string | null;
  artifactResultMessageId: string | null;
}

export type CoordinationPlanStatus =
  | 'proposed' | 'approved' | 'active' | 'paused'
  | 'completed' | 'rejected' | 'cancelled' | 'failed';

export type CoordinationStepStatus =
  | 'pending' | 'ready' | 'active' | 'completed'
  | 'blocked' | 'cancelled' | 'failed';

export type CoordinationBudgetState = 'available' | 'approaching' | 'exhausted';

export interface CoordinationPlanResumeState {
  status: CoordinationPlanStatus;
  budgetState: CoordinationBudgetState;
  stepStatuses: CoordinationStepStatus[];
}

function synthesisText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, 1000).replace(/[\\[\]*_`]/gu, '\\$&');
}

function channelMessageLink(messageId: string, label: string): string {
  return `[${label}](#message-${encodeURIComponent(messageId)})`;
}

export function renderCoordinationSynthesis(
  goal: string,
  steps: CoordinationSynthesisStep[]
): string {
  const resultSummaries = steps
    .map((step) => step.summary
      ? synthesisText(step.summary)
      : step.artifactId
        ? `Review existing Artifact ${synthesisText(step.artifactId)}.`
        : '')
    .filter(Boolean);
  const lines = steps.map((step, index) => {
    const prefix = `${index + 1}. ${synthesisText(step.agentName)} — ${synthesisText(step.key)}:`;
    if (step.artifactId && step.artifactUrl) {
      const artifact = `Existing Artifact [${synthesisText(step.artifactId)}](${step.artifactUrl})`;
      const channelRecord = step.artifactResultMessageId
        ? ` (${channelMessageLink(step.artifactResultMessageId, 'Channel record')})`
        : '';
      return `${prefix} ${artifact}${channelRecord}`;
    }
    const summary = synthesisText(step.summary || step.instruction);
    const result = step.resultMessageId
      ? ` ${channelMessageLink(step.resultMessageId, 'View result')}`
      : '';
    return `${prefix} ${summary}${result}`;
  });
  const overallAssessment = resultSummaries.length === 0
    ? 'No substantive result was recorded.'
    : resultSummaries.join(' ');
  return `Coordination synthesis: ${synthesisText(goal)}\n\nOverall assessment: ${overallAssessment}\n\nSupporting results:\n${lines.join('\n')}`;
}

export function canResumeCoordinationPlan(plan: CoordinationPlanResumeState): boolean {
  return plan.status === 'paused'
    && plan.budgetState !== 'exhausted'
    && !plan.stepStatuses.includes('failed');
}
