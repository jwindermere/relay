import { json } from '@sveltejs/kit';

import { getRelayAuth } from '$lib/server/auth.js';
import { authorizeWorkspaceRequest, WorkspaceAccessError } from '$lib/server/authentication/authorization.js';
import { AgentConfigurationError, updateWorkspaceAgent } from '$lib/server/collaboration/agents.js';
import { getDatabasePool } from '$lib/server/database/pool.js';

export async function PATCH({ params, request }) {
  try {
    const input = await request.json();
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);
    await updateWorkspaceAgent(pool, access, params.agentId, input);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof WorkspaceAccessError) return json({ message: error.message }, { status: 403 });
    if (error instanceof AgentConfigurationError || error instanceof SyntaxError) {
      return json({ message: error instanceof Error ? error.message : 'invalid Agent request' }, { status: 400 });
    }
    throw error;
  }
}
