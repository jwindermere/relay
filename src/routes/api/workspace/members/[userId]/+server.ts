import { json } from '@sveltejs/kit';

import { getRelayAuth } from '$lib/server/auth.js';
import {
  authorizeWorkspaceRequest,
  revokeWorkspaceMembership,
  WorkspaceAccessError
} from '$lib/server/authentication/authorization.js';
import { getDatabasePool } from '$lib/server/database/pool.js';

export async function DELETE({ params, request }) {
  try {
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);
    await revokeWorkspaceMembership(pool, access, params.userId);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return json({ message: error.message }, { status: 403 });
    }
    throw error;
  }
}
