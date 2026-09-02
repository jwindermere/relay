import type { PoolClient } from 'pg';

import { handleApprovalReply } from './approvals.js';
import { handleAgentRunCommand } from './agent-run-commands.js';
import { handleWaitingAgentRunReply } from './clarifications.js';
import { acceptCoordinationPlanConstraint } from './coordination-constraints.js';
import { answerAgentProgressRequest } from './progress.js';
import { acceptAgentRunSteering, parseGuidanceInput } from './steering.js';

export interface MessageControlContext {
  messageId: string;
  workspaceId: string;
  channelId: string;
  parentMessageId: string | null;
  body: string;
}

export async function handleConfirmedMessageControl(
  client: PoolClient,
  context: MessageControlContext
): Promise<boolean> {
  const guidance = parseGuidanceInput(context);
  const coordinationConstraintAccepted = guidance && context.parentMessageId
    ? await acceptCoordinationPlanConstraint(client, {
        ...context,
        parentMessageId: context.parentMessageId
      }, guidance)
    : false;
  const guidanceAccepted = coordinationConstraintAccepted
    || await acceptAgentRunSteering(client, context, guidance ?? undefined);
  if (guidanceAccepted) return true;
  if (await answerAgentProgressRequest(client, context)) return true;
  if (!context.parentMessageId) return false;
  if (await handleAgentRunCommand(client, {
    ...context,
    parentMessageId: context.parentMessageId
  })) return true;
  if (await handleApprovalReply(client, {
    ...context,
    parentMessageId: context.parentMessageId
  })) return true;
  return handleWaitingAgentRunReply(client, {
    ...context,
    parentMessageId: context.parentMessageId
  });
}
