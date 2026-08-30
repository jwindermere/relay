import { json } from '@sveltejs/kit';

import { getRelayAuth } from '$lib/server/auth.js';
import { authorizeWorkspaceRequest, WorkspaceAccessError } from '$lib/server/authentication/authorization.js';
import { correctMessageIntent, MessageIntentError } from '$lib/server/collaboration/message-intent.js';
import { getDatabasePool } from '$lib/server/database/pool.js';

export async function PATCH({ params, request }) {
  try {
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);
    const input = await request.json();
    await correctMessageIntent(pool, access, params.messageId, input);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof WorkspaceAccessError) return json({ message: error.message }, { status: 403 });
    if (error instanceof MessageIntentError || error instanceof SyntaxError) {
      return json({ message: error instanceof Error ? error.message : 'invalid correction' }, { status: 400 });
    }
    throw error;
  }
}
