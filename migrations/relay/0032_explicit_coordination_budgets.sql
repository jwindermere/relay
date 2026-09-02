ALTER TABLE public.provider_connection
  ADD COLUMN coordination_provider_usage_limit numeric
    CHECK (coordination_provider_usage_limit IS NULL OR coordination_provider_usage_limit >= 0);

ALTER TABLE public.workspace_coordination_policy
  ADD COLUMN parallel_permitted boolean NOT NULL DEFAULT true;

ALTER TABLE public.coordination_plan
  ADD COLUMN budget_stop_reason text CHECK (budget_stop_reason IN (
    'handoff_limit', 'agent_run_limit', 'elapsed_time_limit',
    'provider_usage_limit'
  )),
  ADD COLUMN budget_notice_message_id text,
  ADD CONSTRAINT coordination_plan_budget_notice_workspace_fkey
    FOREIGN KEY (budget_notice_message_id, workspace_id)
    REFERENCES public.message(id, workspace_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX coordination_plan_budget_notice_unique_idx
  ON public.coordination_plan(budget_notice_message_id)
  WHERE budget_notice_message_id IS NOT NULL;

ALTER TABLE public.coordination_budget_reservation
  DROP CONSTRAINT coordination_budget_reservation_outcome_check,
  ADD CONSTRAINT coordination_budget_reservation_outcome_check
    CHECK (outcome IN (
      'reserved', 'started', 'failed_start', 'failed', 'cancelled', 'completed'
    ));

INSERT INTO public.audit_event (
  workspace_id, event_type, subject_type, subject_id, evidence
)
SELECT workspace_id, 'coordination_plan.parallel_disabled_for_provider_budget',
       'coordination_plan', id,
       jsonb_build_object('allowParallelBefore', true, 'allowParallelAfter', false,
                          'reason', 'provider usage cannot be reserved before a step')
FROM public.coordination_plan
WHERE allow_parallel AND provider_usage_limit IS NOT NULL;

UPDATE public.coordination_plan
SET allow_parallel = false, updated_at = now()
WHERE allow_parallel AND provider_usage_limit IS NOT NULL;

CREATE FUNCTION public.protect_approved_coordination_budget() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'proposed' AND (
    NEW.max_participants IS DISTINCT FROM OLD.max_participants
    OR NEW.max_handoffs IS DISTINCT FROM OLD.max_handoffs
    OR NEW.max_depth IS DISTINCT FROM OLD.max_depth
    OR NEW.max_agent_runs IS DISTINCT FROM OLD.max_agent_runs
    OR NEW.max_elapsed_seconds IS DISTINCT FROM OLD.max_elapsed_seconds
    OR NEW.provider_usage_limit IS DISTINCT FROM OLD.provider_usage_limit
    OR NEW.allow_parallel IS DISTINCT FROM OLD.allow_parallel
  ) THEN
    RAISE EXCEPTION 'approved coordination budgets are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER coordination_plan_budget_before_update
BEFORE UPDATE ON public.coordination_plan
FOR EACH ROW EXECUTE FUNCTION public.protect_approved_coordination_budget();

CREATE FUNCTION public.protect_coordination_reservation_accounting() RETURNS trigger AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
    OR NEW.step_id IS DISTINCT FROM OLD.step_id
    OR NEW.reservation_kind IS DISTINCT FROM OLD.reservation_kind
    OR NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'coordination reservation consumption is immutable';
  END IF;
  IF NEW.outcome IS DISTINCT FROM OLD.outcome AND NOT (
    OLD.outcome = 'reserved' AND NEW.outcome IN ('started', 'failed_start', 'cancelled', 'completed')
    OR OLD.outcome = 'started' AND NEW.outcome IN ('failed', 'cancelled', 'completed')
  ) THEN
    RAISE EXCEPTION 'coordination reservation outcome cannot move backwards';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER coordination_budget_reservation_before_update
BEFORE UPDATE ON public.coordination_budget_reservation
FOR EACH ROW EXECUTE FUNCTION public.protect_coordination_reservation_accounting();

CREATE TABLE public.coordination_provider_usage_record (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  plan_id text NOT NULL,
  step_id text NOT NULL,
  conversation_turn_id text NOT NULL,
  amount numeric NOT NULL CHECK (amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_turn_id),
  FOREIGN KEY (plan_id, workspace_id)
    REFERENCES public.coordination_plan(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (step_id, workspace_id)
    REFERENCES public.coordination_plan_step(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_turn_id, workspace_id)
    REFERENCES public.agent_conversation_turn(id, workspace_id) ON DELETE RESTRICT
);
