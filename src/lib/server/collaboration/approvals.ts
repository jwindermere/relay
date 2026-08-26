import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { appendAgentRunEvent } from '../provider/agent-run-events.js';

interface ApprovalReplyContext {
  messageId: string;
  workspaceId: string;
  channelId: string;
  parentMessageId: string;
  body: string;
}

interface ThreadApproval {
  id: string;
  agent_run_id: string;
  state: 'pending' | 'approved' | 'denied' | 'consumed' | 'expired';
  author_workspace_member_id: string;
  current_boundary: boolean;
}

export async function handleApprovalReply(
  client: PoolClient,
  context: ApprovalReplyContext
): Promise<boolean> {
  const decision = readDecision(context.body);
  if (!decision) return false;
  const approval = await findThreadApproval(client, context, decision.code);
  if (!approval) return false;
  if (approval.state !== 'pending') return true;

  const nextState = approval.current_boundary
    ? decision.kind === 'approve' ? 'approved' : 'denied'
    : 'expired';
  const resolved = await client.query(
    `UPDATE public.approval
     SET state = $2, decision_message_id = $3,
         decided_by_workspace_member_id = $4, decided_at = now()
     WHERE id = $1 AND state = 'pending'`,
    [approval.id, nextState, context.messageId, approval.author_workspace_member_id]
  );
  if (resolved.rowCount !== 1) return true;

  if (nextState === 'expired') {
    await appendAgentRunEvent(client, {
      id: approval.agent_run_id,
      workspaceId: context.workspaceId
    }, {
      eventType: 'run.paused',
      status: 'paused',
      summary: 'Approval expired after its execution boundary changed',
      evidence: { approvalId: approval.id, reason: 'stale_approval_boundary' }
    });
    await postApprovalResolutionMessage(
      client,
      approval.id,
      'expired'
    );
    return true;
  }

  await appendAgentRunEvent(client, {
    id: approval.agent_run_id,
    workspaceId: context.workspaceId
  }, {
    eventType: nextState === 'approved' ? 'run.approval_approved' : 'run.approval_denied',
    status: 'queued',
    summary: nextState === 'approved'
      ? 'A Pilot member approved one action'
      : 'A Pilot member denied the requested action',
    evidence: {
      approvalId: approval.id,
      decisionMessageId: context.messageId,
      decidedByWorkspaceMemberId: approval.author_workspace_member_id
    }
  });
  if (nextState === 'denied') {
    await postApprovalResolutionMessage(
      client,
      approval.id,
      'denied'
    );
  }
  return true;
}

async function findThreadApproval(
  client: PoolClient,
  context: ApprovalReplyContext,
  decisionCode: string
): Promise<ThreadApproval | undefined> {
  const result = await client.query<ThreadApproval>(
    `SELECT approval.id, approval.agent_run_id, approval.state,
            reply.author_workspace_member_id,
            (run.lease_owner IS NOT NULL
              AND run.lease_expires_at > now()
              AND run.status = 'waiting_for_approval'
              AND run.provider_thread_id = approval.provider_thread_id
              AND run.active_turn_id = approval.provider_turn_id) AS current_boundary
     FROM public.approval approval
     JOIN public.agent_run run ON run.id = approval.agent_run_id
     JOIN public.task task ON task.id = run.task_id
     JOIN public.message source ON source.id = task.source_message_id
     JOIN public.message request ON request.id = approval.request_message_id
     JOIN public.message reply ON reply.id = $1
     WHERE approval.workspace_id = $2
       AND source.channel_id = $3
       AND COALESCE(source.parent_message_id, source.id) = $4
       AND approval.decision_code = $5
       AND (reply.created_at, reply.id) > (request.created_at, request.id)
     ORDER BY (approval.state = 'pending') DESC, approval.created_at DESC, approval.id DESC
     LIMIT 1
     FOR UPDATE OF approval, run`,
    [
      context.messageId,
      context.workspaceId,
      context.channelId,
      context.parentMessageId,
      decisionCode
    ]
  );
  return result.rows[0];
}

export async function postApprovalResolutionMessage(
  client: PoolClient,
  approvalId: string,
  resolution: 'denied' | 'expired' | 'recovery_expired' | 'consumed'
): Promise<void> {
  const context = await client.query<{
    workspace_id: string;
    channel_id: string;
    parent_message_id: string;
    requester_workspace_member_id: string;
    decision_code: string;
  }>(
    `SELECT approval.workspace_id, approval.decision_code,
            request.channel_id, request.parent_message_id,
            approval.requester_workspace_member_id
     FROM public.approval approval
     JOIN public.message request ON request.id = approval.request_message_id
     WHERE approval.id = $1`,
    [approvalId]
  );
  const row = context.rows[0];
  if (!row?.parent_message_id) throw new Error('Approval Channel context changed');
  const bodies = {
    denied: `Approval ${row.decision_code} was denied.`,
    expired: `Approval ${row.decision_code} expired without being used.`,
    recovery_expired:
      `Approval ${row.decision_code} expired without being used after execution recovery.`,
    consumed: `Approval ${row.decision_code} was used once.`
  };
  const messageId = randomUUID();
  await client.query(
    `INSERT INTO public.message (
       id, workspace_id, channel_id, author_workspace_member_id, parent_message_id, body
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      messageId,
      row.workspace_id,
      row.channel_id,
      row.requester_workspace_member_id,
      row.parent_message_id,
      bodies[resolution]
    ]
  );
  await client.query(
    `INSERT INTO public.notification_outbox (workspace_id, message_id, topic, payload)
     VALUES ($1, $2, 'channel.message', $3)`,
    [row.workspace_id, messageId, { messageId }]
  );
}

function readDecision(body: string): { kind: 'approve' | 'deny'; code: string } | undefined {
  const match = /^(approve|approved|deny|denied)\s+([a-f0-9]{8})[.!]?$/i.exec(body.trim());
  if (!match?.[1] || !match[2]) return undefined;
  return {
    kind: match[1].toLowerCase().startsWith('approv') ? 'approve' : 'deny',
    code: match[2].toLowerCase()
  };
}
