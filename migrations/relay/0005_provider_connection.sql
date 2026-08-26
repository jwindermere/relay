CREATE TABLE public.provider_connection (
  id text PRIMARY KEY,
  workspace_id text NOT NULL UNIQUE REFERENCES public.workspace (id) ON DELETE RESTRICT,
  owner_membership_id text NOT NULL,
  provider text NOT NULL DEFAULT 'codex' CHECK (provider = 'codex'),
  auth_mode text NOT NULL DEFAULT 'chatgpt' CHECK (auth_mode = 'chatgpt'),
  status text NOT NULL CHECK (
    status IN ('connecting', 'ready', 'disabled', 'disconnecting', 'disconnected')
  ),
  status_before_login text CHECK (
    status_before_login IS NULL OR status_before_login IN ('ready', 'disabled', 'disconnected')
  ),
  credential_store_reference text NOT NULL UNIQUE CHECK (length(trim(credential_store_reference)) > 0),
  login_attempt_id text,
  provider_login_id text,
  connected_at timestamptz,
  disconnected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_membership_id, workspace_id)
    REFERENCES public.workspace_membership (id, workspace_id) ON DELETE RESTRICT,
  CHECK (status = 'connecting' OR login_attempt_id IS NULL),
  CHECK (status = 'connecting' OR status_before_login IS NULL),
  CHECK (status <> 'ready' OR connected_at IS NOT NULL)
);

CREATE INDEX provider_connection_readiness_idx
  ON public.provider_connection (workspace_id, status);
