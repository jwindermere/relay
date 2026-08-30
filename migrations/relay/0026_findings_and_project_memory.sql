CREATE TABLE public.agent_finding (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  author_agent_id text NOT NULL,
  result_message_id text,
  source_handoff_id text,
  summary text NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 4000),
  confidence numeric(4, 3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  observed_evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(observed_evidence) = 'array'),
  inferences jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(inferences) = 'array'),
  assumptions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(assumptions) = 'array'),
  open_questions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(open_questions) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES public.project(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (author_agent_id, workspace_id) REFERENCES public.agent(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (result_message_id, workspace_id) REFERENCES public.message(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_handoff_id, workspace_id) REFERENCES public.agent_handoff(id, workspace_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX agent_finding_result_message_unique_idx
  ON public.agent_finding(result_message_id) WHERE result_message_id IS NOT NULL;
CREATE UNIQUE INDEX agent_finding_handoff_unique_idx
  ON public.agent_finding(source_handoff_id) WHERE source_handoff_id IS NOT NULL;

CREATE TABLE public.finding_evidence (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  finding_id text NOT NULL,
  evidence_type text NOT NULL CHECK (evidence_type IN ('external', 'repository', 'message', 'artifact')),
  stable_reference text NOT NULL CHECK (length(trim(stable_reference)) BETWEEN 1 AND 2000),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 500),
  retrieved_at timestamptz NOT NULL,
  claim text NOT NULL CHECK (length(trim(claim)) BETWEEN 1 AND 2000),
  accessible boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (finding_id, workspace_id) REFERENCES public.agent_finding(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, workspace_id) REFERENCES public.project(id, workspace_id) ON DELETE CASCADE,
  UNIQUE (finding_id, evidence_type, stable_reference, claim)
);

CREATE TABLE public.project_memory (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  author_workspace_member_id text NOT NULL,
  memory_type text NOT NULL CHECK (memory_type IN (
    'decision', 'terminology', 'constraint', 'finding', 'convention', 'rejected_approach'
  )),
  statement text NOT NULL CHECK (length(trim(statement)) BETWEEN 1 AND 4000),
  source_references jsonb NOT NULL CHECK (jsonb_typeof(source_references) = 'array'),
  lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'superseded', 'archived', 'deleted')),
  supersedes_id text,
  corrected_from_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, workspace_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES public.project(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (author_workspace_member_id, workspace_id)
    REFERENCES public.workspace_member(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_id, workspace_id) REFERENCES public.project_memory(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (corrected_from_id, workspace_id) REFERENCES public.project_memory(id, workspace_id) ON DELETE RESTRICT,
  CHECK ((lifecycle = 'deleted') = (deleted_at IS NOT NULL))
);

CREATE INDEX agent_finding_project_idx ON public.agent_finding(workspace_id, project_id, created_at, id);
CREATE INDEX project_memory_context_idx ON public.project_memory(workspace_id, project_id, lifecycle, created_at, id);
