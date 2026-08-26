import { json } from '@sveltejs/kit';

import { getRelayAuth } from '$lib/server/auth.js';
import {
  acceptWorkspaceInvitation,
  WorkspaceInvitationError
} from '$lib/server/authentication/invitations.js';
import { getDatabasePool } from '$lib/server/database/pool.js';

export async function POST({ params, request }) {
  try {
    const accepted = await acceptWorkspaceInvitation(
      getDatabasePool(),
      getRelayAuth(),
      request.headers,
      params.token
    );
    return json(accepted, { status: 201 });
  } catch (error) {
    if (error instanceof WorkspaceInvitationError) {
      return json({ message: error.message }, { status: 400 });
    }
    throw error;
  }
}
