CREATE TABLE public.approval (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace (id) ON DELETE RESTRICT,
  agent_run_id text NOT NULL,
  provider_request_id text NOT NULL,
  provider_thread_id text NOT NULL,
  provider_turn_id text NOT NULL,
  provider_item_id text NOT NULL,
  action_kind text NOT NULL CHECK (action_kind IN ('command', 'file_change', 'permissions')),
  scope_hash text NOT NULL CHECK (scope_hash ~ '^[a-f0-9]{64}$'),
  decision_code text NOT NULL CHECK (decision_code ~ '^[a-f0-9]{8}$'),
  summary text NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 200),
  requester_workspace_member_id text NOT NULL,
  request_message_id text NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'approved', 'denied', 'consumed', 'expired')),
  decision_message_id text,
  decided_by_workspace_member_id text,
  decided_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (agent_run_id, workspace_id)
    REFERENCES public.agent_run (id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (requester_workspace_member_id, workspace_id)
    REFERENCES public.workspace_member (id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (request_message_id, workspace_id)
    REFERENCES public.message (id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (decision_message_id, workspace_id)
    REFERENCES public.message (id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (decided_by_workspace_member_id, workspace_id)
    REFERENCES public.workspace_member (id, workspace_id) ON DELETE RESTRICT,
  UNIQUE (agent_run_id, provider_request_id),
  UNIQUE (workspace_id, decision_code),
  UNIQUE (request_message_id),
  UNIQUE (decision_message_id),
  CHECK (
    (state = 'pending'
      AND decision_message_id IS NULL AND decided_by_workspace_member_id IS NULL
      AND decided_at IS NULL AND consumed_at IS NULL)
    OR (state IN ('approved', 'denied')
      AND decision_message_id IS NOT NULL AND decided_by_workspace_member_id IS NOT NULL
      AND decided_at IS NOT NULL AND consumed_at IS NULL)
    OR (state = 'consumed'
      AND decision_message_id IS NOT NULL AND decided_by_workspace_member_id IS NOT NULL
      AND decided_at IS NOT NULL AND consumed_at IS NOT NULL)
    OR (state = 'expired' AND consumed_at IS NULL)
  )
);

CREATE UNIQUE INDEX agent_run_one_pending_approval_idx
  ON public.approval (agent_run_id)
  WHERE state IN ('pending', 'approved');
