ALTER TABLE public.agent_conversation_turn
  ADD COLUMN handoff_depth integer NOT NULL DEFAULT 0
    CHECK (handoff_depth BETWEEN 0 AND 1);

WITH defaults(name, agent_type, role_label, instructions, ambient_triggers, id_suffix) AS (
  VALUES
    ('Maya', 'product', 'Product manager',
     'Clarify outcomes, priorities, requirements, trade-offs, and coordinate specialist input.',
     ARRAY['product', 'priority', 'roadmap', 'requirement', 'customer', 'coordination']::text[],
     'maya'),
    ('Riley', 'research', 'Research agent',
     'Investigate questions, assess evidence and sources, and return concise findings.',
     ARRAY['research', 'evidence', 'source', 'market', 'competitor', 'investigate']::text[],
     'riley')
)
INSERT INTO public.agent (
  id, workspace_id, name, agent_type, role_label, instructions, ambient_triggers
)
SELECT workspace.id || ':' || defaults.id_suffix, workspace.id, defaults.name,
       defaults.agent_type, defaults.role_label, defaults.instructions,
       defaults.ambient_triggers
FROM public.workspace workspace
CROSS JOIN defaults
WHERE NOT EXISTS (
  SELECT 1 FROM public.agent existing
  WHERE existing.workspace_id = workspace.id
    AND lower(existing.name) = lower(defaults.name)
);

INSERT INTO public.workspace_member (id, workspace_id, kind, agent_id)
SELECT agent.id || ':member', agent.workspace_id, 'agent', agent.id
FROM public.agent agent
WHERE agent.id IN (agent.workspace_id || ':maya', agent.workspace_id || ':riley')
  AND NOT EXISTS (
    SELECT 1 FROM public.workspace_member member WHERE member.agent_id = agent.id
  );

INSERT INTO public.project_membership (workspace_id, project_id, workspace_member_id)
SELECT member.workspace_id, project.id, member.id
FROM public.workspace_member member
JOIN public.agent agent ON agent.id = member.agent_id
JOIN LATERAL (
  SELECT candidate.id
  FROM public.project candidate
  WHERE candidate.workspace_id = member.workspace_id
  ORDER BY candidate.created_at, candidate.id
  LIMIT 1
) project ON true
WHERE agent.id IN (agent.workspace_id || ':maya', agent.workspace_id || ':riley')
ON CONFLICT (project_id, workspace_member_id) DO NOTHING;
