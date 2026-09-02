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

export interface CoordinationPlanResumeState {
  status: string;
  budgetState: string;
  stepStatuses: string[];
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
  const assessments = steps
    .map((step) => synthesisText(step.summary || step.instruction))
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
  const overallAssessment = assessments.length === 0
    ? 'No substantive result was recorded.'
    : assessments.join(' ');
  return `Coordination synthesis: ${synthesisText(goal)}\n\nOverall assessment: ${overallAssessment}\n\nSupporting results:\n${lines.join('\n')}`;
}

export function canResumeCoordinationPlan(plan: CoordinationPlanResumeState): boolean {
  return plan.status === 'paused'
    && plan.budgetState !== 'exhausted'
    && !plan.stepStatuses.includes('failed');
}
