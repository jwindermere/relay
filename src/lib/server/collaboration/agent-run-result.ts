import type { PoolClient } from 'pg';

export type AgentRunFailureResult =
  | 'no_repository_changes'
  | 'github_publication_failed'
  | 'provider_failed';

const FAILURE_MESSAGES: Record<AgentRunFailureResult, string> = {
  no_repository_changes:
    'I finished checking the repository, but there were no changes to publish, so no pull request was created.',
  github_publication_failed:
    'I finished the engineering work, but Relay could not publish it to GitHub. The request needs review.',
  provider_failed:
    'I could not complete the engineering request because the Codex run failed.'
};

export async function recordAgentRunFailureResult(
  client: PoolClient,
  agentRunId: string,
  result: AgentRunFailureResult
): Promise<void> {
  const messageId = `agent-run-result:${agentRunId}`;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO public.message (
       id, workspace_id, channel_id, author_workspace_member_id, parent_message_id, body
     )
     SELECT $2, run.workspace_id, source.channel_id, agent_member.id,
            COALESCE(source.parent_message_id, source.id), $3
     FROM public.agent_run run
     JOIN public.task task ON task.id = run.task_id AND task.workspace_id = run.workspace_id
     JOIN public.message source
       ON source.id = task.source_message_id AND source.workspace_id = run.workspace_id
     JOIN public.workspace_member agent_member
       ON agent_member.agent_id = run.agent_id
      AND agent_member.workspace_id = run.workspace_id
     WHERE run.id = $1
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [agentRunId, messageId, FAILURE_MESSAGES[result]]
  );
  if (!inserted.rows[0]) return;
  await client.query(
    `INSERT INTO public.notification_outbox (workspace_id, message_id, topic, payload)
     SELECT workspace_id, id, 'channel.message', jsonb_build_object('messageId', id)
     FROM public.message WHERE id = $1`,
    [messageId]
  );
}
