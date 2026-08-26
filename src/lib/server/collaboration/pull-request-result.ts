import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

export interface PullRequestPublication {
  workspaceId: string;
  projectId: string;
  taskId: string;
  agentRunId: string;
  repositoryId: string;
  actorWorkspaceMemberId: string;
  rootMessageId: string;
  channelId: string;
  branch: string;
  commitSha: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
}

export async function recordPullRequestResult(
  client: PoolClient,
  publication: PullRequestPublication
): Promise<string> {
  const existing = await client.query<{ result_message_id: string }>(
    'SELECT result_message_id FROM public.artifact WHERE agent_run_id = $1',
    [publication.agentRunId]
  );
  if (existing.rows[0]) return existing.rows[0].result_message_id;

  const resultMessageId = randomUUID();
  await client.query(
    `INSERT INTO public.message (
       id, workspace_id, channel_id, author_workspace_member_id, parent_message_id, body
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      resultMessageId,
      publication.workspaceId,
      publication.channelId,
      publication.actorWorkspaceMemberId,
      publication.rootMessageId,
      `Completed the engineering request. Pull request #${publication.pullRequestNumber} is ready for human review.`
    ]
  );
  await client.query(
    `INSERT INTO public.notification_outbox (workspace_id, message_id, topic, payload)
     VALUES ($1, $2, 'channel.message', $3)`,
    [publication.workspaceId, resultMessageId, { messageId: resultMessageId }]
  );
  await client.query(
    `INSERT INTO public.artifact (
       id, workspace_id, project_id, task_id, agent_run_id, result_message_id, kind,
       repository_id, branch, commit_sha, pull_request_number, url
     ) VALUES ($1, $2, $3, $4, $5, $6, 'github_pull_request', $7, $8, $9, $10, $11)`,
    [
      randomUUID(), publication.workspaceId, publication.projectId, publication.taskId,
      publication.agentRunId, resultMessageId, publication.repositoryId, publication.branch,
      publication.commitSha, publication.pullRequestNumber, publication.pullRequestUrl
    ]
  );
  return resultMessageId;
}
