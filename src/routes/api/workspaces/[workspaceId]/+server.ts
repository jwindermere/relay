import { json } from '@sveltejs/kit';

import { getRelayAuth } from '$lib/server/auth.js';
import {
  authorizeWorkspaceRequest,
  WorkspaceAccessError
} from '$lib/server/authentication/authorization.js';
import {
  renameWorkspace,
  WorkspaceConfigurationError
} from '$lib/server/collaboration/workspaces.js';
import { getDatabasePool } from '$lib/server/database/pool.js';

export async function PATCH({ request, params }) {
  try {
    const input = await request.json() as { name?: unknown };
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);
    const workspace = await renameWorkspace(pool, access, params.workspaceId, {
      name: typeof input.name === 'string' ? input.name : ''
    });
    return json({ workspace });
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return json({ message: error.message }, { status: 403 });
    }
    if (error instanceof WorkspaceConfigurationError || error instanceof SyntaxError) {
      return json({
        message: error instanceof Error ? error.message : 'invalid Workspace request'
      }, { status: 400 });
    }
    throw error;
  }
}
