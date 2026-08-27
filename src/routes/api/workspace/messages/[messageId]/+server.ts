import { json } from '@sveltejs/kit';

import { getRelayAuth } from '$lib/server/auth.js';
import { authorizeWorkspaceRequest, WorkspaceAccessError } from '$lib/server/authentication/authorization.js';
import { deleteChannelMessage, MessageDeletionError } from '$lib/server/collaboration/messages.js';
import { getDatabasePool } from '$lib/server/database/pool.js';

export async function DELETE({ params, request }) {
  try {
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);
    await deleteChannelMessage(pool, access, params.messageId);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof WorkspaceAccessError) return json({ message: error.message }, { status: 403 });
    if (error instanceof MessageDeletionError) return json({ message: error.message }, { status: 400 });
    throw error;
  }
}
