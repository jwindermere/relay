import { json } from '@sveltejs/kit';

import { getRelayAuth } from '$lib/server/auth.js';
import {
  authorizeWorkspaceRequest,
  WorkspaceAccessError
} from '$lib/server/authentication/authorization.js';
import { getDatabasePool } from '$lib/server/database/pool.js';
import { getGitHubRepositoryGateway } from '$lib/server/github/api.js';
import {
  disableGitHubConnection,
  linkGitHubRepository,
  loadLinkedRepository,
  LinkedRepositoryError,
  verifyLinkedRepository
} from '$lib/server/github/connection.js';

export async function GET({ request }) {
  try {
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);
    return json({ connection: await loadLinkedRepository(pool, access) });
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
      throw new LinkedRepositoryError('invalid GitHub repository request');
    }
    const requestInput = input as Record<string, unknown>;
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);

    if (requestInput.action === 'link') {
      if (
        Object.keys(requestInput).some((key) =>
          !['action', 'installationId', 'releaseBranches'].includes(key)
        )
        || typeof requestInput.installationId !== 'string'
        || !Array.isArray(requestInput.releaseBranches)
        || requestInput.releaseBranches.some((branch) => typeof branch !== 'string')
      ) {
        throw new LinkedRepositoryError(
          'link requires only a GitHub installation ID and release branch names'
        );
      }
      return json({
        connection: await linkGitHubRepository(pool, access, {
          installationId: requestInput.installationId,
          releaseBranches: requestInput.releaseBranches as string[]
        }, getGitHubRepositoryGateway())
      });
    }

    if (Object.keys(requestInput).some((key) => key !== 'action')) {
      throw new LinkedRepositoryError('invalid GitHub repository request');
    }
    if (requestInput.action === 'verify') {
      return json({
        connection: await verifyLinkedRepository(pool, access, getGitHubRepositoryGateway())
      });
    }
    if (requestInput.action === 'disable') {
      return json({ connection: await disableGitHubConnection(pool, access) });
    }
    throw new LinkedRepositoryError('invalid GitHub repository action');
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return json({ message: error.message }, { status: 403 });
    }
    if (error instanceof LinkedRepositoryError || error instanceof SyntaxError) {
      return json(
        { message: error instanceof Error ? error.message : 'invalid GitHub repository request' },
        { status: 400 }
      );
    }
    throw error;
  }
}
