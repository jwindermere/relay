CREATE TABLE public.agent_run_clarification (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace (id) ON DELETE RESTRICT,
  agent_run_id text NOT NULL,
  provider_request_id text NOT NULL,
  provider_turn_id text NOT NULL,
  provider_item_id text NOT NULL,
  questions jsonb NOT NULL,
  request_message_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered')),
  answers jsonb,
  answer_message_id text,
  answered_by_workspace_member_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  delivery_attempted_at timestamptz,
  delivered_at timestamptz,
  FOREIGN KEY (agent_run_id, workspace_id)
    REFERENCES public.agent_run (id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (request_message_id, workspace_id)
    REFERENCES public.message (id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (answer_message_id, workspace_id)
    REFERENCES public.message (id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (answered_by_workspace_member_id, workspace_id)
    REFERENCES public.workspace_member (id, workspace_id) ON DELETE RESTRICT,
  UNIQUE (agent_run_id, provider_request_id),
  UNIQUE (request_message_id),
  UNIQUE (answer_message_id),
  CHECK (
    (status = 'pending'
      AND answers IS NULL AND answer_message_id IS NULL
      AND answered_by_workspace_member_id IS NULL AND answered_at IS NULL)
    OR (status = 'answered'
      AND answers IS NOT NULL AND answer_message_id IS NOT NULL
      AND answered_by_workspace_member_id IS NOT NULL AND answered_at IS NOT NULL)
  ),
  CHECK (delivered_at IS NULL OR delivery_attempted_at IS NOT NULL)
);

CREATE UNIQUE INDEX agent_run_one_pending_clarification_idx
  ON public.agent_run_clarification (agent_run_id)
  WHERE status = 'pending';
