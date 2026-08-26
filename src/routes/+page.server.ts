import { randomUUID } from 'node:crypto';
import { fail, redirect } from '@sveltejs/kit';

import { getRelayAuth } from '$lib/server/auth.js';
import {
  authorizeWorkspaceRequest,
  WorkspaceAccessError
} from '$lib/server/authentication/authorization.js';
import {
  ChannelMessageError,
  loadSharedAgentChannel,
  postChannelMessage
} from '$lib/server/collaboration/channel.js';
import { loadChannelReconciliation } from '$lib/server/collaboration/reconciliation.js';
import { getDatabasePool } from '$lib/server/database/pool.js';
import { getGitHubRepositoryGateway } from '$lib/server/github/api.js';
import { loadLinkedRepository } from '$lib/server/github/connection.js';
import { loadProviderConnection } from '$lib/server/provider/connection.js';

export async function load({ request }) {
  try {
    const pool = getDatabasePool();
    const access = await authorizeWorkspaceRequest(
      pool,
      getRelayAuth(),
      request.headers
    );
    const [sharedChannel, providerConnection, linkedRepository] = await Promise.all([
      loadSharedAgentChannel(pool, access),
      loadProviderConnection(pool, access),
      loadLinkedRepository(pool, access)
    ]);
    return {
      email: access.identity.email,
      role: access.membership.role,
      workspaceName: access.workspace.name,
      sharedChannel,
      providerConnection,
      linkedRepository,
      reconciliation: await loadChannelReconciliation(
        pool,
        access,
        sharedChannel.channel.id,
        {}
      ),
      messageSubmissionId: randomUUID(),
      readyForAgentExecution:
        providerConnection.readyForExecution && linkedRepository.readyForAutonomousWork
    };
  } catch (error) {
    if (error instanceof WorkspaceAccessError) redirect(303, '/sign-in');
    throw error;
  }
}

export const actions = {
  send: async ({ request }) => {
    try {
      const pool = getDatabasePool();
      const access = await authorizeWorkspaceRequest(pool, getRelayAuth(), request.headers);
      const form = await request.formData();
      const channelId = form.get('channelId');
      const body = form.get('body');
      const parentMessageId = form.get('parentMessageId');
      const submissionId = form.get('submissionId');
      if (
        typeof channelId !== 'string'
        || typeof body !== 'string'
        || typeof submissionId !== 'string'
        || !submissionId.trim()
      ) {
        return fail(400, { message: 'invalid Message request' });
      }
      await postChannelMessage(
        pool,
        access,
        {
          channelId,
          body,
          submissionId,
          ...(typeof parentMessageId === 'string' && parentMessageId ? { parentMessageId } : {})
        },
        { getRepositoryGateway: getGitHubRepositoryGateway }
      );
      return { sent: true };
    } catch (error) {
      if (error instanceof ChannelMessageError) {
        return fail(400, { message: error.message });
      }
      if (error instanceof WorkspaceAccessError) {
        return fail(401, { message: error.message });
      }
      throw error;
    }
  }
};
