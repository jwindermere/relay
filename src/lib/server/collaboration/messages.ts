import type { Pool } from 'pg';

import type { WorkspaceAccess } from '../authentication/authorization.js';

export class MessageDeletionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageDeletionError';
  }
}

export async function deleteChannelMessage(
  pool: Pool,
  access: WorkspaceAccess,
  messageId: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const target = await client.query<{
      author_workspace_member_id: string;
      actor_workspace_member_id: string;
      deleted_at: Date | null;
    }>(
      `SELECT message.author_workspace_member_id,
              actor.id AS actor_workspace_member_id, message.deleted_at
       FROM public.message message
       JOIN public.channel channel ON channel.id = message.channel_id
         AND channel.workspace_id = message.workspace_id
       JOIN public.workspace_member actor ON actor.workspace_id = message.workspace_id
         AND actor.pilot_membership_id = $3
       JOIN public.project_membership project_actor
         ON project_actor.project_id = channel.project_id
        AND project_actor.workspace_member_id = actor.id
       WHERE message.id = $1 AND message.workspace_id = $2
       FOR UPDATE OF message`,
      [messageId, access.workspace.id, access.membership.id]
    );
    const message = target.rows[0];
    if (!message) throw new MessageDeletionError('Message was not found in this Workspace');
    if (message.deleted_at) {
      await client.query('COMMIT');
      return;
    }
    if (message.author_workspace_member_id !== message.actor_workspace_member_id
      && access.membership.role !== 'owner') {
      throw new MessageDeletionError('Only the Message author or a Workspace owner can delete it');
    }

    await client.query(
      `UPDATE public.message
       SET body = 'Message deleted', deleted_at = now(),
           deleted_by_workspace_member_id = $2,
           agent_mention_status = CASE
             WHEN agent_mention_status = 'accepted' THEN 'accepted'
             ELSE 'communication'
           END,
           mentioned_agent_id = CASE
             WHEN agent_mention_status = 'accepted' THEN mentioned_agent_id
             ELSE NULL
           END,
           agent_mention_reason = NULL
       WHERE id = $1`,
      [messageId, message.actor_workspace_member_id]
    );
    await client.query(
      `UPDATE public.agent_conversation_turn
       SET status = 'failed', error_code = 'request_deleted', completed_at = now(),
           updated_at = now()
       WHERE request_message_id = $1 AND status = 'queued'`,
      [messageId]
    );
    await client.query(
      `INSERT INTO public.audit_event (
         workspace_id, actor_user_id, actor_membership_id,
         event_type, subject_type, subject_id
       ) VALUES ($1, $2, $3, 'message.deleted', 'message', $4)`,
      [access.workspace.id, access.identity.userId, access.membership.id, messageId]
    );
    await client.query(
      `INSERT INTO public.notification_outbox (workspace_id, message_id, topic, payload)
       VALUES ($1, $2, 'channel.message', $3)`,
      [access.workspace.id, messageId, { messageId }]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
