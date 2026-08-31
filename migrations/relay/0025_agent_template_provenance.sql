ALTER TABLE public.agent
  ADD COLUMN template_key text,
  ADD COLUMN template_version integer,
  ADD COLUMN template_snapshot jsonb,
  ADD COLUMN permission_ceiling text NOT NULL DEFAULT 'none'
    CHECK (permission_ceiling IN ('none', 'read_only', 'repository_write')),
  ADD COLUMN required_capabilities text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN disabled_capabilities text[] NOT NULL DEFAULT ARRAY[]::text[];

ALTER TABLE public.agent ADD CONSTRAINT agent_template_provenance_complete CHECK (
  (template_key IS NULL AND template_version IS NULL AND template_snapshot IS NULL)
  OR (template_key IS NOT NULL AND template_version IS NOT NULL AND template_snapshot IS NOT NULL)
);
