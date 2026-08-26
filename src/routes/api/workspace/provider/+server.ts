import { json } from '@sveltejs/kit';

import { getRelayAuth } from '$lib/server/auth.js';
import {
  authorizeWorkspaceRequest,
  WorkspaceAccessError
} from '$lib/server/authentication/authorization.js';
import { getDatabasePool } from '$lib/server/database/pool.js';
import { getManagedCodexRuntime } from '$lib/server/provider/codex-runtime.js';
import {
  beginProviderConnectionLogin,
  disableProviderConnection,
  disconnectProviderConnection,
  loadProviderConnection,
  ProviderConnectionError
} from '$lib/server/provider/connection.js';

export async function GET({ request }) {
  try {
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);
    return json({ connection: await loadProviderConnection(pool, access) });
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return json({ message: error.message }, { status: 401 });
    }
    throw error;
  }
}

export async function POST({ request }) {
  try {
    const input: unknown = await request.json();
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new ProviderConnectionError('invalid Provider connection request');
    }
    const requestInput = input as Record<string, unknown>;
    if (Object.keys(requestInput).some((key) => key !== 'action')) {
      throw new ProviderConnectionError(
        'Provider credentials are managed locally by Codex and cannot be submitted to Relay'
      );
    }
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);
    const runtime = getManagedCodexRuntime();

    if (requestInput.action === 'connect') {
      const result = await beginProviderConnectionLogin(pool, access, runtime);
      return json(result, { status: 202 });
    }
    if (requestInput.action === 'disable') {
      return json({ connection: await disableProviderConnection(pool, access) });
    }
    if (requestInput.action === 'disconnect') {
      return json({ connection: await disconnectProviderConnection(pool, access, runtime) });
    }
    throw new ProviderConnectionError('invalid Provider connection action');
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return json({ message: error.message }, { status: 403 });
    }
    if (error instanceof ProviderConnectionError || error instanceof SyntaxError) {
      return json(
        { message: error instanceof Error ? error.message : 'invalid Provider connection request' },
        { status: 400 }
      );
    }
    throw error;
  }
}
