ALTER TABLE public.notification_outbox
  DROP CONSTRAINT notification_outbox_subject_check,
  ADD COLUMN agent_handoff_id text,
  ADD CONSTRAINT notification_outbox_agent_handoff_workspace_fkey
    FOREIGN KEY (agent_handoff_id, workspace_id)
    REFERENCES public.agent_handoff(id, workspace_id) ON DELETE CASCADE,
  ADD CONSTRAINT notification_outbox_subject_check CHECK (
    (agent_run_event_id IS NOT NULL)::integer
      + (message_id IS NOT NULL)::integer
      + (channel_call_id IS NOT NULL)::integer
      + (agent_handoff_id IS NOT NULL)::integer = 1
  );

CREATE INDEX notification_outbox_agent_handoff_idx
  ON public.notification_outbox(agent_handoff_id)
  WHERE agent_handoff_id IS NOT NULL;
