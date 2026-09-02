import { json } from '@sveltejs/kit';

import { getRelayAuth } from '$lib/server/auth.js';
import {
  authorizeWorkspaceRequest,
  WorkspaceAccessError
} from '$lib/server/authentication/authorization.js';
import { AgentConfigurationError } from '$lib/server/collaboration/agents.js';
import {
  AgentTemplateError,
  AgentTemplateWarningError,
  instantiateAgentTemplate,
  listAgentTemplates,
  loadAgentTemplateContext,
  previewAgentTemplate
} from '$lib/server/collaboration/agent-templates.js';
import { getDatabasePool } from '$lib/server/database/pool.js';

export async function GET({ request, url }) {
  try {
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);
    const key = url.searchParams.get('key');
    if (!key) return json({ templates: listAgentTemplates() });
    const projectId = url.searchParams.get('projectId') ?? '';
    const { agentConfiguration, availableCapabilities, projectAgents } = await loadAgentTemplateContext(
      pool, access, projectId
    );
    const ambientTriggers = url.searchParams.getAll('ambientTrigger');
    return json({ preview: previewAgentTemplate(key, {
      availableCapabilities,
      existingAgents: agentConfiguration.agents,
      existingProjectAgents: projectAgents,
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
    const projectId = typeof input?.projectId === 'string' ? input.projectId.trim() : '';
    const { agentConfiguration, availableCapabilities, projectAgents } = await loadAgentTemplateContext(
      pool, access, projectId
    );
    const result = await instantiateAgentTemplate(pool, access, projectId, input.key, {
      ...input,
      existingAgents: agentConfiguration.agents,
      existingProjectAgents: projectAgents,
      availableCapabilities
    });
    return json(result, { status: 201 });
  } catch (error) {
    if (error instanceof WorkspaceAccessError) return json({ message: error.message }, { status: 403 });
    if (error instanceof AgentTemplateWarningError) {
      return json({ message: error.message, preview: error.preview }, { status: 409 });
    }
    if (error instanceof AgentTemplateError || error instanceof AgentConfigurationError || error instanceof SyntaxError) {
      return json({ message: error instanceof Error ? error.message : 'invalid template request' }, { status: 400 });
    }
    throw error;
  }
}
