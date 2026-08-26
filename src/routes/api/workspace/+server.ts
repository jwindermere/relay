import { json } from '@sveltejs/kit';

import { getRelayAuth } from '$lib/server/auth.js';
import {
  authorizeWorkspaceRequest,
  WorkspaceAccessError
} from '$lib/server/authentication/authorization.js';
import { getDatabasePool } from '$lib/server/database/pool.js';

export async function GET({ request }) {
  try {
    const access = await authorizeWorkspaceRequest(
      getDatabasePool(),
      getRelayAuth(),
      request.headers
    );
    return json({
      workspace: access.workspace,
      membership: access.membership,
      identity: { email: access.identity.email }
    });
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return json({ message: error.message }, { status: 401 });
    }
    throw error;
  }
}
