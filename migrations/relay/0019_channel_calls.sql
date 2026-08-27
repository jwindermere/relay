CREATE TABLE public.channel_call (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  channel_id text NOT NULL,
  room_name text NOT NULL CHECK (room_name ~ '^[a-zA-Z0-9_-]{16,200}$'),
  started_by_workspace_member_id text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  FOREIGN KEY (channel_id, workspace_id)
    REFERENCES public.channel (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (started_by_workspace_member_id, workspace_id)
    REFERENCES public.workspace_member (id, workspace_id) ON DELETE RESTRICT,
  UNIQUE (id, workspace_id),
  UNIQUE (workspace_id, room_name),
  CHECK ((status = 'active' AND ended_at IS NULL) OR (status = 'ended' AND ended_at IS NOT NULL))
);

CREATE UNIQUE INDEX channel_call_one_active_per_channel_idx
  ON public.channel_call (channel_id) WHERE status = 'active';

CREATE INDEX channel_call_channel_time_idx
  ON public.channel_call (channel_id, started_at DESC, id);

CREATE TABLE public.channel_call_participant (
  workspace_id text NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  channel_call_id text NOT NULL,
  workspace_member_id text NOT NULL,
  first_joined_at timestamptz NOT NULL DEFAULT now(),
  last_joined_at timestamptz NOT NULL DEFAULT now(),
  join_count integer NOT NULL DEFAULT 1 CHECK (join_count > 0),
  FOREIGN KEY (channel_call_id, workspace_id)
    REFERENCES public.channel_call (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_member_id, workspace_id)
    REFERENCES public.workspace_member (id, workspace_id) ON DELETE RESTRICT,
  PRIMARY KEY (channel_call_id, workspace_member_id),
  CHECK (last_joined_at >= first_joined_at)
);

ALTER TABLE public.notification_outbox
  DROP CONSTRAINT notification_outbox_subject_check,
  ADD COLUMN channel_call_id text,
  ADD CONSTRAINT notification_outbox_channel_call_workspace_fkey
    FOREIGN KEY (channel_call_id, workspace_id)
    REFERENCES public.channel_call (id, workspace_id) ON DELETE CASCADE,
  ADD CONSTRAINT notification_outbox_subject_check CHECK (
    (agent_run_event_id IS NOT NULL)::integer
      + (message_id IS NOT NULL)::integer
      + (channel_call_id IS NOT NULL)::integer = 1
  );

CREATE INDEX notification_outbox_channel_call_idx
  ON public.notification_outbox (channel_call_id)
  WHERE channel_call_id IS NOT NULL;
