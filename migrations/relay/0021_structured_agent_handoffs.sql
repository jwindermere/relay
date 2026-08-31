CREATE TABLE public.agent_handoff (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  originating_pilot_member_id text NOT NULL,
  source_agent_id text NOT NULL,
  target_agent_id text NOT NULL,
  source_message_id text NOT NULL UNIQUE,
  source_task_id text,
  receiving_turn_id text NOT NULL UNIQUE,
  question text NOT NULL CHECK (length(trim(question)) BETWEEN 1 AND 4000),
  context_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  artifact_references jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(artifact_references) = 'array'),
  expected_response_shape text NOT NULL DEFAULT 'concise_text'
    CHECK (expected_response_shape IN ('concise_text', 'structured_finding')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'working', 'completed', 'failed', 'cancelled', 'expired')),
  result_message_id text UNIQUE,
  error_code text,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  expired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id)
    REFERENCES public.project(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (originating_pilot_member_id, workspace_id)
    REFERENCES public.workspace_member(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_agent_id, workspace_id)
    REFERENCES public.agent(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (target_agent_id, workspace_id)
    REFERENCES public.agent(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_message_id, workspace_id)
    REFERENCES public.message(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_task_id, workspace_id)
    REFERENCES public.task(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (receiving_turn_id, workspace_id)
    REFERENCES public.agent_conversation_turn(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (result_message_id, workspace_id)
    REFERENCES public.message(id, workspace_id) ON DELETE RESTRICT,
  CHECK (source_agent_id <> target_agent_id),
  CHECK (
    (status = 'queued' AND started_at IS NULL AND completed_at IS NULL
      AND cancelled_at IS NULL AND expired_at IS NULL AND result_message_id IS NULL)
    OR (status = 'working' AND started_at IS NOT NULL AND completed_at IS NULL
      AND cancelled_at IS NULL AND expired_at IS NULL AND result_message_id IS NULL)
    OR (status IN ('completed', 'failed') AND started_at IS NOT NULL
      AND completed_at IS NOT NULL AND cancelled_at IS NULL AND expired_at IS NULL)
    OR (status = 'cancelled' AND completed_at IS NULL
      AND cancelled_at IS NOT NULL AND expired_at IS NULL AND result_message_id IS NULL)
    OR (status = 'expired' AND completed_at IS NULL
      AND cancelled_at IS NULL AND expired_at IS NOT NULL AND result_message_id IS NULL)
  ),
  CHECK (status <> 'completed' OR result_message_id IS NOT NULL),
  UNIQUE (id, workspace_id)
);

CREATE INDEX agent_handoff_channel_projection_idx
  ON public.agent_handoff(workspace_id, project_id, created_at, id);

CREATE INDEX agent_handoff_expiry_idx
  ON public.agent_handoff(expires_at, id)
  WHERE status = 'queued';
