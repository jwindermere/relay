ALTER TABLE public.agent
  ADD COLUMN configuration_version integer NOT NULL DEFAULT 1 CHECK (configuration_version > 0);

CREATE TABLE public.workspace_collaboration_evaluation_policy (
  workspace_id text PRIMARY KEY REFERENCES public.workspace(id) ON DELETE CASCADE,
  retention_days integer NOT NULL DEFAULT 365 CHECK (retention_days BETWEEN 1 AND 3650),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.workspace_collaboration_evaluation_policy (workspace_id)
SELECT id FROM public.workspace;

CREATE FUNCTION public.create_workspace_collaboration_evaluation_policy() RETURNS trigger AS $$
BEGIN
  INSERT INTO public.workspace_collaboration_evaluation_policy (workspace_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workspace_collaboration_evaluation_policy_after_insert
AFTER INSERT ON public.workspace
FOR EACH ROW EXECUTE FUNCTION public.create_workspace_collaboration_evaluation_policy();

ALTER TABLE public.collaboration_evaluation_event
  ADD COLUMN agent_type text NOT NULL DEFAULT 'unattributed',
  ALTER COLUMN routing_policy_version SET DEFAULT 'not-applicable-v1',
  ALTER COLUMN prompt_version SET DEFAULT 'not-applicable-v1',
  ALTER COLUMN permission_policy_version SET DEFAULT 'not-applicable-v1',
  ALTER COLUMN agent_configuration_version SET DEFAULT 'unattributed-v1',
  ADD COLUMN expires_at timestamptz;

UPDATE public.collaboration_evaluation_event event
SET agent_type = COALESCE((
      SELECT agent.agent_type FROM public.agent agent
      WHERE agent.id = event.agent_id AND agent.workspace_id = event.workspace_id
    ), 'unattributed'),
    routing_policy_version = COALESCE(event.routing_policy_version, 'not-applicable-v1'),
    prompt_version = COALESCE(event.prompt_version, 'not-applicable-v1'),
    permission_policy_version = COALESCE(event.permission_policy_version, 'not-applicable-v1'),
    agent_configuration_version = COALESCE(
      event.agent_configuration_version,
      CASE WHEN event.agent_id IS NULL THEN 'unattributed-v1'
           ELSE 'agent-config-' || COALESCE((
             SELECT agent.configuration_version FROM public.agent agent
             WHERE agent.id = event.agent_id AND agent.workspace_id = event.workspace_id
           ), 1)::text END
    ),
    outcome_type = COALESCE(event.outcome_type, 'unknown'),
    outcome_id = COALESCE(event.outcome_id, event.id),
    expires_at = event.created_at + (
      SELECT policy.retention_days FROM public.workspace_collaboration_evaluation_policy policy
      WHERE policy.workspace_id = event.workspace_id
    ) * interval '1 day';

ALTER TABLE public.collaboration_evaluation_event
  ALTER COLUMN routing_policy_version SET NOT NULL,
  ALTER COLUMN prompt_version SET NOT NULL,
  ALTER COLUMN permission_policy_version SET NOT NULL,
  ALTER COLUMN agent_configuration_version SET NOT NULL,
  ALTER COLUMN outcome_type SET NOT NULL,
  ALTER COLUMN outcome_id SET NOT NULL,
  ALTER COLUMN expires_at SET NOT NULL;

ALTER TABLE public.collaboration_feedback
  ADD COLUMN agent_id text,
  ADD COLUMN agent_type text NOT NULL DEFAULT 'unattributed',
  ADD COLUMN routing_policy_version text NOT NULL DEFAULT 'not-applicable-v1',
  ADD COLUMN prompt_version text NOT NULL DEFAULT 'not-applicable-v1',
  ADD COLUMN permission_policy_version text NOT NULL DEFAULT 'not-applicable-v1',
  ADD COLUMN agent_configuration_version text NOT NULL DEFAULT 'unattributed-v1',
  ADD COLUMN expires_at timestamptz,
  ADD CONSTRAINT collaboration_feedback_agent_fk
    FOREIGN KEY (agent_id, workspace_id) REFERENCES public.agent(id, workspace_id) ON DELETE RESTRICT;

UPDATE public.collaboration_feedback feedback
SET (agent_id, agent_type, routing_policy_version, prompt_version,
     permission_policy_version, agent_configuration_version) = (
      SELECT event.agent_id, event.agent_type,
             COALESCE(event.routing_policy_version, 'not-applicable-v1'),
             COALESCE(event.prompt_version, 'not-applicable-v1'),
             COALESCE(event.permission_policy_version, 'not-applicable-v1'),
             COALESCE(event.agent_configuration_version, 'unattributed-v1')
      FROM public.collaboration_evaluation_event event
      WHERE event.workspace_id = feedback.workspace_id
        AND event.project_id = feedback.project_id
        AND event.outcome_type = feedback.outcome_type
        AND event.outcome_id = feedback.outcome_id
      ORDER BY event.created_at DESC, event.id DESC LIMIT 1
    ),
    expires_at = feedback.created_at + (
      SELECT policy.retention_days FROM public.workspace_collaboration_evaluation_policy policy
      WHERE policy.workspace_id = feedback.workspace_id
    ) * interval '1 day'
WHERE EXISTS (
  SELECT 1 FROM public.collaboration_evaluation_event event
  WHERE event.workspace_id = feedback.workspace_id
    AND event.project_id = feedback.project_id
    AND event.outcome_type = feedback.outcome_type
    AND event.outcome_id = feedback.outcome_id
);

UPDATE public.collaboration_feedback feedback
SET expires_at = feedback.created_at + policy.retention_days * interval '1 day'
FROM public.workspace_collaboration_evaluation_policy policy
WHERE feedback.expires_at IS NULL AND policy.workspace_id = feedback.workspace_id;

ALTER TABLE public.collaboration_feedback ALTER COLUMN expires_at SET NOT NULL;

CREATE FUNCTION public.prepare_collaboration_evaluation_event() RETURNS trigger AS $$
DECLARE
  retention integer;
  configuration integer;
  snapshot_agent_type text;
BEGIN
  SELECT retention_days INTO retention
  FROM public.workspace_collaboration_evaluation_policy WHERE workspace_id = NEW.workspace_id;
  IF NEW.agent_id IS NOT NULL THEN
    SELECT configuration_version, agent_type INTO configuration, snapshot_agent_type
    FROM public.agent WHERE id = NEW.agent_id AND workspace_id = NEW.workspace_id;
  END IF;
  NEW.agent_type := COALESCE(snapshot_agent_type, NEW.agent_type, 'unattributed');
  NEW.routing_policy_version := COALESCE(NEW.routing_policy_version, 'not-applicable-v1');
  NEW.prompt_version := COALESCE(NEW.prompt_version, 'not-applicable-v1');
  NEW.permission_policy_version := COALESCE(NEW.permission_policy_version, 'not-applicable-v1');
  NEW.agent_configuration_version := COALESCE(
    NEW.agent_configuration_version,
    CASE WHEN configuration IS NULL THEN 'unattributed-v1' ELSE 'agent-config-' || configuration::text END
  );
  NEW.outcome_type := COALESCE(NEW.outcome_type, 'unknown');
  NEW.outcome_id := COALESCE(NEW.outcome_id, NEW.id);
  NEW.expires_at := COALESCE(NEW.expires_at, NEW.created_at + COALESCE(retention, 365) * interval '1 day');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER collaboration_evaluation_event_prepare
BEFORE INSERT ON public.collaboration_evaluation_event
FOR EACH ROW EXECUTE FUNCTION public.prepare_collaboration_evaluation_event();

ALTER TABLE public.collaboration_evaluation_event
  ALTER COLUMN agent_type DROP DEFAULT,
  ALTER COLUMN agent_configuration_version DROP DEFAULT,
  ADD CONSTRAINT collaboration_evaluation_evidence_private CHECK (
    evidence::text !~* '"(authorization|api[_ -]?key|password|secret|token|credential|private[_ -]?key|encrypted_reasoning|provider[_ -]?(event[_ -]?)?trace)"[[:space:]]*:'
    AND evidence::text !~* '(chain[ -]of[ -]thought|private reasoning|hidden reasoning)'
    AND evidence::text !~ '(-----BEGIN [A-Z ]*PRIVATE KEY-----|\m(sk|ghp)_[A-Za-z0-9_-]{12,}\M|\msk-(proj-)?[A-Za-z0-9_-]{12,}\M|\mgithub_pat_[A-Za-z0-9_]{12,}\M|\mAKIA[A-Z0-9]{16}\M|\meyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\M)'
    AND evidence::text !~* '(authorization[[:space:]]*:[[:space:]]*(basic|bearer)[[:space:]]+[^[:space:]]+|[a-z][a-z0-9+.-]*://[^[:space:]/@:]+:[^[:space:]/@]+@)'
  );

ALTER TABLE public.collaboration_feedback
  ADD CONSTRAINT collaboration_feedback_reason_private CHECK (
    reason IS NULL OR (
      reason !~* '(chain[ -]of[ -]thought|private reasoning|hidden reasoning|authorization[[:space:]]*:[[:space:]]*(basic|bearer)[[:space:]]+[^[:space:]]+)'
      AND reason !~ '(-----BEGIN [A-Z ]*PRIVATE KEY-----|\m(sk|ghp)_[A-Za-z0-9_-]{12,}\M|\msk-(proj-)?[A-Za-z0-9_-]{12,}\M|\mgithub_pat_[A-Za-z0-9_]{12,}\M|\mAKIA[A-Z0-9]{16}\M|\meyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\M)'
    )
  );

CREATE FUNCTION public.prepare_collaboration_feedback() RETURNS trigger AS $$
DECLARE retention integer;
BEGIN
  SELECT retention_days INTO retention
  FROM public.workspace_collaboration_evaluation_policy WHERE workspace_id = NEW.workspace_id;
  NEW.expires_at := COALESCE(NEW.expires_at, NEW.created_at + COALESCE(retention, 365) * interval '1 day');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER collaboration_feedback_prepare
BEFORE INSERT OR UPDATE ON public.collaboration_feedback
FOR EACH ROW EXECUTE FUNCTION public.prepare_collaboration_feedback();

CREATE FUNCTION public.refresh_collaboration_evaluation_expiry() RETURNS trigger AS $$
BEGIN
  UPDATE public.collaboration_evaluation_event
  SET expires_at = created_at + NEW.retention_days * interval '1 day'
  WHERE workspace_id = NEW.workspace_id;
  UPDATE public.collaboration_feedback
  SET expires_at = created_at + NEW.retention_days * interval '1 day'
  WHERE workspace_id = NEW.workspace_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workspace_collaboration_evaluation_policy_after_update
AFTER UPDATE OF retention_days ON public.workspace_collaboration_evaluation_policy
FOR EACH ROW WHEN (OLD.retention_days IS DISTINCT FROM NEW.retention_days)
EXECUTE FUNCTION public.refresh_collaboration_evaluation_expiry();

CREATE INDEX collaboration_evaluation_expiry_idx
  ON public.collaboration_evaluation_event(workspace_id, expires_at);
CREATE INDEX collaboration_feedback_expiry_idx
  ON public.collaboration_feedback(workspace_id, expires_at);
