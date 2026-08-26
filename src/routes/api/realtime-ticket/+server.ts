import { json } from '@sveltejs/kit';

import { getRelayAuth } from '$lib/server/auth.js';
import {
  authorizeWorkspaceRequest,
  WorkspaceAccessError
} from '$lib/server/authentication/authorization.js';
import { getDatabasePool } from '$lib/server/database/pool.js';
import { issueRealtimeTicket, requireRealtimeSecret } from '$lib/server/realtime-ticket.js';

export async function POST({ request }) {
  try {
    const access = await authorizeWorkspaceRequest(
      getDatabasePool(),
      getRelayAuth(),
      request.headers
    );
    return json({
      ticket: issueRealtimeTicket(access.identity.sessionId, requireRealtimeSecret())
    });
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return json({ message: error.message }, { status: 401 });
    }
    throw error;
  }
}
