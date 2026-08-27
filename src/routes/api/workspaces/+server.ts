import { json } from '@sveltejs/kit';

import { getRelayAuth } from '$lib/server/auth.js';
import {
  ACTIVE_WORKSPACE_COOKIE,
  authorizeWorkspaceRequest,
  WorkspaceAccessError
} from '$lib/server/authentication/authorization.js';
import {
  createWorkspace,
  requireAvailableWorkspace,
  WorkspaceConfigurationError
} from '$lib/server/collaboration/workspaces.js';
import { getDatabasePool } from '$lib/server/database/pool.js';

const cookieOptions = (secure: boolean) => ({
  path: '/',
  httpOnly: true,
  sameSite: 'lax' as const,
  secure,
  maxAge: 60 * 60 * 24 * 365
});

export async function POST({ request, cookies, url }) {
  try {
    const input = await request.json() as { name?: unknown };
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);
    const workspace = await createWorkspace(pool, access, {
      name: typeof input.name === 'string' ? input.name : ''
    });
    cookies.set(ACTIVE_WORKSPACE_COOKIE, workspace.id, cookieOptions(url.protocol === 'https:'));
    return json({ workspace }, { status: 201 });
  } catch (error) {
    if (error instanceof WorkspaceAccessError) return json({ message: error.message }, { status: 403 });
    if (error instanceof WorkspaceConfigurationError || error instanceof SyntaxError) {
      return json({ message: error instanceof Error ? error.message : 'invalid Workspace request' }, { status: 400 });
    }
    throw error;
  }
}

export async function PATCH({ request, cookies, url }) {
  try {
    const input = await request.json() as { workspaceId?: unknown };
    if (typeof input.workspaceId !== 'string' || !input.workspaceId) {
      throw new WorkspaceConfigurationError('Workspace selection is required');
    }
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);
    await requireAvailableWorkspace(pool, access, input.workspaceId);
    cookies.set(ACTIVE_WORKSPACE_COOKIE, input.workspaceId, cookieOptions(url.protocol === 'https:'));
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof WorkspaceAccessError) return json({ message: error.message }, { status: 403 });
    if (error instanceof WorkspaceConfigurationError || error instanceof SyntaxError) {
      return json({ message: error instanceof Error ? error.message : 'invalid Workspace request' }, { status: 400 });
    }
    throw error;
  }
}
