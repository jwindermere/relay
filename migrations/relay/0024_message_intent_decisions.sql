CREATE TABLE public.message_intent_decision (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  message_id text NOT NULL,
  selected_intent text NOT NULL CHECK (selected_intent IN (
    'ordinary_communication', 'conversation', 'research_request',
    'engineering_delegation', 'progress_request', 'human_authority_decision',
    'coordination_candidate'
  )),
  target_agent_id text,
  confidence numeric(4, 3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  policy_version text NOT NULL CHECK (length(trim(policy_version)) BETWEEN 1 AND 80),
  rationale text NOT NULL CHECK (length(trim(rationale)) BETWEEN 1 AND 500),
  corrected_intent text CHECK (corrected_intent IN (
    'ordinary_communication', 'conversation', 'research_request',
    'engineering_delegation', 'progress_request', 'human_authority_decision',
    'coordination_candidate'
  )),
  corrected_target_agent_id text,
  corrected_by_workspace_member_id text,
  corrected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (project_id, workspace_id)
    REFERENCES public.project(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (message_id, workspace_id)
    REFERENCES public.message(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (target_agent_id, workspace_id)
    REFERENCES public.agent(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (corrected_target_agent_id, workspace_id)
    REFERENCES public.agent(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (corrected_by_workspace_member_id, workspace_id)
    REFERENCES public.workspace_member(id, workspace_id) ON DELETE RESTRICT,
  CHECK (
    (corrected_at IS NULL AND corrected_intent IS NULL
      AND corrected_target_agent_id IS NULL AND corrected_by_workspace_member_id IS NULL)
    OR (corrected_at IS NOT NULL AND corrected_intent IS NOT NULL
      AND corrected_by_workspace_member_id IS NOT NULL)
  )
);

CREATE INDEX message_intent_decision_project_idx
  ON public.message_intent_decision(workspace_id, project_id, created_at, id);
