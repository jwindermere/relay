ALTER TABLE public.agent
  ADD COLUMN agent_type text NOT NULL DEFAULT 'engineering'
    CHECK (agent_type IN ('engineering', 'research', 'product', 'support', 'general')),
  ADD COLUMN instructions text NOT NULL DEFAULT '' CHECK (length(instructions) <= 4000),
  ADD COLUMN participation_mode text NOT NULL DEFAULT 'ambient'
    CHECK (participation_mode IN ('reactive', 'ambient')),
  ADD COLUMN ambient_triggers text[] NOT NULL
    DEFAULT ARRAY['code', 'engineering', 'repository', 'github', 'bug', 'test'],
  ADD COLUMN reply_mode text NOT NULL DEFAULT 'adaptive'
    CHECK (reply_mode IN ('adaptive', 'channel', 'thread'));

CREATE UNIQUE INDEX agent_workspace_name_unique_idx
  ON public.agent (workspace_id, lower(name));

ALTER TABLE public.agent_conversation_turn
  ADD COLUMN response_placement text NOT NULL DEFAULT 'thread'
    CHECK (response_placement IN ('channel', 'thread')),
  ADD COLUMN response_parent_message_id text,
  ADD COLUMN ambient boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT agent_conversation_turn_response_parent_fk
    FOREIGN KEY (response_parent_message_id, workspace_id)
    REFERENCES public.message(id, workspace_id) ON DELETE RESTRICT;
