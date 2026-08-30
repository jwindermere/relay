import { json } from '@sveltejs/kit';

import { getRelayAuth } from '$lib/server/auth.js';
import {
  authorizeWorkspaceRequest,
  WorkspaceAccessError
} from '$lib/server/authentication/authorization.js';
import {
  AgentHandoffError,
  cancelAgentHandoff
} from '$lib/server/collaboration/handoffs.js';
import { getDatabasePool } from '$lib/server/database/pool.js';

export async function DELETE({ params, request }) {
  try {
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);
    await cancelAgentHandoff(pool, access, params.handoffId);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return json({ message: error.message }, { status: 401 });
    }
    if (error instanceof AgentHandoffError) {
      return json({ message: error.message }, { status: 404 });
    }
    throw error;
  }
}
