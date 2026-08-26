ALTER TABLE public.notification_outbox
  ALTER COLUMN agent_run_event_id DROP NOT NULL,
  ADD COLUMN message_id text UNIQUE,
  ADD CONSTRAINT notification_outbox_message_workspace_fkey
    FOREIGN KEY (message_id, workspace_id)
    REFERENCES public.message (id, workspace_id) ON DELETE CASCADE,
  ADD CONSTRAINT notification_outbox_subject_check CHECK (
    (agent_run_event_id IS NOT NULL)::integer + (message_id IS NOT NULL)::integer = 1
  );

CREATE FUNCTION public.notify_channel_outbox()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify('relay_channel_wake', NEW.id::text);
  RETURN NEW;
END;
$$;

CREATE TRIGGER notification_outbox_realtime_wake
AFTER INSERT ON public.notification_outbox
FOR EACH ROW EXECUTE FUNCTION public.notify_channel_outbox();
