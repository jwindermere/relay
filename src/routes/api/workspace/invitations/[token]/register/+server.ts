import { json } from '@sveltejs/kit';

import { getRelayAuth } from '$lib/server/auth.js';
import {
  registerInvitedAccount,
  WorkspaceInvitationError
} from '$lib/server/authentication/invitations.js';
import { getDatabasePool } from '$lib/server/database/pool.js';

export async function POST({ params, request }) {
  try {
    const input = await request.json() as { name?: unknown; password?: unknown };
    const account = await registerInvitedAccount(
      getDatabasePool(),
      getRelayAuth(),
      params.token,
      {
        name: typeof input.name === 'string' ? input.name : '',
        password: typeof input.password === 'string' ? input.password : ''
      }
    );
    return json({ account: { email: account.email } }, { status: 201 });
  } catch (error) {
    if (error instanceof WorkspaceInvitationError || error instanceof SyntaxError) {
      return json(
        { message: error instanceof Error ? error.message : 'invalid registration request' },
        { status: 400 }
      );
    }
    throw error;
  }
}
