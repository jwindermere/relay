CREATE TABLE public.workspace (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.workspace_membership (
  workspace_id text NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (workspace_id, user_id),
  CHECK (revoked_at IS NULL OR revoked_at >= joined_at)
);

CREATE INDEX workspace_membership_active_user_idx
  ON public.workspace_membership (user_id)
  WHERE revoked_at IS NULL;

CREATE TABLE public.audit_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text REFERENCES public.workspace (id) ON DELETE RESTRICT,
  actor_user_id text REFERENCES auth."user" (id) ON DELETE SET NULL,
  event_type text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_event_workspace_time_idx
  ON public.audit_event (workspace_id, occurred_at, id);
