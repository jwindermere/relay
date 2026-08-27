import type { Notification, Pool } from 'pg';

const CHANNEL_WAKE_CHANNEL = 'relay_channel_wake';

export interface ChannelWakeup {
  channelId: string;
  workspaceId: string;
}

interface WakeupRow {
  outbox_id: string;
  workspace_id: string;
  channel_id: string;
}

export async function subscribeToChannelWakeups(
  pool: Pool,
  onWakeup: (wakeup: ChannelWakeup) => Promise<void>
): Promise<() => Promise<void>> {
  const client = await pool.connect();
  let delivery = Promise.resolve();

  const drain = async () => {
    const pending = await pool.query<WakeupRow>(
      `SELECT outbox.id::text AS outbox_id, outbox.workspace_id,
              COALESCE(channel_message.channel_id, source_message.channel_id, channel_call.channel_id) AS channel_id
       FROM public.notification_outbox outbox
       LEFT JOIN public.message channel_message ON channel_message.id = outbox.message_id
       LEFT JOIN public.agent_run_event event ON event.id = outbox.agent_run_event_id
       LEFT JOIN public.agent_run run ON run.id = event.agent_run_id
       LEFT JOIN public.task task ON task.id = run.task_id
       LEFT JOIN public.message source_message ON source_message.id = task.source_message_id
       LEFT JOIN public.channel_call channel_call ON channel_call.id = outbox.channel_call_id
       WHERE outbox.topic IN ('channel.message', 'agent_run.event', 'channel.call')
         AND outbox.published_at IS NULL
       ORDER BY outbox.id`,
      []
    );
    for (const wakeup of pending.rows) {
      await onWakeup({
        channelId: wakeup.channel_id,
        workspaceId: wakeup.workspace_id
      });
      await pool.query(
        `UPDATE public.notification_outbox
         SET published_at = COALESCE(published_at, now()), attempts = attempts + 1
         WHERE id = $1`,
        [wakeup.outbox_id]
      );
    }
  };
  const queueDrain = () => {
    delivery = delivery.then(() => drain()).catch(() => undefined);
  };
  const onNotification = ({ channel, payload }: Notification) => {
    if (channel !== CHANNEL_WAKE_CHANNEL || !payload || !/^\d+$/.test(payload)) return;
    queueDrain();
  };

  client.on('notification', onNotification);
  await client.query(`LISTEN ${CHANNEL_WAKE_CHANNEL}`);
  queueDrain();
  await delivery;

  return async () => {
    client.removeListener('notification', onNotification);
    await client.query(`UNLISTEN ${CHANNEL_WAKE_CHANNEL}`);
    await delivery;
    client.release();
  };
}
