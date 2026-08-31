CREATE TABLE public.coordination_plan_constraint (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  plan_id text NOT NULL,
  source_message_id text NOT NULL UNIQUE,
  supplied_by_workspace_member_id text NOT NULL,
  guidance text NOT NULL CHECK (length(trim(guidance)) BETWEEN 1 AND 4000),
  ordinal integer NOT NULL CHECK (ordinal > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered')),
  delivery_conversation_turn_id text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, ordinal),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (project_id, workspace_id)
    REFERENCES public.project(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id, workspace_id)
    REFERENCES public.coordination_plan(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (source_message_id, workspace_id)
    REFERENCES public.message(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (supplied_by_workspace_member_id, workspace_id)
    REFERENCES public.workspace_member(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (delivery_conversation_turn_id, workspace_id)
    REFERENCES public.agent_conversation_turn(id, workspace_id) ON DELETE RESTRICT,
  CHECK (
    (status = 'pending' AND delivery_conversation_turn_id IS NULL AND delivered_at IS NULL)
    OR (status = 'delivered' AND delivery_conversation_turn_id IS NOT NULL AND delivered_at IS NOT NULL)
  )
);

CREATE INDEX coordination_plan_constraint_plan_idx
  ON public.coordination_plan_constraint(plan_id, ordinal);
