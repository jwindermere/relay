ALTER TABLE public.agent_run
  ADD COLUMN requested_by_workspace_member_id text,
  ADD COLUMN request_message_id text;

UPDATE public.agent_run run
SET requested_by_workspace_member_id = task.requested_by_workspace_member_id,
    request_message_id = task.source_message_id
FROM public.task task
WHERE task.id = run.task_id;

ALTER TABLE public.agent_run
  ALTER COLUMN requested_by_workspace_member_id SET NOT NULL,
  ALTER COLUMN request_message_id SET NOT NULL,
  ADD CONSTRAINT agent_run_requested_by_workspace_member_fkey
    FOREIGN KEY (requested_by_workspace_member_id, workspace_id)
    REFERENCES public.workspace_member (id, workspace_id) ON DELETE RESTRICT,
  ADD CONSTRAINT agent_run_request_message_fkey
    FOREIGN KEY (request_message_id, workspace_id)
    REFERENCES public.message (id, workspace_id) ON DELETE RESTRICT,
  ADD CONSTRAINT agent_run_request_message_key UNIQUE (request_message_id);

CREATE TABLE public.agent_run_cancellation_request (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace (id) ON DELETE RESTRICT,
  agent_run_id text NOT NULL,
  request_message_id text NOT NULL,
  requested_by_workspace_member_id text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (agent_run_id, workspace_id)
    REFERENCES public.agent_run (id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (request_message_id, workspace_id)
    REFERENCES public.message (id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (requested_by_workspace_member_id, workspace_id)
    REFERENCES public.workspace_member (id, workspace_id) ON DELETE RESTRICT,
  UNIQUE (request_message_id)
);

CREATE INDEX agent_run_pending_cancellation_idx
  ON public.agent_run_cancellation_request (agent_run_id, requested_at);

CREATE UNIQUE INDEX agent_run_one_terminal_event_idx
  ON public.agent_run_event (agent_run_id)
  WHERE status IN ('completed', 'failed', 'cancelled');
