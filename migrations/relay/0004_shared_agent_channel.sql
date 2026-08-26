CREATE TABLE public.project (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id)
);

CREATE TABLE public.agent (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  role_label text NOT NULL CHECK (length(trim(role_label)) > 0),
  status text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'working', 'waiting', 'disabled')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  CHECK (enabled OR status = 'disabled')
);

CREATE TABLE public.channel (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  project_id text,
  name text NOT NULL CHECK (name = lower(trim(name)) AND length(name) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id)
    REFERENCES public.project (id, workspace_id) ON DELETE CASCADE,
  UNIQUE (workspace_id, name),
  UNIQUE (id, workspace_id)
);

ALTER TABLE public.workspace_membership
  ADD CONSTRAINT workspace_membership_id_workspace_key UNIQUE (id, workspace_id);

CREATE TABLE public.workspace_member (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('pilot', 'agent')),
  pilot_membership_id text,
  agent_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (pilot_membership_id, workspace_id)
    REFERENCES public.workspace_membership (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id, workspace_id)
    REFERENCES public.agent (id, workspace_id) ON DELETE CASCADE,
  CHECK (
    (kind = 'pilot' AND pilot_membership_id IS NOT NULL AND agent_id IS NULL)
    OR (kind = 'agent' AND agent_id IS NOT NULL AND pilot_membership_id IS NULL)
  ),
  UNIQUE (pilot_membership_id),
  UNIQUE (agent_id),
  UNIQUE (id, workspace_id)
);

CREATE TABLE public.project_membership (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  project_id text NOT NULL,
  workspace_member_id text NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id)
    REFERENCES public.project (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_member_id, workspace_id)
    REFERENCES public.workspace_member (id, workspace_id) ON DELETE CASCADE,
  UNIQUE (project_id, workspace_member_id)
);

CREATE TABLE public.message (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  channel_id text NOT NULL,
  author_workspace_member_id text NOT NULL,
  parent_message_id text,
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, channel_id, workspace_id),
  FOREIGN KEY (channel_id, workspace_id)
    REFERENCES public.channel (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (author_workspace_member_id, workspace_id)
    REFERENCES public.workspace_member (id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (parent_message_id, channel_id, workspace_id)
    REFERENCES public.message (id, channel_id, workspace_id) ON DELETE CASCADE,
  CHECK (parent_message_id IS NULL OR parent_message_id <> id)
);

CREATE INDEX message_channel_time_idx ON public.message (channel_id, created_at, id);
CREATE INDEX message_parent_time_idx ON public.message (parent_message_id, created_at, id)
  WHERE parent_message_id IS NOT NULL;

CREATE FUNCTION public.reject_nested_message_reply()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.parent_message_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.message parent
    WHERE parent.id = NEW.parent_message_id
      AND parent.parent_message_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'nested replies are unavailable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER message_direct_replies_only
BEFORE INSERT OR UPDATE OF parent_message_id ON public.message
FOR EACH ROW EXECUTE FUNCTION public.reject_nested_message_reply();

INSERT INTO public.project (id, workspace_id, name)
SELECT id || ':relay-mvp', id, 'Relay MVP'
FROM public.workspace;

INSERT INTO public.agent (id, workspace_id, name, role_label)
SELECT id || ':alex', id, 'Alex', 'Engineering agent'
FROM public.workspace;

INSERT INTO public.channel (id, workspace_id, project_id, name)
SELECT id || ':agent-work', id, id || ':relay-mvp', 'agent-work'
FROM public.workspace;

INSERT INTO public.workspace_member (id, workspace_id, kind, pilot_membership_id)
SELECT membership.id, membership.workspace_id, 'pilot', membership.id
FROM public.workspace_membership membership;

INSERT INTO public.workspace_member (id, workspace_id, kind, agent_id)
SELECT id || ':member', workspace_id, 'agent', id
FROM public.agent;

INSERT INTO public.project_membership (workspace_id, project_id, workspace_member_id)
SELECT workspace_id, workspace_id || ':relay-mvp', id
FROM public.workspace_member;
