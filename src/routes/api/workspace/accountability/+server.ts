import { json } from '@sveltejs/kit';

import { getRelayAuth } from '$lib/server/auth.js';
import { authorizeWorkspaceRequest, WorkspaceAccessError } from '$lib/server/authentication/authorization.js';
import {
  AccountabilityError,
  loadCollaborationAccountability,
  submitCollaborationFeedback
} from '$lib/server/collaboration/accountability.js';
import { getDatabasePool } from '$lib/server/database/pool.js';

export async function GET({ request, url }) {
  try {
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);
    const projectId = url.searchParams.get('projectId');
    if (!projectId) return json({ message: 'Project is required' }, { status: 400 });
    return json(await loadCollaborationAccountability(pool, access, projectId));
  } catch (error) {
    if (error instanceof WorkspaceAccessError) return json({ message: error.message }, { status: 403 });
    if (error instanceof AccountabilityError) return json({ message: error.message }, { status: 400 });
    throw error;
  }
}

export async function POST({ request }) {
  try {
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);
    await submitCollaborationFeedback(pool, access, await request.json());
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof WorkspaceAccessError) return json({ message: error.message }, { status: 403 });
    if (error instanceof AccountabilityError || error instanceof SyntaxError) {
      return json({ message: error instanceof Error ? error.message : 'invalid feedback' }, { status: 400 });
    }
    throw error;
  }
}
