ALTER TABLE public.notification_outbox
  DROP CONSTRAINT notification_outbox_message_id_key;

CREATE INDEX notification_outbox_message_idx
  ON public.notification_outbox (message_id)
  WHERE message_id IS NOT NULL;
