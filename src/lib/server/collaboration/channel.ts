import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import type { WorkspaceAccess } from '../authentication/authorization.js';
import type { GitHubRepositoryGateway } from '../github/connection.js';
import { hasActivePilotChannelAccess } from './channel-access.js';
import { handleApprovalReply } from './approvals.js';
import { handleAgentRunCommand } from './agent-run-commands.js';
import { handleWaitingAgentRunReply } from './clarifications.js';
import { acceptEligibleAgentMention, type AgentMentionResult } from './delegation.js';
import { acceptAgentConversation } from './conversation.js';
import { answerAgentProgressRequest } from './progress.js';

export class ChannelMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelMessageError';
  }
}

export interface SharedChannelMember {
  id: string;
  kind: 'pilot' | 'agent';
  name: string;
  roleLabel: string;
  status: 'online' | 'idle' | 'working' | 'waiting' | 'disabled';
}

export interface ChannelMessage {
  id: string;
  parentMessageId: string | null;
  body: string;
  createdAt: string;
  author: {
    workspaceMemberId: string;
    kind: 'pilot' | 'agent';
    name: string;
    roleLabel: string;
  };
  agentMention: AgentMentionResult;
}

export interface SharedAgentChannel {
  workspace: WorkspaceAccess['workspace'];
  viewerMembershipId: string;
  project: { id: string; name: string };
  channel: { id: string; name: string };
  members: SharedChannelMember[];
  messages: ChannelMessage[];
}

interface MessageRow {
  id: string;
  parent_message_id: string | null;
  body: string;
  created_at: Date;
  author_workspace_member_id: string;
  author_kind: 'pilot' | 'agent';
  author_name: string;
  author_role_label: string;
  agent_mention_status: 'communication' | 'conversation' | 'accepted' | 'rejected';
  mentioned_agent_id: string | null;
  agent_mention_reason: string | null;
  task_id: string | null;
  agent_run_id: string | null;
  conversation_turn_id: string | null;
  conversation_turn_status: 'queued' | 'working' | 'completed' | 'failed' | null;
}

const MESSAGE_PROJECTION = `
  SELECT m.id, m.parent_message_id, m.body, m.created_at,
         author.id AS author_workspace_member_id, author.kind AS author_kind,
         COALESCE(pilot_user.name, agent.name) AS author_name,
         CASE WHEN author.kind = 'pilot' THEN 'Pilot member' ELSE agent.role_label END
           AS author_role_label,
         m.agent_mention_status, m.mentioned_agent_id, m.agent_mention_reason,
         task.id AS task_id, run.id AS agent_run_id,
         conversation_turn.id AS conversation_turn_id,
         conversation_turn.status AS conversation_turn_status
  FROM public.message m
  JOIN public.workspace_member author ON author.id = m.author_workspace_member_id
  LEFT JOIN public.workspace_membership pilot ON pilot.id = author.pilot_membership_id
  LEFT JOIN auth."user" pilot_user ON pilot_user.id = pilot.user_id
  LEFT JOIN public.agent agent ON agent.id = author.agent_id
  LEFT JOIN public.task task ON task.source_message_id = m.id
  LEFT JOIN public.agent_run run ON run.task_id = task.id AND run.attempt_number = 1
  LEFT JOIN public.agent_conversation_turn conversation_turn
    ON conversation_turn.request_message_id = m.id`;

function toChannelMessage(row: MessageRow): ChannelMessage {
  return {
    id: row.id,
    parentMessageId: row.parent_message_id,
    body: row.body,
    createdAt: row.created_at.toISOString(),
    author: {
      workspaceMemberId: row.author_workspace_member_id,
      kind: row.author_kind,
      name: row.author_name,
      roleLabel: row.author_role_label
    },
    agentMention: row.agent_mention_status === 'accepted'
      ? {
          status: 'accepted',
          agentId: row.mentioned_agent_id!,
          taskId: row.task_id!,
          agentRunId: row.agent_run_id!
        }
      : row.agent_mention_status === 'conversation'
        ? {
            status: 'conversation',
            agentId: row.mentioned_agent_id!,
            conversationTurnId: row.conversation_turn_id!,
            turnStatus: row.conversation_turn_status!
          }
      : row.agent_mention_status === 'rejected'
        ? {
            status: 'rejected',
            agentId: row.mentioned_agent_id!,
            reason: row.agent_mention_reason!
          }
        : null
  };
}

async function readMessage(
  client: Pool | PoolClient,
  messageId: string
): Promise<MessageRow | undefined> {
  const result = await client.query<MessageRow>(
    `${MESSAGE_PROJECTION} WHERE m.id = $1`,
    [messageId]
  );
  return result.rows[0];
}

export async function loadSharedAgentChannel(
  pool: Pool,
  access: WorkspaceAccess
): Promise<SharedAgentChannel> {
  const surface = await pool.query<{
    project_id: string;
    project_name: string;
    channel_id: string;
    channel_name: string;
  }>(
    `SELECT p.id AS project_id, p.name AS project_name,
            c.id AS channel_id, c.name AS channel_name
     FROM public.project p
     JOIN public.channel c ON c.project_id = p.id AND c.workspace_id = p.workspace_id
     JOIN public.project_membership pm ON pm.project_id = p.id
     JOIN public.workspace_member member ON member.id = pm.workspace_member_id
     JOIN public.workspace_membership wm ON wm.id = member.pilot_membership_id
     WHERE p.workspace_id = $1
       AND wm.id = $2
       AND wm.revoked_at IS NULL
     ORDER BY c.created_at, c.id
     LIMIT 1`,
    [access.workspace.id, access.membership.id]
  );
  const selected = surface.rows[0];
  if (!selected) throw new ChannelMessageError('shared Agent Channel access is required');

  const [members, messages] = await Promise.all([
    pool.query<{
      id: string;
      kind: 'pilot' | 'agent';
      name: string;
      role_label: string;
      status: SharedChannelMember['status'];
    }>(
      `SELECT member.id, member.kind,
              COALESCE(pilot_user.name, agent.name) AS name,
              CASE WHEN member.kind = 'pilot' THEN 'Pilot member' ELSE agent.role_label END
                AS role_label,
              CASE WHEN member.kind = 'pilot' THEN 'online' ELSE agent.status END AS status
       FROM public.project_membership pm
       JOIN public.workspace_member member ON member.id = pm.workspace_member_id
       LEFT JOIN public.workspace_membership pilot
         ON pilot.id = member.pilot_membership_id
       LEFT JOIN auth."user" pilot_user ON pilot_user.id = pilot.user_id
       LEFT JOIN public.agent agent ON agent.id = member.agent_id
       WHERE pm.project_id = $1
         AND (member.kind = 'agent' OR pilot.revoked_at IS NULL)
       ORDER BY name, member.id`,
      [selected.project_id]
    ),
    pool.query<MessageRow>(
      `${MESSAGE_PROJECTION}
       WHERE m.channel_id = $1
       ORDER BY m.created_at, m.id`,
      [selected.channel_id]
    )
  ]);

  return {
    workspace: access.workspace,
    viewerMembershipId: access.membership.id,
    project: { id: selected.project_id, name: selected.project_name },
    channel: { id: selected.channel_id, name: selected.channel_name },
    members: members.rows.map((member) => ({
      id: member.id,
      kind: member.kind,
      name: member.name,
      roleLabel: member.role_label,
      status: member.status
    })),
    messages: messages.rows.map(toChannelMessage)
  };
}

export async function loadAuthorizedChannelMessages(
  pool: Pool,
  access: WorkspaceAccess,
  channelId: string
): Promise<ChannelMessage[]> {
  if (!await hasActivePilotChannelAccess(pool, access, channelId)) {
    throw new ChannelMessageError('Shared agent channel access is required');
  }
  const messages = await pool.query<MessageRow>(
    `${MESSAGE_PROJECTION}
     WHERE m.channel_id = $1
     ORDER BY m.created_at, m.id`,
    [channelId]
  );
  return messages.rows.map(toChannelMessage);
}

export async function postChannelMessage(
  pool: Pool,
  access: WorkspaceAccess,
  input: { channelId: string; body: string; parentMessageId?: string; submissionId?: string },
  dependencies: { getRepositoryGateway?: () => GitHubRepositoryGateway } = {}
): Promise<ChannelMessage> {
  const body = input.body.trim();
  if (!body || body.length > 4000) {
    throw new ChannelMessageError('a Message must contain between 1 and 4000 characters');
  }

  const submissionId = input.submissionId?.trim() || randomUUID();
  if (submissionId.length > 200) {
    throw new ChannelMessageError('Message submission identifier is invalid');
  }
  const messageId = randomUUID();
  const parentMessageId = input.parentMessageId ?? null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO public.message (
         id, workspace_id, channel_id, author_workspace_member_id, parent_message_id, body,
         client_submission_id
       )
       SELECT $1, c.workspace_id, c.id, member.id, $5, $6, $7
       FROM public.channel c
       JOIN public.project_membership pm ON pm.project_id = c.project_id
       JOIN public.workspace_member member ON member.id = pm.workspace_member_id
       JOIN public.workspace_membership wm ON wm.id = member.pilot_membership_id
       LEFT JOIN public.message parent
         ON parent.id = $5 AND parent.channel_id = c.id
       WHERE c.id = $2
         AND c.workspace_id = $3
         AND wm.id = $4
         AND wm.revoked_at IS NULL
         AND ($5::text IS NULL OR (parent.id IS NOT NULL AND parent.parent_message_id IS NULL))
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        messageId,
        input.channelId,
        access.workspace.id,
        access.membership.id,
        parentMessageId,
        body,
        submissionId
      ]
    );
    let storedMessageId = inserted.rows[0]?.id;
    if (!storedMessageId) {
      const duplicate = await client.query<{ id: string }>(
        `SELECT message.id
         FROM public.message message
         JOIN public.workspace_member author
           ON author.id = message.author_workspace_member_id
         WHERE message.workspace_id = $1
           AND author.pilot_membership_id = $2
           AND message.client_submission_id = $3`,
        [access.workspace.id, access.membership.id, submissionId]
      );
      storedMessageId = duplicate.rows[0]?.id;
    }
    if (!storedMessageId) {
      throw new ChannelMessageError(
        parentMessageId
          ? 'a reply must reply directly to a channel root'
          : 'active Project membership is required to post in this Channel'
      );
    }
    if (storedMessageId === messageId) {
      await client.query(
        `INSERT INTO public.notification_outbox (
           workspace_id, message_id, topic, payload
         ) VALUES ($1, $2, 'channel.message', $3)`,
        [access.workspace.id, messageId, { messageId }]
      );
      const agentProgressAnswered = await answerAgentProgressRequest(client, {
        messageId,
        workspaceId: access.workspace.id,
        channelId: input.channelId,
        parentMessageId,
        body
      });
      const agentRunCommandHandled = !agentProgressAnswered && parentMessageId
        ? await handleAgentRunCommand(client, {
            messageId,
            workspaceId: access.workspace.id,
            channelId: input.channelId,
            parentMessageId,
            body
          })
        : false;
      const approvalAnswered = !agentProgressAnswered && !agentRunCommandHandled && parentMessageId
        ? await handleApprovalReply(client, {
            messageId,
            workspaceId: access.workspace.id,
            channelId: input.channelId,
            parentMessageId,
            body
          })
        : false;
      const waitingAgentRunReply = !agentProgressAnswered && !agentRunCommandHandled
        && !approvalAnswered && parentMessageId
        ? await handleWaitingAgentRunReply(client, {
            messageId,
            workspaceId: access.workspace.id,
            channelId: input.channelId,
            parentMessageId,
            body
          })
        : false;
      if (!agentProgressAnswered && !agentRunCommandHandled
        && !approvalAnswered && !waitingAgentRunReply) {
        const conversation = await acceptAgentConversation(client, {
          messageId,
          workspaceId: access.workspace.id,
          channelId: input.channelId,
          parentMessageId,
          body
        });
        if (!conversation) {
          await acceptEligibleAgentMention(client, {
            messageId,
            workspaceId: access.workspace.id,
            channelId: input.channelId,
            body,
            getRepositoryGateway: dependencies.getRepositoryGateway
          });
        }
      }
    }
    const row = await readMessage(client, storedMessageId);
    if (!row) throw new Error('committed Channel Message could not be loaded');
    await client.query('COMMIT');
    return toChannelMessage(row);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
