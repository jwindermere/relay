ALTER TABLE public.message
  ADD COLUMN client_submission_id text CHECK (
    client_submission_id IS NULL OR length(trim(client_submission_id)) BETWEEN 1 AND 200
  ),
  ADD COLUMN agent_mention_status text NOT NULL DEFAULT 'communication'
    CHECK (agent_mention_status IN ('communication', 'accepted', 'rejected')),
  ADD COLUMN mentioned_agent_id text,
  ADD COLUMN agent_mention_reason text,
  ADD CONSTRAINT message_mentioned_agent_workspace_fkey
    FOREIGN KEY (mentioned_agent_id, workspace_id)
    REFERENCES public.agent (id, workspace_id) ON DELETE RESTRICT,
  ADD CONSTRAINT message_agent_mention_result_check CHECK (
    (agent_mention_status = 'communication'
      AND mentioned_agent_id IS NULL AND agent_mention_reason IS NULL)
    OR (agent_mention_status = 'accepted'
      AND mentioned_agent_id IS NOT NULL AND agent_mention_reason IS NULL)
    OR (agent_mention_status = 'rejected'
      AND mentioned_agent_id IS NOT NULL AND agent_mention_reason IS NOT NULL)
  );

ALTER TABLE public.message
  ADD CONSTRAINT message_id_workspace_key UNIQUE (id, workspace_id);

CREATE UNIQUE INDEX message_submission_idempotency_idx
  ON public.message (workspace_id, author_workspace_member_id, client_submission_id)
  WHERE client_submission_id IS NOT NULL;

ALTER TABLE public.provider_connection
  ADD CONSTRAINT provider_connection_id_workspace_key UNIQUE (id, workspace_id);

ALTER TABLE public.linked_repository
  ADD CONSTRAINT linked_repository_id_workspace_key UNIQUE (id, workspace_id);

CREATE TABLE public.task (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace (id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  assigned_agent_id text NOT NULL,
  source_message_id text NOT NULL UNIQUE,
  requested_by_workspace_member_id text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
  request_snapshot text NOT NULL CHECK (length(trim(request_snapshot)) BETWEEN 1 AND 4000),
  context_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id)
    REFERENCES public.project (id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (assigned_agent_id, workspace_id)
    REFERENCES public.agent (id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_message_id, workspace_id)
    REFERENCES public.message (id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (requested_by_workspace_member_id, workspace_id)
    REFERENCES public.workspace_member (id, workspace_id) ON DELETE RESTRICT,
  UNIQUE (id, workspace_id)
);

CREATE TABLE public.agent_run (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace (id) ON DELETE RESTRICT,
  task_id text NOT NULL,
  agent_id text NOT NULL,
  provider_connection_id text NOT NULL,
  linked_repository_id text NOT NULL,
  attempt_number integer NOT NULL DEFAULT 1 CHECK (attempt_number > 0),
  status text NOT NULL CHECK (status IN (
    'queued', 'planning', 'working', 'waiting_for_input', 'waiting_for_approval',
    'recovering', 'paused', 'completed', 'failed', 'cancelled'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (task_id, workspace_id)
    REFERENCES public.task (id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id, workspace_id)
    REFERENCES public.agent (id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_connection_id, workspace_id)
    REFERENCES public.provider_connection (id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (linked_repository_id, workspace_id)
    REFERENCES public.linked_repository (id, workspace_id) ON DELETE RESTRICT,
  UNIQUE (task_id, attempt_number),
  UNIQUE (id, workspace_id)
);

CREATE INDEX agent_run_queue_idx
  ON public.agent_run (status, created_at, id) WHERE status = 'queued';

CREATE TABLE public.agent_run_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace (id) ON DELETE RESTRICT,
  agent_run_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL,
  status text NOT NULL,
  summary text NOT NULL CHECK (length(trim(summary)) > 0),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (agent_run_id, workspace_id)
    REFERENCES public.agent_run (id, workspace_id) ON DELETE RESTRICT,
  UNIQUE (agent_run_id, sequence),
  UNIQUE (id, workspace_id)
);

CREATE TABLE public.notification_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  agent_run_event_id bigint NOT NULL UNIQUE,
  topic text NOT NULL,
  payload jsonb NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (agent_run_event_id, workspace_id)
    REFERENCES public.agent_run_event (id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX notification_outbox_pending_idx
  ON public.notification_outbox (available_at, id) WHERE published_at IS NULL;
