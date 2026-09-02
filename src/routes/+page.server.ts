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
import { loadWorkspaceAgents } from '$lib/server/collaboration/agents.js';
import {
  findAgentTemplateUpgrade,
  listAgentTemplates,
  loadAvailableAgentTemplateCapabilities,
  previewAgentTemplate
} from '$lib/server/collaboration/agent-templates.js';
import { loadActiveChannelCall } from '$lib/server/collaboration/calls.js';
import { loadAvailableWorkspaces } from '$lib/server/collaboration/workspaces.js';
import { loadChannelReconciliation } from '$lib/server/collaboration/reconciliation.js';
import { loadCollaborationAccountability } from '$lib/server/collaboration/accountability.js';
import { getDatabasePool } from '$lib/server/database/pool.js';
import { isJitsiEmbeddingEnabled } from '$lib/server/configuration.js';
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
    const sharedChannel = await loadSharedAgentChannel(pool, access);
    const [providerConnection, linkedRepository, currentUserResult, agentConfiguration, workspaces, agentTemplateCapabilities] = await Promise.all([
      loadProviderConnection(pool, access),
      loadLinkedRepository(pool, access),
      pool.query<{ name: string }>(
        `SELECT name FROM auth."user" WHERE id = $1`,
        [access.identity.userId]
      ),
      loadWorkspaceAgents(pool, access),
      loadAvailableWorkspaces(pool, access),
      loadAvailableAgentTemplateCapabilities(pool, access, sharedChannel.project.id)
    ]);
    const [reconciliation, activeCall, accountability] = await Promise.all([
      loadChannelReconciliation(pool, access, sharedChannel.channel.id, {}),
      loadActiveChannelCall(pool, access, sharedChannel.channel.id),
      loadCollaborationAccountability(pool, access, sharedChannel.project.id)
    ]);
    const agentTemplates = listAgentTemplates();
    return {
      email: access.identity.email,
      role: access.membership.role,
      currentUser: {
        name: currentUserResult.rows[0]?.name ?? access.identity.email,
        email: access.identity.email,
        role: access.membership.role
      },
      workspaceName: access.workspace.name,
      sharedChannel,
      providerConnection,
      linkedRepository,
      agentConfiguration,
      agentTemplates,
      agentTemplatePreviews: Object.fromEntries(agentTemplates.map((template) => [
        template.key,
        previewAgentTemplate(template.key, {
          availableCapabilities: agentTemplateCapabilities,
          existingAgents: agentConfiguration.agents
        })
      ])),
      agentTemplateUpgrades: Object.fromEntries(agentConfiguration.agents.map((agent) => [
        agent.id,
        agent.templateProvenance ? findAgentTemplateUpgrade(agent.templateProvenance) : null
      ])),
      workspaces,
      reconciliation,
      accountability,
      activeCall,
      jitsiEmbeddingEnabled: isJitsiEmbeddingEnabled(),
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
        }
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
