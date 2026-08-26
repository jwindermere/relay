CREATE TABLE public.github_repository_connection (
  id text PRIMARY KEY,
  workspace_id text NOT NULL UNIQUE REFERENCES public.workspace(id) ON DELETE CASCADE,
  project_id text NOT NULL UNIQUE,
  owner_membership_id text NOT NULL,
  app_id text NOT NULL,
  installation_id text NOT NULL,
  repository_id text NOT NULL,
  repository_node_id text NOT NULL,
  owner_node_id text NOT NULL,
  repository_owner text NOT NULL,
  repository_name text NOT NULL,
  default_branch text NOT NULL,
  release_branches text[] NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('linked', 'disabled')),
  ready_for_autonomous_work boolean NOT NULL DEFAULT false,
  verification jsonb NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  linked_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, workspace_id)
    REFERENCES public.project (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_membership_id, workspace_id)
    REFERENCES public.workspace_membership (id, workspace_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX github_repository_identity_idx
  ON public.github_repository_connection (installation_id, repository_id);

CREATE INDEX github_repository_readiness_idx
  ON public.github_repository_connection (workspace_id, status, ready_for_autonomous_work);
