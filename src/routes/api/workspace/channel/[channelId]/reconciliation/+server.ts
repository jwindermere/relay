import { json } from '@sveltejs/kit';

import { getRelayAuth } from '$lib/server/auth.js';
import {
  authorizeWorkspaceRequest,
  WorkspaceAccessError
} from '$lib/server/authentication/authorization.js';
import { ChannelMessageError } from '$lib/server/collaboration/channel.js';
import { loadChannelReconciliation } from '$lib/server/collaboration/reconciliation.js';
import { getDatabasePool } from '$lib/server/database/pool.js';
import { decodeAgentRunCursors } from '$lib/reconciliation.js';

export async function GET({ params, request, url }) {
  try {
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);
    return json(await loadChannelReconciliation(
      pool,
      access,
      params.channelId,
      decodeAgentRunCursors(url.searchParams.get('after'))
    ));
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return json({ message: error.message }, { status: 401 });
    }
    if (error instanceof ChannelMessageError) {
      return json({ message: error.message }, { status: 404 });
    }
    throw error;
  }
}
