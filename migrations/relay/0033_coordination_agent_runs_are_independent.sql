-- minimum-runtime-version: 33

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.coordination_budget_reservation
    WHERE reservation_kind = 'agent_run'
  ) THEN
    RAISE EXCEPTION 'cannot enforce a zero AgentRun limit while AgentRun reservations exist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.coordination_plan WHERE max_agent_runs <> 0
  ) THEN
    RAISE EXCEPTION 'set every Coordination plan AgentRun limit to zero through an attributable lifecycle decision before migrating';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.workspace_coordination_policy
    WHERE default_max_agent_runs <> 0
  ) THEN
    RAISE EXCEPTION 'set every Workspace Coordination policy AgentRun limit to zero through an attributable policy update before migrating';
  END IF;
END;
$$;

ALTER TABLE public.coordination_plan
  DROP CONSTRAINT coordination_plan_max_agent_runs_check,
  ADD CONSTRAINT coordination_plan_max_agent_runs_check CHECK (max_agent_runs = 0);

ALTER TABLE public.workspace_coordination_policy
  DROP CONSTRAINT workspace_coordination_policy_default_max_agent_runs_check,
  ADD CONSTRAINT workspace_coordination_policy_default_max_agent_runs_check
    CHECK (default_max_agent_runs = 0);

ALTER TABLE public.coordination_budget_reservation
  DROP CONSTRAINT coordination_budget_reservation_reservation_kind_check,
  ADD CONSTRAINT coordination_budget_reservation_reservation_kind_check
    CHECK (reservation_kind = 'handoff');

COMMENT ON COLUMN public.coordination_plan.max_agent_runs IS
  'Always zero: Coordination creates conversational turns; Engineering delegation creates independent AgentRuns.';

COMMENT ON COLUMN public.workspace_coordination_policy.default_max_agent_runs IS
  'Always zero: Engineering delegation creates AgentRuns independently of Coordination.';
