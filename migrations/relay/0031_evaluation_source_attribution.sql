-- minimum-runtime-version: 30

ALTER TABLE public.agent_run
  ADD COLUMN agent_configuration_version integer,
  ADD COLUMN agent_type_snapshot text;

ALTER TABLE public.agent_conversation_turn
  ADD COLUMN agent_configuration_version integer,
  ADD COLUMN agent_type_snapshot text;

ALTER TABLE public.coordination_plan
  ADD COLUMN agent_configuration_version integer,
  ADD COLUMN agent_type_snapshot text;

UPDATE public.agent_run run
SET agent_configuration_version = agent.configuration_version,
    agent_type_snapshot = agent.agent_type
FROM public.agent agent
WHERE agent.id = run.agent_id AND agent.workspace_id = run.workspace_id;

UPDATE public.agent_conversation_turn turn
SET agent_configuration_version = agent.configuration_version,
    agent_type_snapshot = agent.agent_type
FROM public.agent_conversation conversation
JOIN public.agent agent
  ON agent.id = conversation.agent_id AND agent.workspace_id = conversation.workspace_id
WHERE conversation.id = turn.conversation_id AND conversation.workspace_id = turn.workspace_id;

UPDATE public.coordination_plan plan
SET agent_configuration_version = agent.configuration_version,
    agent_type_snapshot = agent.agent_type
FROM public.agent agent
WHERE agent.id = plan.coordinating_agent_id AND agent.workspace_id = plan.workspace_id;

CREATE FUNCTION public.snapshot_agent_run_configuration() RETURNS trigger AS $$
DECLARE
  snapshot_configuration integer;
  snapshot_agent_type text;
BEGIN
  IF NEW.agent_configuration_version IS NULL OR NEW.agent_type_snapshot IS NULL THEN
    SELECT configuration_version, agent_type
    INTO snapshot_configuration, snapshot_agent_type
    FROM public.agent WHERE id = NEW.agent_id AND workspace_id = NEW.workspace_id;
    NEW.agent_configuration_version := COALESCE(NEW.agent_configuration_version, snapshot_configuration);
    NEW.agent_type_snapshot := COALESCE(NEW.agent_type_snapshot, snapshot_agent_type);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_run_configuration_snapshot
BEFORE INSERT ON public.agent_run
FOR EACH ROW EXECUTE FUNCTION public.snapshot_agent_run_configuration();

CREATE FUNCTION public.snapshot_conversation_turn_configuration() RETURNS trigger AS $$
DECLARE
  snapshot_configuration integer;
  snapshot_agent_type text;
BEGIN
  IF NEW.agent_configuration_version IS NULL OR NEW.agent_type_snapshot IS NULL THEN
    SELECT agent.configuration_version, agent.agent_type
    INTO snapshot_configuration, snapshot_agent_type
    FROM public.agent_conversation conversation
    JOIN public.agent agent
      ON agent.id = conversation.agent_id AND agent.workspace_id = conversation.workspace_id
    WHERE conversation.id = NEW.conversation_id AND conversation.workspace_id = NEW.workspace_id;
    NEW.agent_configuration_version := COALESCE(NEW.agent_configuration_version, snapshot_configuration);
    NEW.agent_type_snapshot := COALESCE(NEW.agent_type_snapshot, snapshot_agent_type);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_conversation_turn_configuration_snapshot
BEFORE INSERT ON public.agent_conversation_turn
FOR EACH ROW EXECUTE FUNCTION public.snapshot_conversation_turn_configuration();

CREATE FUNCTION public.snapshot_coordination_plan_configuration() RETURNS trigger AS $$
DECLARE
  snapshot_configuration integer;
  snapshot_agent_type text;
BEGIN
  IF NEW.agent_configuration_version IS NULL OR NEW.agent_type_snapshot IS NULL THEN
    SELECT configuration_version, agent_type
    INTO snapshot_configuration, snapshot_agent_type
    FROM public.agent
    WHERE id = NEW.coordinating_agent_id AND workspace_id = NEW.workspace_id;
    NEW.agent_configuration_version := COALESCE(NEW.agent_configuration_version, snapshot_configuration);
    NEW.agent_type_snapshot := COALESCE(NEW.agent_type_snapshot, snapshot_agent_type);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER coordination_plan_configuration_snapshot
BEFORE INSERT ON public.coordination_plan
FOR EACH ROW EXECUTE FUNCTION public.snapshot_coordination_plan_configuration();

ALTER TABLE public.agent_run
  ALTER COLUMN agent_configuration_version SET NOT NULL,
  ALTER COLUMN agent_type_snapshot SET NOT NULL,
  ADD CONSTRAINT agent_run_configuration_version_positive
    CHECK (agent_configuration_version > 0);

ALTER TABLE public.agent_conversation_turn
  ALTER COLUMN agent_configuration_version SET NOT NULL,
  ALTER COLUMN agent_type_snapshot SET NOT NULL,
  ADD CONSTRAINT agent_conversation_turn_configuration_version_positive
    CHECK (agent_configuration_version > 0);

ALTER TABLE public.coordination_plan
  ALTER COLUMN agent_configuration_version SET NOT NULL,
  ALTER COLUMN agent_type_snapshot SET NOT NULL,
  ADD CONSTRAINT coordination_plan_configuration_version_positive
    CHECK (agent_configuration_version > 0);

CREATE OR REPLACE FUNCTION public.prepare_collaboration_evaluation_event() RETURNS trigger AS $$
DECLARE
  retention integer;
  configuration integer;
  current_agent_type text;
BEGIN
  SELECT retention_days INTO retention
  FROM public.workspace_collaboration_evaluation_policy WHERE workspace_id = NEW.workspace_id;
  IF NEW.agent_id IS NOT NULL THEN
    SELECT configuration_version, agent_type INTO configuration, current_agent_type
    FROM public.agent WHERE id = NEW.agent_id AND workspace_id = NEW.workspace_id;
  END IF;
  NEW.agent_type := COALESCE(NEW.agent_type, current_agent_type, 'unattributed');
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
