import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import type { WorkspaceAccess } from '../authentication/authorization.js';
import { buildJitsiMeetingUrl } from '../configuration.js';

export class ChannelCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelCallError';
  }
}

export interface ActiveChannelCall {
  id: string;
  url: string;
  startedAt: string;
  startedBy: { id: string; name: string };
  participants: Array<{ id: string; name: string }>;
  canEnd: boolean;
}

interface CallRow {
  id: string;
  room_name: string;
  started_at: Date;
  started_by_workspace_member_id: string;
  starter_name: string;
}

async function loadViewerChannel(
  client: Pool | PoolClient,
  access: WorkspaceAccess,
  channelId: string,
  lock = false
): Promise<{ workspaceMemberId: string }> {
  const result = await client.query<{ workspace_member_id: string }>(
    `SELECT member.id AS workspace_member_id
     FROM public.channel channel
     JOIN public.project_membership project_member
       ON project_member.project_id = channel.project_id
      AND project_member.workspace_id = channel.workspace_id
     JOIN public.workspace_member member
       ON member.id = project_member.workspace_member_id
      AND member.workspace_id = project_member.workspace_id
     JOIN public.workspace_membership pilot
       ON pilot.id = member.pilot_membership_id
      AND pilot.workspace_id = member.workspace_id
     WHERE channel.id = $1
       AND channel.workspace_id = $2
       AND pilot.id = $3
       AND pilot.user_id = $4
       AND pilot.revoked_at IS NULL
     ${lock ? 'FOR UPDATE OF channel' : ''}`,
    [channelId, access.workspace.id, access.membership.id, access.identity.userId]
  );
  const viewer = result.rows[0];
  if (!viewer) throw new ChannelCallError('Channel access is required');
  return { workspaceMemberId: viewer.workspace_member_id };
}

async function serializeCall(
  client: Pool | PoolClient,
  access: WorkspaceAccess,
  row: CallRow,
  viewerWorkspaceMemberId: string
): Promise<ActiveChannelCall> {
  const participants = await client.query<{ id: string; name: string }>(
    `SELECT member.id, COALESCE(pilot_user.name, agent.name) AS name
     FROM public.channel_call_participant participant
     JOIN public.workspace_member member
       ON member.id = participant.workspace_member_id
      AND member.workspace_id = participant.workspace_id
     LEFT JOIN public.workspace_membership pilot ON pilot.id = member.pilot_membership_id
     LEFT JOIN auth."user" pilot_user ON pilot_user.id = pilot.user_id
     LEFT JOIN public.agent agent ON agent.id = member.agent_id
     WHERE participant.channel_call_id = $1 AND participant.workspace_id = $2
     ORDER BY participant.first_joined_at, member.id`,
    [row.id, access.workspace.id]
  );
  return {
    id: row.id,
    url: buildJitsiMeetingUrl(row.room_name),
    startedAt: row.started_at.toISOString(),
    startedBy: { id: row.started_by_workspace_member_id, name: row.starter_name },
    participants: participants.rows,
    canEnd: access.membership.role === 'owner'
      || row.started_by_workspace_member_id === viewerWorkspaceMemberId
  };
}

async function readActiveCall(
  client: Pool | PoolClient,
  access: WorkspaceAccess,
  channelId: string,
  viewerWorkspaceMemberId: string
): Promise<ActiveChannelCall | null> {
  const result = await client.query<CallRow>(
    `SELECT call.id, call.room_name, call.started_at,
            call.started_by_workspace_member_id,
            COALESCE(starter_user.name, starter_agent.name) AS starter_name
     FROM public.channel_call call
     JOIN public.workspace_member starter
       ON starter.id = call.started_by_workspace_member_id
      AND starter.workspace_id = call.workspace_id
     LEFT JOIN public.workspace_membership starter_pilot ON starter_pilot.id = starter.pilot_membership_id
     LEFT JOIN auth."user" starter_user ON starter_user.id = starter_pilot.user_id
     LEFT JOIN public.agent starter_agent ON starter_agent.id = starter.agent_id
     WHERE call.workspace_id = $1 AND call.channel_id = $2 AND call.status = 'active'`,
    [access.workspace.id, channelId]
  );
  return result.rows[0]
    ? serializeCall(client, access, result.rows[0], viewerWorkspaceMemberId)
    : null;
}

export async function loadActiveChannelCall(
  pool: Pool,
  access: WorkspaceAccess,
  channelId: string
): Promise<ActiveChannelCall | null> {
  const viewer = await loadViewerChannel(pool, access, channelId);
  return readActiveCall(pool, access, channelId, viewer.workspaceMemberId);
}

async function recordParticipation(
  client: PoolClient,
  access: WorkspaceAccess,
  callId: string,
  workspaceMemberId: string
): Promise<void> {
  await client.query(
    `INSERT INTO public.channel_call_participant (
       workspace_id, channel_call_id, workspace_member_id
     ) VALUES ($1, $2, $3)
     ON CONFLICT (channel_call_id, workspace_member_id) DO UPDATE
       SET last_joined_at = now(), join_count = channel_call_participant.join_count + 1`,
    [access.workspace.id, callId, workspaceMemberId]
  );
}

async function publishCallChange(
  client: PoolClient,
  access: WorkspaceAccess,
  callId: string,
  event: string
): Promise<void> {
  await client.query(
    `INSERT INTO public.notification_outbox (workspace_id, channel_call_id, topic, payload)
     VALUES ($1, $2, 'channel.call', jsonb_build_object('event', $3::text))`,
    [access.workspace.id, callId, event]
  );
  await client.query(
    `INSERT INTO public.audit_event (
       workspace_id, actor_user_id, actor_membership_id,
       event_type, subject_type, subject_id
     ) VALUES ($1, $2, $3, $4, 'channel_call', $5)`,
    [access.workspace.id, access.identity.userId, access.membership.id, event, callId]
  );
}

export async function startChannelCall(
  pool: Pool,
  access: WorkspaceAccess,
  channelId: string
): Promise<ActiveChannelCall> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const viewer = await loadViewerChannel(client, access, channelId, true);
    let call = await readActiveCall(client, access, channelId, viewer.workspaceMemberId);
    if (!call) {
      const callId = randomUUID();
      await client.query(
        `INSERT INTO public.channel_call (
           id, workspace_id, channel_id, room_name, started_by_workspace_member_id
         ) VALUES ($1, $2, $3, $4, $5)`,
        [callId, access.workspace.id, channelId, `relay-${randomUUID().replaceAll('-', '')}`, viewer.workspaceMemberId]
      );
      await recordParticipation(client, access, callId, viewer.workspaceMemberId);
      await publishCallChange(client, access, callId, 'call.started');
      call = await readActiveCall(client, access, channelId, viewer.workspaceMemberId);
    }
    await client.query('COMMIT');
    if (!call) throw new ChannelCallError('Call could not be started');
    return call;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function joinChannelCall(
  pool: Pool,
  access: WorkspaceAccess,
  channelId: string
): Promise<ActiveChannelCall> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const viewer = await loadViewerChannel(client, access, channelId, true);
    const current = await client.query<{ id: string }>(
      `SELECT id FROM public.channel_call
       WHERE workspace_id = $1 AND channel_id = $2 AND status = 'active'
       FOR UPDATE`,
      [access.workspace.id, channelId]
    );
    const callId = current.rows[0]?.id;
    if (!callId) throw new ChannelCallError('There is no active Call in this Channel');
    await recordParticipation(client, access, callId, viewer.workspaceMemberId);
    await publishCallChange(client, access, callId, 'call.joined');
    const call = await readActiveCall(client, access, channelId, viewer.workspaceMemberId);
    await client.query('COMMIT');
    if (!call) throw new ChannelCallError('There is no active Call in this Channel');
    return call;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function endChannelCall(
  pool: Pool,
  access: WorkspaceAccess,
  channelId: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const viewer = await loadViewerChannel(client, access, channelId, true);
    const current = await client.query<{ id: string; started_by_workspace_member_id: string }>(
      `SELECT id, started_by_workspace_member_id FROM public.channel_call
       WHERE workspace_id = $1 AND channel_id = $2 AND status = 'active'
       FOR UPDATE`,
      [access.workspace.id, channelId]
    );
    const call = current.rows[0];
    if (!call) throw new ChannelCallError('There is no active Call in this Channel');
    if (access.membership.role !== 'owner' && call.started_by_workspace_member_id !== viewer.workspaceMemberId) {
      throw new ChannelCallError('Only the Call starter or a Workspace owner can end this Call');
    }
    await client.query(
      `UPDATE public.channel_call SET status = 'ended', ended_at = now()
       WHERE id = $1 AND workspace_id = $2`,
      [call.id, access.workspace.id]
    );
    await publishCallChange(client, access, call.id, 'call.ended');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
