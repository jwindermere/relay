import { redirect } from '@sveltejs/kit';

import { getRelayAuth } from '$lib/server/auth.js';
import { authorizeWorkspaceRequest } from '$lib/server/authentication/authorization.js';
import { getDatabasePool } from '$lib/server/database/pool.js';

export async function load({ request }) {
  try {
    const access = await authorizeWorkspaceRequest(
      getDatabasePool(),
      getRelayAuth(),
      request.headers
    );
    return {
      email: access.identity.email,
      role: access.membership.role,
      workspaceName: access.workspace.name
    };
  } catch {
    redirect(303, '/sign-in');
  }
}
