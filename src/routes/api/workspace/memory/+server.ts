import { json } from '@sveltejs/kit';

import { getRelayAuth } from '$lib/server/auth.js';
import { authorizeWorkspaceRequest, WorkspaceAccessError } from '$lib/server/authentication/authorization.js';
import {
  createProjectMemory,
  FindingError,
  setProjectMemoryLifecycle
} from '$lib/server/collaboration/findings.js';
import { getDatabasePool } from '$lib/server/database/pool.js';

export async function POST({ request }) {
  try {
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);
    const id = await createProjectMemory(pool, access, await request.json());
    return json({ id }, { status: 201 });
  } catch (error) {
    if (error instanceof WorkspaceAccessError) return json({ message: error.message }, { status: 403 });
    if (error instanceof FindingError || error instanceof SyntaxError) {
      return json({ message: error instanceof Error ? error.message : 'invalid memory request' }, { status: 400 });
    }
    throw error;
  }
}

export async function PATCH({ request }) {
  try {
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);
    const input = await request.json();
    await setProjectMemoryLifecycle(pool, access, input.memoryId, input.lifecycle);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof WorkspaceAccessError) return json({ message: error.message }, { status: 403 });
    if (error instanceof FindingError || error instanceof SyntaxError) {
      return json({ message: error instanceof Error ? error.message : 'invalid memory update' }, { status: 400 });
    }
    throw error;
  }
}
