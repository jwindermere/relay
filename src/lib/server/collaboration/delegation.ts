import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import type { GitHubRepositoryGateway } from '../github/connection.js';
import {
  evaluateRepositoryProtection,
  type RepositoryProtectionResult
} from '../github/protection.js';

export type AgentMentionResult =
  | { status: 'accepted'; agentId: string; taskId: string; agentRunId: string }
  | {
      status: 'conversation';
      agentId: string;
      conversationTurnId: string;
      turnStatus: 'queued' | 'working' | 'completed' | 'failed';
    }
  | { status: 'rejected'; agentId: string; reason: string }
  | null;

interface AgentCandidate {
  id: string;
  name: string;
  role_label: string;
  enabled: boolean;
  status: 'idle' | 'working' | 'waiting' | 'disabled';
}

interface MentionContext {
  messageId: string;
  workspaceId: string;
  channelId: string;
  body: string;
  getRepositoryGateway?: () => GitHubRepositoryGateway;
}

type AgentRequestSafetyDecision =
  | { eligible: true; policy: 'mvp-engineering-autonomy-v1' }
  | { eligible: false; policy: 'mvp-engineering-autonomy-v1'; reason: string };

const forbiddenAutonomousRequestPatterns: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /^merge\s+(?:the\s+)?(?:pull\s+request|pr|protected\s+branch)\b/iu,
    reason: 'Relay cannot accept requests to merge, deploy, or administer a repository.'
  },
  {
    pattern: /^deploy\b/iu,
    reason: 'Relay cannot accept requests to merge, deploy, or administer a repository.'
  },
  {
    pattern: /^administer\s+(?:the\s+)?(?:organisation|organization|repository)\b/iu,
    reason: 'Relay cannot accept requests to merge, deploy, or administer a repository.'
  },
  {
    pattern: /^(?:force[- ]?push|git\s+(?:reset\s+--hard|clean\s+-\S*f)|rm\s+-\S*r\S*f)\b/iu,
    reason: 'Relay cannot accept destructive repository requests.'
  },
  {
    pattern: /^(?:delete|remove|wipe|erase|destroy|purge)\s+(?:(?:the|all|every)\s+)*(?:branch|repository|repo|files|data|database|production\s+data)\b/iu,
    reason: 'Relay cannot accept destructive repository requests.'
  },
  {
    pattern: /^(?:drop|truncate)\s+(?:(?:the|all|every)\s+)*(?:database|schema|table|tables)\b/iu,
    reason: 'Relay cannot accept destructive data requests.'
  },
  {
    pattern: /^(?:create|edit|modify|update|delete)\s+(?:a\s+|the\s+)?(?:github\s+actions?\s+)?(?:workflow|repository\s+(?:settings|secrets|collaborators))\b/iu,
    reason: 'Relay cannot accept requests to modify repository workflows.'
  },
  {
    pattern: /^push\s+(?:directly\s+)?(?:to\s+)?(?:main|master|the\s+(?:default|protected|release)\s+branch)\b/iu,
    reason: 'Relay cannot accept direct writes to protected branches.'
  },
  {
    pattern: /^(?:publish|release)\s+(?:the\s+)?(?:package|build|version|release)\b/iu,
    reason: 'Relay cannot accept release or publishing requests.'
  }
];

export function explicitAgentMentionPattern(agentName: string): RegExp {
  const escaped = agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}_.+@-])@${escaped}(?![\\p{L}\\p{N}_-])`, 'iu');
}

function evaluateAgentRequestSafety(body: string, agentName: string): AgentRequestSafetyDecision {
  const request = body
    .replace(explicitAgentMentionPattern(agentName), ' ')
    .trim()
    .replace(/^[\s,.:;!?-]+/u, '')
    .replace(
      /^(?:(?:hey|hi)\s+)?(?:(?:please|kindly)\s+|(?:can|could|would|will)\s+you\s+|i\s+(?:need|want)\s+you\s+to\s+|go\s+ahead\s+and\s+)*/iu,
      ''
    );
  const rejection = forbiddenAutonomousRequestPatterns.find(({ pattern }) => pattern.test(request));
  return rejection
    ? { eligible: false, policy: 'mvp-engineering-autonomy-v1', reason: rejection.reason }
    : { eligible: true, policy: 'mvp-engineering-autonomy-v1' };
}

async function recordRejection(
  client: PoolClient,
  context: MentionContext,
  agent: AgentCandidate,
  reason: string
): Promise<AgentMentionResult> {
  await client.query(
    `UPDATE public.message
     SET agent_mention_status = 'rejected', mentioned_agent_id = $2,
         agent_mention_reason = $3
     WHERE id = $1`,
    [context.messageId, agent.id, reason]
  );
  return { status: 'rejected', agentId: agent.id, reason };
}

export async function acceptEligibleAgentMention(
  client: PoolClient,
  context: MentionContext
): Promise<AgentMentionResult> {
  const agents = await client.query<AgentCandidate>(
    `SELECT id, name, role_label, enabled, status
     FROM public.agent
     WHERE workspace_id = $1
     ORDER BY length(name) DESC, id
     FOR UPDATE`,
    [context.workspaceId]
  );
  const agent = agents.rows.find(({ name }) => explicitAgentMentionPattern(name).test(context.body));
  if (!agent) return null;

  const scope = await client.query<{
    project_id: string | null;
    project_name: string | null;
    channel_name: string;
    author_is_active_pilot: boolean;
    author_is_project_member: boolean;
    agent_is_project_member: boolean;
  }>(
    `SELECT c.project_id, project.name AS project_name, c.name AS channel_name,
            (author.kind = 'pilot' AND membership.revoked_at IS NULL) AS author_is_active_pilot,
            EXISTS (
              SELECT 1 FROM public.project_membership author_project
              WHERE author_project.project_id = c.project_id
                AND author_project.workspace_member_id = author.id
            ) AS author_is_project_member,
            EXISTS (
              SELECT 1
              FROM public.workspace_member agent_member
              JOIN public.project_membership agent_project
                ON agent_project.workspace_member_id = agent_member.id
              WHERE agent_member.agent_id = $4
                AND agent_project.project_id = c.project_id
            ) AS agent_is_project_member
     FROM public.message message
     JOIN public.channel c ON c.id = message.channel_id
     LEFT JOIN public.project project
       ON project.id = c.project_id AND project.workspace_id = c.workspace_id
     JOIN public.workspace_member author ON author.id = message.author_workspace_member_id
     LEFT JOIN public.workspace_membership membership
       ON membership.id = author.pilot_membership_id
     WHERE message.id = $1 AND message.workspace_id = $2 AND c.id = $3`,
    [context.messageId, context.workspaceId, context.channelId, agent.id]
  );
  const readiness = scope.rows[0];
  if (!readiness?.author_is_active_pilot) {
    return recordRejection(client, context, agent, 'Active Pilot member access is required.');
  }
  if (!readiness.project_id || !readiness.author_is_project_member) {
    return recordRejection(client, context, agent, 'This Channel is not eligible for Agent work.');
  }
  if (!readiness.agent_is_project_member) {
    return recordRejection(client, context, agent, `${agent.name} is not a member of this Project.`);
  }
  if (!agent.enabled || agent.status === 'disabled') {
    return recordRejection(client, context, agent, `${agent.name} is disabled and cannot accept new work.`);
  }

  const provider = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM public.provider_connection
     WHERE workspace_id = $1
     FOR SHARE`,
    [context.workspaceId]
  );
  if (provider.rows[0]?.status !== 'ready') {
    return recordRejection(
      client,
      context,
      agent,
      'A ready Codex Provider connection is required before new Agent work.'
    );
  }

  const repository = await client.query<{
    id: string;
    app_id: string;
    installation_id: string;
    repository_id: string;
    release_branches: string[];
    verification: RepositoryProtectionResult;
    connection_status: string;
  }>(
    `SELECT repository.id, connection.app_id, connection.installation_id,
            repository.repository_id, repository.release_branches, repository.verification,
            connection.status AS connection_status
     FROM public.linked_repository repository
     JOIN public.github_connection connection
       ON connection.id = repository.github_connection_id
       AND connection.workspace_id = repository.workspace_id
     WHERE repository.workspace_id = $1 AND repository.project_id = $2
     FOR UPDATE OF repository, connection`,
    [context.workspaceId, readiness.project_id]
  );
  const linkedRepository = repository.rows[0];
  if (!linkedRepository || linkedRepository.connection_status !== 'active') {
    return recordRejection(
      client,
      context,
      agent,
      'A verified Linked pilot repository is required before new Agent work.'
    );
  }
  let repositoryEvidence;
  try {
    repositoryEvidence = await context.getRepositoryGateway?.().inspect({
      installationId: linkedRepository.installation_id,
      repositoryId: linkedRepository.repository_id,
      releaseBranches: linkedRepository.release_branches
    });
  } catch {
    repositoryEvidence = undefined;
  }
  if (
    !repositoryEvidence
    || String(repositoryEvidence.appId) !== linkedRepository.app_id
    || String(repositoryEvidence.installation.id) !== linkedRepository.installation_id
    || String(repositoryEvidence.repository.id) !== linkedRepository.repository_id
  ) {
    await client.query(
      `UPDATE public.linked_repository
       SET ready_for_autonomous_work = false, checked_at = now(), updated_at = now()
       WHERE id = $1`,
      [linkedRepository.id]
    );
    return recordRejection(
      client,
      context,
      agent,
      'The Linked pilot repository could not be verified for new Agent work.'
    );
  }
  const repositoryProtection = evaluateRepositoryProtection(
    repositoryEvidence,
    linkedRepository.release_branches,
    linkedRepository.verification.bypassAttestations ?? []
  );
  await client.query(
    `UPDATE public.linked_repository
     SET ready_for_autonomous_work = $2, verification = $3,
         checked_at = now(), updated_at = now()
     WHERE id = $1`,
    [
      linkedRepository.id,
      repositoryProtection.readyForAutonomousWork,
      JSON.stringify(repositoryProtection)
    ]
  );
  if (!repositoryProtection.readyForAutonomousWork) {
    return recordRejection(
      client,
      context,
      agent,
      'Current repository permissions and protected-branch controls are not safe for Agent work.'
    );
  }
  if (agent.status !== 'idle') {
    return recordRejection(
      client,
      context,
      agent,
      `${agent.name} has no capacity for another request yet.`
    );
  }
  const safety = evaluateAgentRequestSafety(context.body, agent.name);
  if (!safety.eligible) return recordRejection(client, context, agent, safety.reason);

  const thread = await client.query<{
    id: string;
    parent_message_id: string | null;
    body: string;
    author_workspace_member_id: string;
    created_at: Date;
  }>(
    `WITH initiating AS (
       SELECT id, COALESCE(parent_message_id, id) AS root_id, created_at
       FROM public.message WHERE id = $1
     )
     SELECT message.id, message.parent_message_id, message.body,
            message.author_workspace_member_id, message.created_at
     FROM public.message message
     CROSS JOIN initiating
     WHERE message.channel_id = $2
       AND (message.id = initiating.root_id OR message.parent_message_id = initiating.root_id)
       AND (message.created_at, message.id) <= (initiating.created_at, initiating.id)
     ORDER BY message.created_at, message.id`,
    [context.messageId, context.channelId]
  );
  const requestMessage = thread.rows.find(({ id }) => id === context.messageId);
  if (!requestMessage) throw new Error('accepted Agent mention Message could not be snapshotted');

  const taskId = randomUUID();
  const agentRunId = randomUUID();
  const task = await client.query<{ id: string }>(
    `INSERT INTO public.task (
       id, workspace_id, project_id, assigned_agent_id, source_message_id,
       requested_by_workspace_member_id, request_snapshot, context_snapshot
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (source_message_id) DO NOTHING
     RETURNING id`,
    [
      taskId,
      context.workspaceId,
      readiness.project_id,
      agent.id,
      context.messageId,
      requestMessage.author_workspace_member_id,
      context.body,
      JSON.stringify({
        project: { id: readiness.project_id, name: readiness.project_name },
        channel: { id: context.channelId, name: readiness.channel_name },
        agent: { id: agent.id, name: agent.name, roleLabel: agent.role_label },
        repository: {
          linkedRepositoryId: linkedRepository.id,
          repositoryId: linkedRepository.repository_id,
          owner: repositoryEvidence.repository.owner,
          name: repositoryEvidence.repository.name,
          defaultBranch: repositoryEvidence.repository.defaultBranch,
          releaseBranches: linkedRepository.release_branches
        },
        safetyPolicy: safety.policy,
        messages: thread.rows.map((message) => ({
          id: message.id,
          parentMessageId: message.parent_message_id,
          body: message.body,
          authorWorkspaceMemberId: message.author_workspace_member_id,
          createdAt: message.created_at.toISOString()
        }))
      })
    ]
  );
  if (!task.rows[0]) {
    const existing = await client.query<{ task_id: string; agent_run_id: string }>(
      `SELECT task.id AS task_id, run.id AS agent_run_id
       FROM public.task task
       JOIN public.agent_run run ON run.task_id = task.id AND run.attempt_number = 1
       WHERE task.source_message_id = $1`,
      [context.messageId]
    );
    const accepted = existing.rows[0];
    if (!accepted) throw new Error('accepted Agent mention is missing its initial AgentRun');
    return {
      status: 'accepted',
      agentId: agent.id,
      taskId: accepted.task_id,
      agentRunId: accepted.agent_run_id
    };
  }

  await client.query(
    `INSERT INTO public.agent_run (
       id, workspace_id, task_id, agent_id, provider_connection_id,
       linked_repository_id, attempt_number, status,
       requested_by_workspace_member_id, request_message_id
     ) VALUES ($1, $2, $3, $4, $5, $6, 1, 'queued', $7, $8)`,
    [
      agentRunId,
      context.workspaceId,
      taskId,
      agent.id,
      provider.rows[0]!.id,
      linkedRepository.id,
      requestMessage.author_workspace_member_id,
      context.messageId
    ]
  );
  const event = await client.query<{ id: number }>(
    `INSERT INTO public.agent_run_event (
       workspace_id, agent_run_id, sequence, event_type, status, summary
     ) VALUES ($1, $2, 1, 'run.queued', 'queued', 'Engineering request queued')
     RETURNING id`,
    [context.workspaceId, agentRunId]
  );
  await client.query(
    `INSERT INTO public.notification_outbox (
       workspace_id, agent_run_event_id, topic, payload
     ) VALUES ($1, $2, 'agent_run.event', $3)`,
    [
      context.workspaceId,
      event.rows[0]!.id,
      JSON.stringify({ agentRunId, eventType: 'run.queued', sequence: 1 })
    ]
  );
  await client.query(
    `UPDATE public.message
     SET agent_mention_status = 'accepted', mentioned_agent_id = $2
     WHERE id = $1`,
    [context.messageId, agent.id]
  );
  return { status: 'accepted', agentId: agent.id, taskId, agentRunId };
}
