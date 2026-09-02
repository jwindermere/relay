import { json } from '@sveltejs/kit';
import type { Pool } from 'pg';

import { getRelayAuth } from '$lib/server/auth.js';
import {
  authorizeWorkspaceRequest,
  type WorkspaceAccess,
  WorkspaceAccessError
} from '$lib/server/authentication/authorization.js';
import {
  AgentConfigurationError,
  loadWorkspaceAgents
} from '$lib/server/collaboration/agents.js';
import {
  AgentTemplateError,
  instantiateAgentTemplate,
  listAgentTemplates,
  loadAvailableAgentTemplateCapabilities,
  previewAgentTemplate
} from '$lib/server/collaboration/agent-templates.js';
import { getDatabasePool } from '$lib/server/database/pool.js';

async function loadAgentTemplateContext(pool: Pool, access: WorkspaceAccess) {
  const [{ agents }, availableCapabilities] = await Promise.all([
    loadWorkspaceAgents(pool, access),
    loadAvailableAgentTemplateCapabilities(pool, access)
  ]);
  return { agents, availableCapabilities };
}

export async function GET({ request, url }) {
  try {
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);
    const key = url.searchParams.get('key');
    if (!key) return json({ templates: listAgentTemplates() });
    const { agents, availableCapabilities } = await loadAgentTemplateContext(pool, access);
    const ambientTriggers = url.searchParams.getAll('ambientTrigger');
    return json({ preview: previewAgentTemplate(key, {
      availableCapabilities, existingAgents: agents,
      name: url.searchParams.get('name') ?? undefined,
      roleLabel: url.searchParams.get('roleLabel') ?? undefined,
      ambientTriggers: ambientTriggers.length > 0 ? ambientTriggers : undefined
    }) });
  } catch (error) {
    if (error instanceof WorkspaceAccessError) return json({ message: error.message }, { status: 403 });
    if (error instanceof AgentTemplateError) return json({ message: error.message }, { status: 400 });
    throw error;
  }
}

export async function POST({ request }) {
  try {
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);
    const input = await request.json();
    const { agents, availableCapabilities } = await loadAgentTemplateContext(pool, access);
    const result = await instantiateAgentTemplate(pool, access, input.key, {
      ...input, existingAgents: agents, availableCapabilities
    });
    return json(result, { status: 201 });
  } catch (error) {
    if (error instanceof WorkspaceAccessError) return json({ message: error.message }, { status: 403 });
    if (error instanceof AgentTemplateError || error instanceof AgentConfigurationError || error instanceof SyntaxError) {
      return json({ message: error instanceof Error ? error.message : 'invalid template request' }, { status: 400 });
    }
    throw error;
  }
}
