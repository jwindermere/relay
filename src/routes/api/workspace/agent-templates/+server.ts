import { json } from '@sveltejs/kit';

import { getRelayAuth } from '$lib/server/auth.js';
import { authorizeWorkspaceRequest, WorkspaceAccessError } from '$lib/server/authentication/authorization.js';
import {
  AgentConfigurationError,
  loadWorkspaceAgents
} from '$lib/server/collaboration/agents.js';
import {
  AgentTemplateError,
  instantiateAgentTemplate,
  listAgentTemplates,
  previewAgentTemplate
} from '$lib/server/collaboration/agent-templates.js';
import { getDatabasePool } from '$lib/server/database/pool.js';

export async function GET({ request, url }) {
  try {
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);
    const key = url.searchParams.get('key');
    if (!key) return json({ templates: listAgentTemplates() });
    const { agents } = await loadWorkspaceAgents(pool, access);
    return json({ preview: previewAgentTemplate(key, {
      availableCapabilities: [], existingAgents: agents,
      name: url.searchParams.get('name') ?? undefined
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
    const { agents } = await loadWorkspaceAgents(pool, access);
    const result = await instantiateAgentTemplate(pool, access, input.key, {
      ...input, existingAgents: agents, availableCapabilities: input.availableCapabilities ?? []
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
