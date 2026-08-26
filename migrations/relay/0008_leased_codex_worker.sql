ALTER TABLE public.agent_run
  ADD COLUMN workspace_directory text,
  ADD COLUMN provider_thread_id text,
  ADD COLUMN active_turn_id text,
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_token text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN started_at timestamptz,
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN last_error_code text,
  ADD CONSTRAINT agent_run_lease_complete_check CHECK (
    (lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  ADD CONSTRAINT agent_run_completion_check CHECK (
    (status IN ('completed', 'failed', 'cancelled')) = (completed_at IS NOT NULL)
  );

DROP INDEX public.agent_run_queue_idx;
CREATE INDEX agent_run_queue_idx
  ON public.agent_run (available_at, created_at, id)
  WHERE status = 'queued';
CREATE INDEX agent_run_expired_lease_idx
  ON public.agent_run (lease_expires_at, created_at, id)
  WHERE lease_expires_at IS NOT NULL
    AND status NOT IN ('completed', 'failed', 'cancelled');

ALTER TABLE public.agent_run_event
  ADD COLUMN provider_event_id text,
  ADD COLUMN provider_turn_id text,
  ADD COLUMN provider_item_id text;

CREATE UNIQUE INDEX agent_run_provider_event_idempotency_idx
  ON public.agent_run_event (agent_run_id, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

CREATE FUNCTION public.preserve_terminal_agent_run()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('completed', 'failed', 'cancelled') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'terminal AgentRun status is immutable';
  END IF;
  IF OLD.provider_thread_id IS NOT NULL
     AND NEW.provider_thread_id IS DISTINCT FROM OLD.provider_thread_id THEN
    RAISE EXCEPTION 'AgentRun Provider thread is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_run_terminal_outcome_immutable
BEFORE UPDATE ON public.agent_run
FOR EACH ROW EXECUTE FUNCTION public.preserve_terminal_agent_run();
