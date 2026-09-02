import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

export async function acceptCoordinationPlanConstraint(
  client: PoolClient,
  context: {
    messageId: string; workspaceId: string; channelId: string; parentMessageId: string;
  },
  guidance: string
): Promise<boolean> {
  const plan = await client.query<{
    id: string; workspace_id: string; member_id: string;
    membership_id: string; user_id: string;
  }>(
    `SELECT plan.id, plan.workspace_id, author.id AS member_id,
            membership.id AS membership_id, membership.user_id
     FROM public.message constraint_message
     JOIN public.workspace_member author
       ON author.id = constraint_message.author_workspace_member_id
      AND author.workspace_id = constraint_message.workspace_id
     JOIN public.workspace_membership membership
       ON membership.id = author.pilot_membership_id AND membership.revoked_at IS NULL
     JOIN public.channel channel ON channel.id = constraint_message.channel_id
     JOIN public.coordination_plan plan
       ON plan.workspace_id = constraint_message.workspace_id
      AND plan.project_id = channel.project_id
     JOIN public.message plan_source
       ON plan_source.id = plan.source_message_id
      AND plan_source.channel_id = constraint_message.channel_id
      AND COALESCE(plan_source.parent_message_id, plan_source.id) = $4
     JOIN public.project_membership project_member
       ON project_member.project_id = plan.project_id
      AND project_member.workspace_member_id = author.id
     WHERE constraint_message.id = $1 AND constraint_message.workspace_id = $2
       AND constraint_message.channel_id = $3
       AND plan.status IN ('approved', 'active', 'paused')
     ORDER BY plan.created_at DESC, plan.id DESC LIMIT 1 FOR UPDATE OF plan`,
    [context.messageId, context.workspaceId, context.channelId, context.parentMessageId]
  );
  const activePlan = plan.rows[0];
  if (!activePlan) return false;
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [activePlan.id]);
  const inserted = await client.query(
    `INSERT INTO public.coordination_plan_constraint (
       id, workspace_id, project_id, plan_id, source_message_id,
       supplied_by_workspace_member_id, guidance, ordinal
     ) SELECT $1, plan.workspace_id, plan.project_id, plan.id, $2, $3, $4,
              COALESCE((SELECT max(ordinal) + 1
                        FROM public.coordination_plan_constraint
                        WHERE plan_id = plan.id), 1)
       FROM public.coordination_plan plan
      WHERE plan.id = $5 AND plan.workspace_id = $6
        AND plan.status IN ('approved', 'active', 'paused')
     ON CONFLICT (source_message_id) DO NOTHING`,
    [randomUUID(), context.messageId, activePlan.member_id, guidance,
      activePlan.id, context.workspaceId]
  );
  if (inserted.rowCount !== 1) return false;
  await client.query(
    `INSERT INTO public.audit_event (
       workspace_id, actor_user_id, actor_membership_id,
       event_type, subject_type, subject_id, evidence
     ) VALUES ($1, $2, $3, 'coordination_plan.constraint_appended', 'coordination_plan', $4,
       jsonb_build_object('sourceMessageId', $5::text, 'guidance', $6::text,
                          'suppliedByWorkspaceMemberId', $7::text))`,
    [activePlan.workspace_id, activePlan.user_id, activePlan.membership_id,
      activePlan.id, context.messageId, guidance, activePlan.member_id]
  );
  return true;
}
