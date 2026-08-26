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
    membershipId: string;
    name: string;
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
  author_membership_id: string;
  author_name: string;
}

function toChannelMessage(row: MessageRow): ChannelMessage {
  return {
    id: row.id,
    parentMessageId: row.parent_message_id,
    body: row.body,
    createdAt: row.created_at.toISOString(),
    author: {
      membershipId: row.author_membership_id,
      name: row.author_name
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
     JOIN public.workspace_membership wm ON wm.id = pm.workspace_membership_id
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
      `SELECT member.id, member.kind, member.name, member.role_label, member.status
       FROM (
         SELECT wm.id, 'pilot'::text AS kind, u.name,
                'Pilot member'::text AS role_label, 'online'::text AS status
         FROM public.project_membership pm
         JOIN public.workspace_membership wm ON wm.id = pm.workspace_membership_id
         JOIN auth."user" u ON u.id = wm.user_id
         WHERE pm.project_id = $1 AND wm.revoked_at IS NULL
         UNION ALL
         SELECT a.id, 'agent'::text, a.name, a.role_label, a.status
         FROM public.project_membership pm
         JOIN public.agent a ON a.id = pm.agent_id
         WHERE pm.project_id = $1
       ) member
       ORDER BY member.name, member.id`,
      [selected.project_id]
    ),
    pool.query<MessageRow>(
      `SELECT m.id, m.parent_message_id, m.body, m.created_at,
              wm.id AS author_membership_id, u.name AS author_name
       FROM public.message m
       JOIN public.workspace_membership wm ON wm.id = m.author_membership_id
       JOIN auth."user" u ON u.id = wm.user_id
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
         id, workspace_id, channel_id, author_membership_id, parent_message_id, body
       )
       SELECT $1, c.workspace_id, c.id, wm.id, $5, $6
     FROM public.channel c
     JOIN public.project_membership pm ON pm.project_id = c.project_id
     JOIN public.workspace_membership wm ON wm.id = pm.workspace_membership_id
     LEFT JOIN public.message parent
       ON parent.id = $5 AND parent.channel_id = c.id
     WHERE c.id = $2
       AND c.workspace_id = $3
       AND wm.id = $4
       AND wm.revoked_at IS NULL
       AND ($5::text IS NULL OR (parent.id IS NOT NULL AND parent.parent_message_id IS NULL))
       RETURNING id, parent_message_id, body, created_at, author_membership_id
     )
     SELECT inserted.*, author.name AS author_name
     FROM inserted
     JOIN public.workspace_membership membership
       ON membership.id = inserted.author_membership_id
     JOIN auth."user" author ON author.id = membership.user_id`,
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
