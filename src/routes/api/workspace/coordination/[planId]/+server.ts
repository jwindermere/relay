import { json } from '@sveltejs/kit';

import { getRelayAuth } from '$lib/server/auth.js';
import { authorizeWorkspaceRequest, WorkspaceAccessError } from '$lib/server/authentication/authorization.js';
import {
  CoordinationError,
  decideCoordinationPlan,
  editCoordinationPlan
} from '$lib/server/collaboration/coordination.js';
import { getDatabasePool } from '$lib/server/database/pool.js';

export async function PATCH({ params, request }) {
  try {
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);
    const input = await request.json();
    if (input.action === 'edit') await editCoordinationPlan(pool, access, params.planId, input.plan);
    else await decideCoordinationPlan(pool, access, params.planId, input.action);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof WorkspaceAccessError) return json({ message: error.message }, { status: 403 });
    if (error instanceof CoordinationError || error instanceof SyntaxError) {
      return json({ message: error instanceof Error ? error.message : 'invalid plan decision' }, { status: 400 });
    }
    throw error;
  }
}
