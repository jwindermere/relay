ALTER TABLE public.artifact
  ADD CONSTRAINT artifact_id_workspace_key UNIQUE (id, workspace_id);

CREATE TABLE public.agent_run_steering (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  agent_run_id text NOT NULL,
  source_message_id text NOT NULL UNIQUE,
  supplied_by_workspace_member_id text NOT NULL,
  guidance text NOT NULL CHECK (length(trim(guidance)) BETWEEN 1 AND 4000),
  ordinal integer NOT NULL CHECK (ordinal > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'cancelled')),
  provider_thread_id text,
  provider_turn_id text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_run_id, ordinal),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES public.project(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (agent_run_id, workspace_id) REFERENCES public.agent_run(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_message_id, workspace_id) REFERENCES public.message(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (supplied_by_workspace_member_id, workspace_id)
    REFERENCES public.workspace_member(id, workspace_id) ON DELETE RESTRICT,
  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL)),
  CHECK (delivered_at IS NULL OR (provider_thread_id IS NOT NULL AND provider_turn_id IS NOT NULL))
);

CREATE TABLE public.coordination_plan (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  coordinating_agent_id text NOT NULL,
  source_message_id text NOT NULL UNIQUE,
  goal text NOT NULL CHECK (length(trim(goal)) BETWEEN 1 AND 4000),
  constraints jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(constraints) = 'array'),
  allow_parallel boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN (
    'proposed', 'approved', 'active', 'paused', 'completed', 'rejected', 'cancelled', 'failed'
  )),
  max_participants integer NOT NULL CHECK (max_participants BETWEEN 1 AND 8),
  max_handoffs integer NOT NULL CHECK (max_handoffs BETWEEN 0 AND 20),
  max_depth integer NOT NULL CHECK (max_depth BETWEEN 0 AND 1),
  max_agent_runs integer NOT NULL CHECK (max_agent_runs BETWEEN 0 AND 20),
  max_elapsed_seconds integer NOT NULL CHECK (max_elapsed_seconds BETWEEN 60 AND 86400),
  provider_usage_limit numeric,
  provider_usage_consumed numeric,
  provider_usage_known boolean NOT NULL DEFAULT false,
  approved_by_workspace_member_id text,
  approved_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  synthesis_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES public.project(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (coordinating_agent_id, workspace_id) REFERENCES public.agent(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_message_id, workspace_id) REFERENCES public.message(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (synthesis_message_id, workspace_id) REFERENCES public.message(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (approved_by_workspace_member_id, workspace_id)
    REFERENCES public.workspace_member(id, workspace_id) ON DELETE RESTRICT,
  CHECK ((approved_at IS NULL) = (approved_by_workspace_member_id IS NULL)),
  CHECK (provider_usage_known OR provider_usage_consumed IS NULL)
);

CREATE TABLE public.coordination_plan_step (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  plan_id text NOT NULL,
  step_key text NOT NULL CHECK (length(trim(step_key)) BETWEEN 1 AND 80),
  position integer NOT NULL CHECK (position >= 0),
  target_agent_id text NOT NULL,
  instruction text NOT NULL CHECK (length(trim(instruction)) BETWEEN 1 AND 4000),
  expected_output text NOT NULL DEFAULT 'structured_finding'
    CHECK (expected_output IN ('concise_text', 'structured_finding', 'artifact')),
  dependencies text[] NOT NULL DEFAULT ARRAY[]::text[],
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'ready', 'active', 'completed', 'blocked', 'cancelled', 'failed'
  )),
  result_message_id text,
  artifact_id text,
  conversation_turn_id text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, step_key),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (plan_id, workspace_id) REFERENCES public.coordination_plan(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, workspace_id) REFERENCES public.project(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (target_agent_id, workspace_id) REFERENCES public.agent(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (result_message_id, workspace_id) REFERENCES public.message(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (artifact_id, workspace_id) REFERENCES public.artifact(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (conversation_turn_id, workspace_id)
    REFERENCES public.agent_conversation_turn(id, workspace_id) ON DELETE RESTRICT
);

CREATE TABLE public.coordination_budget_reservation (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  plan_id text NOT NULL,
  step_id text NOT NULL,
  reservation_kind text NOT NULL CHECK (reservation_kind IN ('handoff', 'agent_run')),
  amount integer NOT NULL DEFAULT 1 CHECK (amount > 0),
  outcome text NOT NULL DEFAULT 'reserved' CHECK (outcome IN ('reserved', 'started', 'failed_start', 'cancelled', 'completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (step_id, reservation_kind),
  FOREIGN KEY (plan_id, workspace_id) REFERENCES public.coordination_plan(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (step_id, workspace_id) REFERENCES public.coordination_plan_step(id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE public.collaboration_evaluation_event (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  event_type text NOT NULL CHECK (length(trim(event_type)) BETWEEN 1 AND 100),
  agent_id text,
  routing_policy_version text,
  prompt_version text,
  permission_policy_version text,
  agent_configuration_version text,
  outcome_type text,
  outcome_id text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id) REFERENCES public.project(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id, workspace_id) REFERENCES public.agent(id, workspace_id) ON DELETE RESTRICT
);

CREATE TABLE public.collaboration_feedback (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  submitted_by_workspace_member_id text NOT NULL,
  outcome_type text NOT NULL,
  outcome_id text NOT NULL,
  rating text NOT NULL CHECK (rating IN ('useful', 'incorrect', 'incomplete', 'unnecessarily_delegated')),
  reason text CHECK (reason IS NULL OR length(reason) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submitted_by_workspace_member_id, outcome_type, outcome_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES public.project(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (submitted_by_workspace_member_id, workspace_id)
    REFERENCES public.workspace_member(id, workspace_id) ON DELETE RESTRICT
);

CREATE INDEX steering_run_idx ON public.agent_run_steering(agent_run_id, ordinal);
CREATE INDEX coordination_plan_project_idx ON public.coordination_plan(workspace_id, project_id, created_at, id);
CREATE INDEX collaboration_evaluation_project_idx
  ON public.collaboration_evaluation_event(workspace_id, project_id, created_at, id);
