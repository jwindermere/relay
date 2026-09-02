import { json } from '@sveltejs/kit';

import { getRelayAuth } from '$lib/server/auth.js';
import { authorizeWorkspaceRequest, WorkspaceAccessError } from '$lib/server/authentication/authorization.js';
import {
  CoordinationError,
  loadWorkspaceCoordinationPolicy,
  updateWorkspaceCoordinationPolicy
} from '$lib/server/collaboration/coordination.js';
import { getDatabasePool } from '$lib/server/database/pool.js';

export async function GET({ request }) {
  try {
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);
    return json(await loadWorkspaceCoordinationPolicy(pool, access));
  } catch (error) {
    if (error instanceof WorkspaceAccessError) return json({ message: error.message }, { status: 403 });
    if (error instanceof CoordinationError) return json({ message: error.message }, { status: 400 });
    throw error;
  }
}

export async function PATCH({ request }) {
  try {
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);
    await updateWorkspaceCoordinationPolicy(pool, access, await request.json());
    return json(await loadWorkspaceCoordinationPolicy(pool, access));
  } catch (error) {
    if (error instanceof WorkspaceAccessError) return json({ message: error.message }, { status: 403 });
    if (error instanceof CoordinationError || error instanceof SyntaxError) {
      return json({ message: error instanceof Error ? error.message : 'invalid coordination policy' }, { status: 400 });
    }
    throw error;
  }
}
