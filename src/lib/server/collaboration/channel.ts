import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import type { WorkspaceAccess } from '../authentication/authorization.js';

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
}

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
    }
  };
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
      `SELECT m.id, m.parent_message_id, m.body, m.created_at,
              author.id AS author_workspace_member_id, author.kind AS author_kind,
              COALESCE(pilot_user.name, agent.name) AS author_name,
              CASE WHEN author.kind = 'pilot' THEN 'Pilot member' ELSE agent.role_label END
                AS author_role_label
       FROM public.message m
       JOIN public.workspace_member author ON author.id = m.author_workspace_member_id
       LEFT JOIN public.workspace_membership pilot ON pilot.id = author.pilot_membership_id
       LEFT JOIN auth."user" pilot_user ON pilot_user.id = pilot.user_id
       LEFT JOIN public.agent agent ON agent.id = author.agent_id
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

export async function postChannelMessage(
  pool: Pool,
  access: WorkspaceAccess,
  input: { channelId: string; body: string; parentMessageId?: string }
): Promise<ChannelMessage> {
  const body = input.body.trim();
  if (!body || body.length > 4000) {
    throw new ChannelMessageError('a Message must contain between 1 and 4000 characters');
  }

  const messageId = randomUUID();
  const parentMessageId = input.parentMessageId ?? null;
  const inserted = await pool.query<MessageRow>(
    `WITH inserted AS (
       INSERT INTO public.message (
         id, workspace_id, channel_id, author_workspace_member_id, parent_message_id, body
       )
       SELECT $1, c.workspace_id, c.id, member.id, $5, $6
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
       RETURNING id, parent_message_id, body, created_at, author_workspace_member_id
     )
     SELECT inserted.*, author.kind AS author_kind,
            COALESCE(pilot_user.name, agent.name) AS author_name,
            CASE WHEN author.kind = 'pilot' THEN 'Pilot member' ELSE agent.role_label END
              AS author_role_label
     FROM inserted
     JOIN public.workspace_member author
       ON author.id = inserted.author_workspace_member_id
     LEFT JOIN public.workspace_membership pilot ON pilot.id = author.pilot_membership_id
     LEFT JOIN auth."user" pilot_user ON pilot_user.id = pilot.user_id
     LEFT JOIN public.agent agent ON agent.id = author.agent_id`,
    [
      messageId,
      input.channelId,
      access.workspace.id,
      access.membership.id,
      parentMessageId,
      body
    ]
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new ChannelMessageError(
      parentMessageId
        ? 'a reply must reply directly to a channel root'
        : 'active Project membership is required to post in this Channel'
    );
  }
  return toChannelMessage(row);
}
