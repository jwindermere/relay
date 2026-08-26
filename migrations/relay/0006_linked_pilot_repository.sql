CREATE TABLE public.github_connection (
  id text PRIMARY KEY,
  workspace_id text NOT NULL UNIQUE REFERENCES public.workspace(id) ON DELETE CASCADE,
  owner_membership_id text NOT NULL,
  app_id text NOT NULL,
  installation_id text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_membership_id, workspace_id)
    REFERENCES public.workspace_membership (id, workspace_id) ON DELETE RESTRICT
);

ALTER TABLE public.github_connection
  ADD CONSTRAINT github_connection_id_workspace_key UNIQUE (id, workspace_id);

CREATE TABLE public.linked_repository (
  id text PRIMARY KEY,
  workspace_id text NOT NULL UNIQUE REFERENCES public.workspace(id) ON DELETE CASCADE,
  project_id text NOT NULL UNIQUE,
  github_connection_id text NOT NULL UNIQUE,
  repository_id text NOT NULL,
  repository_node_id text NOT NULL,
  owner_node_id text NOT NULL,
  repository_owner text NOT NULL,
  repository_name text NOT NULL,
  default_branch text NOT NULL,
  release_branches text[] NOT NULL DEFAULT '{}',
  ready_for_autonomous_work boolean NOT NULL DEFAULT false,
  verification jsonb NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  linked_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id)
    REFERENCES public.project (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (github_connection_id, workspace_id)
    REFERENCES public.github_connection (id, workspace_id) ON DELETE CASCADE,
  UNIQUE (github_connection_id, repository_id)
);

CREATE INDEX linked_repository_readiness_idx
  ON public.linked_repository (workspace_id, ready_for_autonomous_work);
