import { json } from '@sveltejs/kit';

import { getRelayAuth } from '$lib/server/auth.js';
import {
  authorizeWorkspaceRequest,
  WorkspaceAccessError
} from '$lib/server/authentication/authorization.js';
import {
  issueWorkspaceInvitation,
  WorkspaceInvitationError
} from '$lib/server/authentication/invitations.js';
import { getDatabasePool } from '$lib/server/database/pool.js';

export async function POST({ request }) {
  try {
    const input = await request.json() as { email?: unknown };
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);
    const invitation = await issueWorkspaceInvitation(pool, access, {
      email: typeof input.email === 'string' ? input.email : ''
    });

    return json({
      invitation: {
        id: invitation.id,
        email: invitation.email,
        expiresAt: invitation.expiresAt,
        registrationPath: `/api/workspace/invitations/${invitation.token}/register`,
        acceptancePath: `/api/workspace/invitations/${invitation.token}/accept`
      }
    }, { status: 201 });
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return json({ message: error.message }, { status: 403 });
    }
    if (error instanceof WorkspaceInvitationError || error instanceof SyntaxError) {
      return json(
        { message: error instanceof Error ? error.message : 'invalid invitation request' },
        { status: 400 }
      );
    }
    throw error;
  }
}
