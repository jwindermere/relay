import { json } from '@sveltejs/kit';

import { getRelayAuth } from '$lib/server/auth.js';
import { authorizeWorkspaceRequest, WorkspaceAccessError } from '$lib/server/authentication/authorization.js';
import {
  ChannelCallError,
  endChannelCall,
  joinChannelCall,
  loadActiveChannelCall,
  startChannelCall
} from '$lib/server/collaboration/calls.js';
import { getDatabasePool } from '$lib/server/database/pool.js';

export async function GET({ params, request }) {
  try {
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);
    return json({ call: await loadActiveChannelCall(pool, access, params.channelId) });
  } catch (error) {
    return callErrorResponse(error);
  }
}

export async function POST({ params, request }) {
  try {
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);
    const body = await request.json() as { action?: unknown };
    if (body.action === 'start') {
      return json({ call: await startChannelCall(pool, access, params.channelId) });
    }
    if (body.action === 'join') {
      return json({ call: await joinChannelCall(pool, access, params.channelId) });
    }
    if (body.action === 'end') {
      await endChannelCall(pool, access, params.channelId);
      return json({ call: null });
    }
    return json({ message: 'Call action must be start, join, or end' }, { status: 400 });
  } catch (error) {
    return callErrorResponse(error);
  }
}

function callErrorResponse(error: unknown): Response {
  if (error instanceof WorkspaceAccessError) {
    return json({ message: error.message }, { status: 401 });
  }
  if (error instanceof ChannelCallError) {
    return json({ message: error.message }, { status: 400 });
  }
  throw error;
}
