ALTER TABLE public.message
  DROP CONSTRAINT message_agent_mention_status_check,
  DROP CONSTRAINT message_agent_mention_result_check;

ALTER TABLE public.message
  ADD CONSTRAINT message_agent_mention_status_check
    CHECK (agent_mention_status IN ('communication', 'conversation', 'accepted', 'rejected')),
  ADD CONSTRAINT message_agent_mention_result_check CHECK (
    (agent_mention_status = 'communication'
      AND mentioned_agent_id IS NULL AND agent_mention_reason IS NULL)
    OR (agent_mention_status IN ('conversation', 'accepted')
      AND mentioned_agent_id IS NOT NULL AND agent_mention_reason IS NULL)
    OR (agent_mention_status = 'rejected'
      AND mentioned_agent_id IS NOT NULL AND agent_mention_reason IS NOT NULL)
  );

CREATE TABLE public.agent_conversation (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace(id) ON DELETE RESTRICT,
  channel_id text NOT NULL,
  root_message_id text NOT NULL,
  agent_id text NOT NULL,
  provider_connection_id text NOT NULL,
  provider_thread_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (channel_id, workspace_id)
    REFERENCES public.channel(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (root_message_id, channel_id, workspace_id)
    REFERENCES public.message(id, channel_id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id, workspace_id)
    REFERENCES public.agent(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_connection_id, workspace_id)
    REFERENCES public.provider_connection(id, workspace_id) ON DELETE RESTRICT,
  UNIQUE (root_message_id, agent_id),
  UNIQUE (id, workspace_id)
);

CREATE TABLE public.agent_conversation_turn (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace(id) ON DELETE RESTRICT,
  conversation_id text NOT NULL,
  request_message_id text NOT NULL UNIQUE,
  requested_by_workspace_member_id text NOT NULL,
  response_message_id text UNIQUE,
  status text NOT NULL CHECK (status IN ('queued', 'working', 'completed', 'failed')),
  provider_turn_id text,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_token text,
  lease_expires_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id, workspace_id)
    REFERENCES public.agent_conversation(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (request_message_id, workspace_id)
    REFERENCES public.message(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (requested_by_workspace_member_id, workspace_id)
    REFERENCES public.workspace_member(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (response_message_id, workspace_id)
    REFERENCES public.message(id, workspace_id) ON DELETE RESTRICT,
  UNIQUE (id, workspace_id)
);

CREATE INDEX agent_conversation_turn_queue_idx
  ON public.agent_conversation_turn(status, available_at, created_at, id)
  WHERE status = 'queued';
