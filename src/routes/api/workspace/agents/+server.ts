import { json } from '@sveltejs/kit';

import { getRelayAuth } from '$lib/server/auth.js';
import { authorizeWorkspaceRequest, WorkspaceAccessError } from '$lib/server/authentication/authorization.js';
import { AgentConfigurationError, createWorkspaceAgent } from '$lib/server/collaboration/agents.js';
import { getDatabasePool } from '$lib/server/database/pool.js';

export async function POST({ request }) {
  try {
    const input = await request.json();
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);
    const projectId = typeof input?.projectId === 'string' ? input.projectId.trim() : '';
    return json(
      { agent: await createWorkspaceAgent(pool, access, projectId, input) },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof WorkspaceAccessError) return json({ message: error.message }, { status: 403 });
    if (error instanceof AgentConfigurationError || error instanceof SyntaxError) {
      return json({ message: error instanceof Error ? error.message : 'invalid Agent request' }, { status: 400 });
    }
    throw error;
  }
}
