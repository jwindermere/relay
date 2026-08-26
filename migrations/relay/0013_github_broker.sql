CREATE TABLE public.github_broker_decision (
  id bigserial PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace(id) ON DELETE RESTRICT,
  actor_workspace_member_id text NOT NULL,
  agent_run_id text NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  repository_id text NOT NULL,
  repository_owner text NOT NULL,
  repository_name text NOT NULL,
  operation text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('decision', 'result')),
  decision text NOT NULL CHECK (decision IN ('allow', 'deny')),
  reason text NOT NULL,
  branch text,
  commit_sha text,
  pull_request_number integer,
  evidence jsonb NOT NULL DEFAULT '{}',
  decided_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (actor_workspace_member_id, workspace_id)
    REFERENCES public.workspace_member(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_run_id, workspace_id)
    REFERENCES public.agent_run(id, workspace_id) ON DELETE RESTRICT
);

CREATE INDEX github_broker_decision_run_idx
  ON public.github_broker_decision(agent_run_id, decided_at, id);

CREATE TABLE public.artifact (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  task_id text NOT NULL,
  agent_run_id text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind = 'github_pull_request'),
  repository_id text NOT NULL,
  branch text NOT NULL,
  commit_sha text NOT NULL,
  pull_request_number integer NOT NULL,
  url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id)
    REFERENCES public.project(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (task_id, workspace_id)
    REFERENCES public.task(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_run_id, workspace_id)
    REFERENCES public.agent_run(id, workspace_id) ON DELETE RESTRICT
);

CREATE TABLE public.github_webhook_delivery (
  delivery_id text PRIMARY KEY,
  event_name text NOT NULL,
  workspace_id text NOT NULL REFERENCES public.workspace(id) ON DELETE RESTRICT,
  linked_repository_id text NOT NULL,
  agent_run_id text,
  installation_id text NOT NULL,
  repository_id text NOT NULL,
  branch text,
  commit_sha text,
  pull_request_number integer,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (linked_repository_id, workspace_id)
    REFERENCES public.linked_repository(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_run_id, workspace_id)
    REFERENCES public.agent_run(id, workspace_id) ON DELETE RESTRICT
);

CREATE FUNCTION public.reject_github_evidence_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'GitHub evidence is append-only';
END;
$$;

CREATE TRIGGER github_broker_decision_append_only
BEFORE UPDATE OR DELETE ON public.github_broker_decision
FOR EACH ROW EXECUTE FUNCTION public.reject_github_evidence_change();

CREATE TRIGGER github_webhook_delivery_append_only
BEFORE UPDATE OR DELETE ON public.github_webhook_delivery
FOR EACH ROW EXECUTE FUNCTION public.reject_github_evidence_change();
