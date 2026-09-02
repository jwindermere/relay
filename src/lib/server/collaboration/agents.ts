import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import {
  assertCurrentWorkspaceOwner,
  type WorkspaceAccess,
  WorkspaceAccessError
} from '../authentication/authorization.js';

export type AgentType = 'engineering' | 'research' | 'product' | 'support' | 'general';
export type AgentParticipationMode = 'reactive' | 'ambient';
export type AgentReplyMode = 'adaptive' | 'channel' | 'thread';
export type AgentPermissionCeiling = 'none' | 'read_only' | 'repository_write';

export interface ConfigurableAgent {
  id: string;
  name: string;
  agentType: AgentType;
  roleLabel: string;
  instructions: string;
  participationMode: AgentParticipationMode;
  ambientTriggers: string[];
  replyMode: AgentReplyMode;
  enabled: boolean;
  status: 'idle' | 'working' | 'waiting' | 'disabled';
  templateProvenance: { key: string; version: number } | null;
  permissionCeiling: AgentPermissionCeiling;
  disabledCapabilities: string[];
}

export class AgentConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentConfigurationError';
  }
}

export function assertAgentTemplatePermissionCeiling(
  agentType: AgentType,
  permissionCeiling: AgentPermissionCeiling
): void {
  if (agentType === 'engineering' && permissionCeiling !== 'repository_write') {
    throw new AgentConfigurationError(
      `Engineering authority exceeds the template permission ceiling (${permissionCeiling})`
    );
  }
}

interface AgentInput {
  name: string;
  agentType: AgentType;
  roleLabel: string;
  instructions?: string;
  participationMode?: AgentParticipationMode;
  ambientTriggers?: string[];
  replyMode?: AgentReplyMode;
  enabled?: boolean;
}

const AGENT_TYPES = new Set<AgentType>(['engineering', 'research', 'product', 'support', 'general']);
const PARTICIPATION_MODES = new Set<AgentParticipationMode>(['reactive', 'ambient']);
const REPLY_MODES = new Set<AgentReplyMode>(['adaptive', 'channel', 'thread']);

function normalizeInput(input: AgentInput): Required<AgentInput> {
  if (!input || typeof input.name !== 'string' || typeof input.roleLabel !== 'string') {
    throw new AgentConfigurationError('Agent name and role are required');
  }
  if (input.instructions !== undefined && typeof input.instructions !== 'string') {
    throw new AgentConfigurationError('Agent instructions are invalid');
  }
  if (input.ambientTriggers !== undefined
    && (!Array.isArray(input.ambientTriggers)
      || input.ambientTriggers.some((trigger) => typeof trigger !== 'string'))) {
    throw new AgentConfigurationError('Agent ambient topics are invalid');
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new AgentConfigurationError('Agent enabled state is invalid');
  }
  const name = input.name.trim();
  const roleLabel = input.roleLabel.trim();
  const instructions = (input.instructions ?? '').trim();
  if (!name || name.length > 80 || name.includes('@')) {
    throw new AgentConfigurationError('Agent name must contain 1 to 80 characters and cannot include @');
  }
  if (!roleLabel || roleLabel.length > 120) {
    throw new AgentConfigurationError('Agent role must contain 1 to 120 characters');
  }
  if (!AGENT_TYPES.has(input.agentType)) throw new AgentConfigurationError('Agent type is invalid');
  if (instructions.length > 4000) {
    throw new AgentConfigurationError('Agent instructions cannot exceed 4000 characters');
  }
  const participationMode = input.participationMode ?? 'ambient';
  const replyMode = input.replyMode ?? 'adaptive';
  if (!PARTICIPATION_MODES.has(participationMode)) {
    throw new AgentConfigurationError('Agent participation mode is invalid');
  }
  if (!REPLY_MODES.has(replyMode)) throw new AgentConfigurationError('Agent reply mode is invalid');
  const ambientTriggers = [...new Set((input.ambientTriggers ?? [])
    .map((trigger) => trigger.trim().toLocaleLowerCase())
    .filter(Boolean))];
  if (ambientTriggers.length > 30 || ambientTriggers.some((trigger) => trigger.length > 80)) {
    throw new AgentConfigurationError('Provide at most 30 ambient topics of 80 characters each');
  }
  return {
    name,
    agentType: input.agentType,
    roleLabel,
    instructions,
    participationMode,
    ambientTriggers,
    replyMode,
    enabled: input.enabled ?? true
  };
}

export async function loadWorkspaceAgents(
  pool: Pool,
  access: WorkspaceAccess
): Promise<{ agents: ConfigurableAgent[]; canManage: boolean }> {
  const result = await pool.query<{
    id: string;
    name: string;
    agent_type: AgentType;
    role_label: string;
    instructions: string;
    participation_mode: AgentParticipationMode;
    ambient_triggers: string[];
    reply_mode: AgentReplyMode;
    enabled: boolean;
    status: ConfigurableAgent['status'];
    template_key: string | null;
    template_version: number | null;
    permission_ceiling: ConfigurableAgent['permissionCeiling'];
    disabled_capabilities: string[];
  }>(
    `SELECT id, name, agent_type, role_label, instructions, participation_mode,
            ambient_triggers, reply_mode, enabled, status, template_key, template_version,
            permission_ceiling, disabled_capabilities
     FROM public.agent WHERE workspace_id = $1 ORDER BY created_at, id`,
    [access.workspace.id]
  );
  return {
    agents: result.rows.map((agent) => ({
      id: agent.id,
      name: agent.name,
      agentType: agent.agent_type,
      roleLabel: agent.role_label,
      instructions: agent.instructions,
      participationMode: agent.participation_mode,
      ambientTriggers: agent.ambient_triggers,
      replyMode: agent.reply_mode,
      enabled: agent.enabled,
      status: agent.status,
      templateProvenance: agent.template_key && agent.template_version
        ? { key: agent.template_key, version: agent.template_version }
        : null,
      permissionCeiling: agent.permission_ceiling,
      disabledCapabilities: agent.disabled_capabilities
    })),
    canManage: access.membership.role === 'owner'
  };
}

export async function createWorkspaceAgent(
  pool: Pool,
  access: WorkspaceAccess,
  projectId: string,
  input: AgentInput,
  provenance?: {
    key: string; version: number; snapshot: object;
    permissionCeiling: ConfigurableAgent['permissionCeiling'];
    requiredCapabilities: string[]; disabledCapabilities: string[];
  }
): Promise<ConfigurableAgent> {
  if (access.membership.role !== 'owner') throw new WorkspaceAccessError('Workspace owner access is required');
  const agent = normalizeInput(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertCurrentWorkspaceOwner(client, access);
    const project = await client.query<{ id: string }>(
      `SELECT project.id FROM public.project project
       JOIN public.project_membership project_member
         ON project_member.workspace_id = project.workspace_id
        AND project_member.project_id = project.id
       JOIN public.workspace_member member
         ON member.workspace_id = project.workspace_id
        AND member.id = project_member.workspace_member_id
       JOIN public.workspace_membership membership
         ON membership.workspace_id = member.workspace_id
        AND membership.id = member.pilot_membership_id
       WHERE project.workspace_id = $1
         AND project.id = $2
         AND membership.id = $3
         AND membership.revoked_at IS NULL
       FOR SHARE OF project, project_member, member, membership`,
      [access.workspace.id, projectId, access.membership.id]
    );
    if (!project.rows[0]) throw new WorkspaceAccessError('active Project membership is required');
    const id = randomUUID();
    const memberId = `${id}:member`;
    const inserted = await client.query<{
      status: ConfigurableAgent['status'];
    }>(
      `INSERT INTO public.agent (
         id, workspace_id, name, agent_type, role_label, instructions,
         participation_mode, ambient_triggers, reply_mode, enabled, status,
         template_key, template_version, template_snapshot, permission_ceiling,
         required_capabilities, disabled_capabilities
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         $12, $13, $14, $15, $16, $17)
       RETURNING status`,
      [
        id, access.workspace.id, agent.name, agent.agentType, agent.roleLabel,
        agent.instructions, agent.participationMode, agent.ambientTriggers,
        agent.replyMode, agent.enabled, agent.enabled ? 'idle' : 'disabled',
        provenance?.key ?? null, provenance?.version ?? null,
        provenance?.snapshot ?? null, provenance?.permissionCeiling ?? 'none',
        provenance?.requiredCapabilities ?? [], provenance?.disabledCapabilities ?? []
      ]
    );
    await client.query(
      `INSERT INTO public.workspace_member (id, workspace_id, kind, agent_id)
       VALUES ($1, $2, 'agent', $3)`,
      [memberId, access.workspace.id, id]
    );
    await client.query(
      `INSERT INTO public.project_membership (workspace_id, project_id, workspace_member_id)
       VALUES ($1, $2, $3)`,
      [access.workspace.id, project.rows[0].id, memberId]
    );
    await client.query(
      `INSERT INTO public.audit_event (
         workspace_id, actor_user_id, actor_membership_id,
         event_type, subject_type, subject_id, evidence
       ) VALUES ($1, $2, $3, 'agent.created', 'agent', $4,
         jsonb_build_object('name', $5::text, 'agentType', $6::text))`,
      [access.workspace.id, access.identity.userId, access.membership.id, id, agent.name, agent.agentType]
    );
    await client.query('COMMIT');
    return {
      id, ...agent, status: inserted.rows[0]!.status,
      templateProvenance: provenance ? { key: provenance.key, version: provenance.version } : null,
      permissionCeiling: provenance?.permissionCeiling ?? 'none',
      disabledCapabilities: provenance?.disabledCapabilities ?? []
    };
  } catch (error) {
    await client.query('ROLLBACK');
    if ((error as { code?: string }).code === '23505') {
      throw new AgentConfigurationError('An Agent with that name already exists');
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function updateWorkspaceAgent(
  pool: Pool,
  access: WorkspaceAccess,
  agentId: string,
  input: AgentInput
): Promise<void> {
  if (access.membership.role !== 'owner') throw new WorkspaceAccessError('Workspace owner access is required');
  const agent = normalizeInput(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertCurrentWorkspaceOwner(client, access);
    const existing = await client.query<{
      template_key: string | null;
      permission_ceiling: AgentPermissionCeiling;
    }>(
      `SELECT template_key, permission_ceiling
       FROM public.agent
       WHERE id = $1 AND workspace_id = $2
       FOR UPDATE`,
      [agentId, access.workspace.id]
    );
    if (!existing.rows[0]) throw new AgentConfigurationError('Agent was not found');
    if (existing.rows[0].template_key) {
      assertAgentTemplatePermissionCeiling(agent.agentType, existing.rows[0].permission_ceiling);
    }
    const updated = await client.query(
      `UPDATE public.agent
       SET name = $3, agent_type = $4, role_label = $5, instructions = $6,
           participation_mode = $7, ambient_triggers = $8, reply_mode = $9,
           enabled = $10,
           configuration_version = configuration_version + 1,
           status = CASE WHEN $10 THEN CASE WHEN status = 'disabled' THEN 'idle' ELSE status END
                         ELSE 'disabled' END
       WHERE id = $1 AND workspace_id = $2`,
      [
        agentId, access.workspace.id, agent.name, agent.agentType, agent.roleLabel,
        agent.instructions, agent.participationMode, agent.ambientTriggers,
        agent.replyMode, agent.enabled
      ]
    );
    if (updated.rowCount !== 1) throw new AgentConfigurationError('Agent was not found');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    if ((error as { code?: string }).code === '23505') {
      throw new AgentConfigurationError('An Agent with that name already exists');
    }
    throw error;
  } finally {
    client.release();
  }
}
