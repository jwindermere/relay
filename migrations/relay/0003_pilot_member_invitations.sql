ALTER TABLE public.workspace_membership
  ADD COLUMN id text;

UPDATE public.workspace_membership
SET id = workspace_id || ':' || user_id;

ALTER TABLE public.workspace_membership
  ALTER COLUMN id SET NOT NULL,
  ADD CONSTRAINT workspace_membership_id_key UNIQUE (id);

ALTER TABLE public.audit_event
  ADD COLUMN actor_membership_id text
    REFERENCES public.workspace_membership (id) ON DELETE SET NULL;

UPDATE public.audit_event e
SET actor_membership_id = m.id
FROM public.workspace_membership m
WHERE m.workspace_id = e.workspace_id
  AND m.user_id = e.actor_user_id;

CREATE TABLE public.workspace_invitation (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(trim(email)) AND length(email) > 0),
  role text NOT NULL DEFAULT 'member' CHECK (role = 'member'),
  token_hash text NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  inviter_membership_id text NOT NULL REFERENCES public.workspace_membership (id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_membership_id text REFERENCES public.workspace_membership (id) ON DELETE RESTRICT,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK ((accepted_at IS NULL) = (accepted_membership_id IS NULL)),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);

CREATE INDEX workspace_invitation_pending_workspace_idx
  ON public.workspace_invitation (workspace_id, expires_at)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
