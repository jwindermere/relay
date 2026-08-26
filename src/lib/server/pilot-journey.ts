import type { Pool } from 'pg';

import type { PilotJourneyObservation } from '../pilot-journey.js';

export async function observePilotJourney(
  pool: Pool,
  workspaceId?: string
): Promise<PilotJourneyObservation> {
  const workspaces = await pool.query<{ id: string; name: string }>(
    `SELECT id, name
     FROM public.workspace
     WHERE $1::text IS NULL OR id = $1
     ORDER BY created_at, id
     LIMIT 2`,
    [workspaceId ?? null]
  );
  if (workspaces.rows.length === 0) {
    throw new Error(workspaceId
      ? `Workspace ${workspaceId} does not exist.`
      : 'No Workspace exists.');
  }
  if (workspaces.rows.length > 1) {
    throw new Error('More than one Workspace exists; pass --workspace <id>.');
  }
  const workspace = workspaces.rows[0]!;

  const [members, mentions, events, clarifications, outcomes, artifacts, duplicates] =
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
         WHERE member.workspace_id = $1 AND member.kind = 'pilot'
         GROUP BY member.id, pilot_user.name, membership.revoked_at
         ORDER BY member.created_at, member.id`,
        [workspace.id]
      ),
      pool.query<{ accepted_mentions: number; rejected_mentions: number }>(
        `SELECT
           count(*) FILTER (WHERE agent_mention_status = 'accepted')::integer
             AS accepted_mentions,
           count(*) FILTER (WHERE agent_mention_status = 'rejected')::integer
             AS rejected_mentions
         FROM public.message
         WHERE workspace_id = $1`,
        [workspace.id]
      ),
      pool.query<{ event_type: string }>(
        `SELECT DISTINCT event_type
         FROM public.agent_run_event
         WHERE workspace_id = $1
         ORDER BY event_type`,
        [workspace.id]
      ),
      pool.query<{ cross_member_clarifications: number }>(
        `SELECT count(*)::integer AS cross_member_clarifications
         FROM public.agent_run_clarification clarification
         JOIN public.agent_run run
           ON run.id = clarification.agent_run_id
          AND run.workspace_id = clarification.workspace_id
         JOIN public.task task
           ON task.id = run.task_id AND task.workspace_id = run.workspace_id
         WHERE clarification.workspace_id = $1
           AND clarification.status = 'answered'
           AND clarification.answered_by_workspace_member_id
             <> task.requested_by_workspace_member_id`,
        [workspace.id]
      ),
      pool.query<{ cancelled_runs: number; failed_runs: number }>(
        `SELECT
           count(*) FILTER (WHERE status = 'cancelled')::integer AS cancelled_runs,
           count(*) FILTER (WHERE status = 'failed')::integer AS failed_runs
         FROM public.agent_run
         WHERE workspace_id = $1`,
        [workspace.id]
      ),
      pool.query<{
        run_id: string;
        run_status: string;
        pull_request_number: number;
        url: string;
      }>(
        `SELECT artifact.agent_run_id AS run_id, run.status AS run_status,
                artifact.pull_request_number, artifact.url
         FROM public.artifact artifact
         JOIN public.agent_run run
           ON run.id = artifact.agent_run_id AND run.workspace_id = artifact.workspace_id
         WHERE artifact.workspace_id = $1 AND artifact.kind = 'github_pull_request'
         ORDER BY artifact.created_at, artifact.id`,
        [workspace.id]
      ),
      pool.query<{
        duplicate_tasks: number;
        duplicate_terminal_events: number;
        duplicate_artifacts: number;
        artifact_result_anomalies: number;
      }>(
        `SELECT
           (SELECT count(*)::integer FROM (
              SELECT source_message_id FROM public.task
              WHERE workspace_id = $1 GROUP BY source_message_id HAVING count(*) > 1
            ) duplicate) AS duplicate_tasks,
           (SELECT count(*)::integer FROM (
              SELECT agent_run_id FROM public.agent_run_event
              WHERE workspace_id = $1 AND status IN ('completed', 'failed', 'cancelled')
              GROUP BY agent_run_id HAVING count(*) > 1
            ) duplicate) AS duplicate_terminal_events,
           (SELECT count(*)::integer FROM (
              SELECT agent_run_id FROM public.artifact
              WHERE workspace_id = $1 GROUP BY agent_run_id HAVING count(*) > 1
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
              AND (result.id IS NULL OR outbox.id IS NULL)) AS artifact_result_anomalies`,
        [workspace.id]
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
    eventTypes: events.rows.map(({ event_type }) => event_type),
    crossMemberClarifications: clarifications.rows[0]!.cross_member_clarifications,
    cancelledRuns: outcomeCounts.cancelled_runs,
    failedRuns: outcomeCounts.failed_runs,
    pullRequestArtifacts: artifacts.rows.map((artifact) => ({
      runId: artifact.run_id,
      runStatus: artifact.run_status,
      pullRequestNumber: artifact.pull_request_number,
      url: artifact.url
    })),
    duplicateTasks: duplicateCounts.duplicate_tasks,
    duplicateTerminalEvents: duplicateCounts.duplicate_terminal_events,
    duplicateArtifacts: duplicateCounts.duplicate_artifacts,
    artifactResultAnomalies: duplicateCounts.artifact_result_anomalies
  };
}
