import type { Pool } from 'pg';

import type { PilotJourneyObservation } from '../pilot-journey.js';

export async function observePilotJourney(
  pool: Pool,
  options: { workspaceId?: string; since?: Date } = {}
): Promise<PilotJourneyObservation> {
  const workspaces = await pool.query<{ id: string; name: string }>(
    `SELECT id, name
     FROM public.workspace
     WHERE $1::text IS NULL OR id = $1
     ORDER BY created_at, id
     LIMIT 2`,
    [options.workspaceId ?? null]
  );
  if (workspaces.rows.length === 0) {
    throw new Error(options.workspaceId
      ? `Workspace ${options.workspaceId} does not exist.`
      : 'No Workspace exists.');
  }
  if (workspaces.rows.length > 1) {
    throw new Error('More than one Workspace exists; pass --workspace <id>.');
  }
  const workspace = workspaces.rows[0]!;
  const since = options.since ?? null;

  const [members, mentions, outcomes, artifacts, duplicates] =
    await Promise.all([
      pool.query<{
        id: string;
        name: string;
        active: boolean;
        accepted_delegations: number;
      }>(
        `SELECT member.id, pilot_user.name,
                membership.revoked_at IS NULL AS active,
                count(DISTINCT task.id)::integer AS accepted_delegations
         FROM public.workspace_member member
         JOIN public.workspace_membership membership
           ON membership.id = member.pilot_membership_id
          AND membership.workspace_id = member.workspace_id
         JOIN auth."user" pilot_user ON pilot_user.id = membership.user_id
         LEFT JOIN public.task task
           ON task.requested_by_workspace_member_id = member.id
          AND task.workspace_id = member.workspace_id
          AND ($2::timestamptz IS NULL OR task.created_at >= $2)
         WHERE member.workspace_id = $1 AND member.kind = 'pilot'
         GROUP BY member.id, member.created_at, pilot_user.name, membership.revoked_at
         ORDER BY member.created_at, member.id`,
        [workspace.id, since]
      ),
      pool.query<{ accepted_mentions: number; rejected_mentions: number }>(
        `SELECT
           count(*) FILTER (WHERE agent_mention_status = 'accepted')::integer
             AS accepted_mentions,
           count(*) FILTER (WHERE agent_mention_status = 'rejected')::integer
             AS rejected_mentions
         FROM public.message
         WHERE workspace_id = $1
           AND ($2::timestamptz IS NULL OR created_at >= $2)`,
        [workspace.id, since]
      ),
      pool.query<{
        cross_member_collaborative_runs: number;
        cancelled_runs_with_request: number;
        failed_runs: number;
        paused_recoveries: number;
      }>(
        `SELECT
           count(*) FILTER (WHERE
             EXISTS (SELECT 1 FROM public.agent_run_event event
               WHERE event.agent_run_id = run.id AND event.event_type = 'run.queued')
             AND EXISTS (SELECT 1 FROM public.agent_run_event event
               WHERE event.agent_run_id = run.id AND event.event_type = 'provider.turn.started')
             AND EXISTS (SELECT 1 FROM public.agent_run_event event
               WHERE event.agent_run_id = run.id
                 AND event.event_type = 'run.clarification_requested')
             AND EXISTS (SELECT 1 FROM public.agent_run_event event
               WHERE event.agent_run_id = run.id
                 AND event.event_type = 'run.clarification_answered')
             AND EXISTS (
               SELECT 1 FROM public.agent_run_clarification clarification
               JOIN public.task task
                 ON task.id = run.task_id AND task.workspace_id = run.workspace_id
               WHERE clarification.agent_run_id = run.id
                 AND clarification.workspace_id = run.workspace_id
                 AND clarification.status = 'answered'
                 AND clarification.answered_by_workspace_member_id
                   <> task.requested_by_workspace_member_id
             )
           )::integer AS cross_member_collaborative_runs,
           count(*) FILTER (WHERE status = 'cancelled' AND EXISTS (
             SELECT 1 FROM public.agent_run_event event
             WHERE event.agent_run_id = run.id
               AND event.event_type = 'run.cancellation_requested'
           ))::integer AS cancelled_runs_with_request,
           count(*) FILTER (WHERE status = 'failed')::integer AS failed_runs,
           count(*) FILTER (WHERE
             EXISTS (SELECT 1 FROM public.agent_run_event event
               WHERE event.agent_run_id = run.id AND event.event_type = 'run.recovering')
             AND EXISTS (SELECT 1 FROM public.agent_run_event event
               WHERE event.agent_run_id = run.id AND event.event_type = 'run.paused')
           )::integer AS paused_recoveries
         FROM public.agent_run run
         WHERE run.workspace_id = $1
           AND ($2::timestamptz IS NULL OR run.created_at >= $2)`,
        [workspace.id, since]
      ),
      pool.query<{
        run_id: string;
        completed: boolean;
        repository_owner: string;
        repository_name: string;
        branch: string;
        commit_sha: string;
        pull_request_number: number;
        url: string;
      }>(
        `SELECT artifact.agent_run_id AS run_id,
                run.status = 'completed' AS completed,
                repository.repository_owner, repository.repository_name,
                artifact.branch, artifact.commit_sha,
                artifact.pull_request_number, artifact.url
         FROM public.artifact artifact
         JOIN public.agent_run run
           ON run.id = artifact.agent_run_id AND run.workspace_id = artifact.workspace_id
         JOIN public.linked_repository repository
           ON repository.id = run.linked_repository_id
          AND repository.workspace_id = run.workspace_id
         WHERE artifact.workspace_id = $1 AND artifact.kind = 'github_pull_request'
           AND ($2::timestamptz IS NULL OR artifact.created_at >= $2)
         ORDER BY artifact.created_at, artifact.id`,
        [workspace.id, since]
      ),
      pool.query<{
        duplicate_tasks: number;
        duplicate_terminal_events: number;
        duplicate_artifacts: number;
        artifact_result_anomalies: number;
        duplicate_provider_turns: number;
        duplicate_repository_operations: number;
      }>(
        `SELECT
           (SELECT count(*)::integer FROM (
              SELECT source_message_id FROM public.task
              WHERE workspace_id = $1
                AND ($2::timestamptz IS NULL OR created_at >= $2)
              GROUP BY source_message_id HAVING count(*) > 1
            ) duplicate) AS duplicate_tasks,
           (SELECT count(*)::integer FROM (
              SELECT agent_run_id FROM public.agent_run_event
              WHERE workspace_id = $1 AND status IN ('completed', 'failed', 'cancelled')
                AND ($2::timestamptz IS NULL OR occurred_at >= $2)
              GROUP BY agent_run_id HAVING count(*) > 1
            ) duplicate) AS duplicate_terminal_events,
           (SELECT count(*)::integer FROM (
              SELECT agent_run_id FROM public.artifact
              WHERE workspace_id = $1
                AND ($2::timestamptz IS NULL OR created_at >= $2)
              GROUP BY agent_run_id HAVING count(*) > 1
            ) duplicate) AS duplicate_artifacts,
           (SELECT count(*)::integer
            FROM public.artifact artifact
            LEFT JOIN public.message result
              ON result.id = artifact.result_message_id
             AND result.workspace_id = artifact.workspace_id
            LEFT JOIN public.notification_outbox outbox
              ON outbox.message_id = artifact.result_message_id
             AND outbox.workspace_id = artifact.workspace_id
            WHERE artifact.workspace_id = $1
              AND ($2::timestamptz IS NULL OR artifact.created_at >= $2)
              AND (result.id IS NULL OR outbox.id IS NULL)) AS artifact_result_anomalies,
           (SELECT count(*)::integer FROM (
              SELECT agent_run_id FROM public.agent_run_event
              WHERE workspace_id = $1 AND event_type = 'provider.turn.started'
                AND ($2::timestamptz IS NULL OR occurred_at >= $2)
              GROUP BY agent_run_id HAVING count(*) > 1
            ) duplicate) AS duplicate_provider_turns,
           (SELECT count(*)::integer FROM (
              SELECT agent_run_id, operation FROM public.github_broker_decision
              WHERE workspace_id = $1 AND phase = 'result'
                AND operation IN ('create_branch', 'commit', 'update_branch', 'pull_request_upsert')
                AND ($2::timestamptz IS NULL OR decided_at >= $2)
              GROUP BY agent_run_id, operation HAVING count(*) > 1
            ) duplicate) AS duplicate_repository_operations`,
        [workspace.id, since]
      )
    ]);

  const mentionCounts = mentions.rows[0]!;
  const outcomeCounts = outcomes.rows[0]!;
  const duplicateCounts = duplicates.rows[0]!;
  return {
    workspace,
    pilotMembers: members.rows.map((member) => ({
      id: member.id,
      name: member.name,
      active: member.active,
      acceptedDelegations: member.accepted_delegations
    })),
    acceptedMentions: mentionCounts.accepted_mentions,
    rejectedMentions: mentionCounts.rejected_mentions,
    crossMemberCollaborativeRuns: outcomeCounts.cross_member_collaborative_runs,
    cancelledRunsWithRequest: outcomeCounts.cancelled_runs_with_request,
    failedRuns: outcomeCounts.failed_runs,
    pausedRecoveries: outcomeCounts.paused_recoveries,
    pullRequestArtifacts: artifacts.rows.map((artifact) => ({
      runId: artifact.run_id,
      completed: artifact.completed,
      repositoryOwner: artifact.repository_owner,
      repositoryName: artifact.repository_name,
      branch: artifact.branch,
      commitSha: artifact.commit_sha,
      pullRequestNumber: artifact.pull_request_number,
      url: artifact.url
    })),
    duplicateTasks: duplicateCounts.duplicate_tasks,
    duplicateTerminalEvents: duplicateCounts.duplicate_terminal_events,
    duplicateArtifacts: duplicateCounts.duplicate_artifacts,
    artifactResultAnomalies: duplicateCounts.artifact_result_anomalies,
    duplicateProviderTurns: duplicateCounts.duplicate_provider_turns,
    duplicateRepositoryOperations: duplicateCounts.duplicate_repository_operations
  };
}
