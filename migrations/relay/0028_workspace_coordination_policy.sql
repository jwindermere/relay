CREATE TABLE public.workspace_coordination_policy (
  workspace_id text PRIMARY KEY REFERENCES public.workspace(id) ON DELETE CASCADE,
  default_max_participants integer NOT NULL DEFAULT 4 CHECK (default_max_participants BETWEEN 1 AND 8),
  default_max_handoffs integer NOT NULL DEFAULT 8 CHECK (default_max_handoffs BETWEEN 0 AND 20),
  default_max_depth integer NOT NULL DEFAULT 1 CHECK (default_max_depth BETWEEN 0 AND 1),
  default_max_agent_runs integer NOT NULL DEFAULT 0 CHECK (default_max_agent_runs BETWEEN 0 AND 20),
  default_max_elapsed_seconds integer NOT NULL DEFAULT 3600 CHECK (default_max_elapsed_seconds BETWEEN 60 AND 86400),
  default_provider_usage_limit numeric CHECK (default_provider_usage_limit IS NULL OR default_provider_usage_limit >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.workspace_coordination_policy (workspace_id)
SELECT id FROM public.workspace;

CREATE FUNCTION public.create_workspace_coordination_policy() RETURNS trigger AS $$
BEGIN
  INSERT INTO public.workspace_coordination_policy (workspace_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workspace_coordination_policy_after_insert
AFTER INSERT ON public.workspace
FOR EACH ROW EXECUTE FUNCTION public.create_workspace_coordination_policy();
