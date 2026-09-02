import type { Pool } from 'pg';

import type { WorkspaceAccess } from '../authentication/authorization.js';
import { hasActiveLinkedRepositoryForProject } from '../github/connection.js';
import {
  createWorkspaceAgent,
  assertAgentTemplatePermissionCeiling,
  type AgentPermissionCeiling,
  type AgentParticipationMode,
  type AgentReplyMode,
  type AgentType,
  type ConfigurableAgent
} from './agents.js';

export { assertAgentTemplatePermissionCeiling } from './agents.js';

export type AgentTemplateKey = 'support' | 'data-analyst' | 'designer' | 'security-reviewer';
export type AgentCapability = 'repository_read' | 'project_data' | 'design_assets' | 'support_history';
export type AgentExpectedResultShape = 'concise_text' | 'structured_finding';

export interface AgentTemplate {
  key: AgentTemplateKey;
  version: number;
  name: string;
  agentType: AgentType;
  roleLabel: string;
  instructions: string;
  ambientTriggers: string[];
  participationMode: AgentParticipationMode;
  replyMode: AgentReplyMode;
  requiredCapabilities: AgentCapability[];
  permissionCeiling: AgentPermissionCeiling;
  expectedResultShapes: AgentExpectedResultShape[];
  nonResponsibilities: string[];
  staySilentWhen: string[];
  automatic: false;
}

const TEMPLATES: Record<AgentTemplateKey, AgentTemplate> = {
  support: {
    key: 'support', version: 2, name: 'Support', agentType: 'support',
    roleLabel: 'Support specialist',
    instructions: 'Clarify support questions and provide concise source-backed answers.',
    ambientTriggers: ['support', 'customer', 'incident'], participationMode: 'reactive',
    replyMode: 'adaptive', requiredCapabilities: ['support_history'], permissionCeiling: 'none',
    expectedResultShapes: ['concise_text', 'structured_finding'],
    nonResponsibilities: ['Repository changes', 'Production administration'], automatic: false,
    staySilentWhen: [
      'The question is resolved',
      'The discussion is internal and needs no customer context'
    ]
  },
  'data-analyst': {
    key: 'data-analyst', version: 2, name: 'Data Analyst', agentType: 'general',
    roleLabel: 'Data analyst',
    instructions: 'Analyse authorised Project data and state evidence, assumptions, and uncertainty.',
    ambientTriggers: ['data', 'metric', 'analysis'], participationMode: 'reactive',
    replyMode: 'adaptive', requiredCapabilities: ['project_data'], permissionCeiling: 'read_only',
    expectedResultShapes: ['structured_finding'],
    nonResponsibilities: ['Changing source data', 'Repository changes'], automatic: false,
    staySilentWhen: [
      'No authorised Project data supports the question',
      'Another Agent owns the active analysis'
    ]
  },
  designer: {
    key: 'designer', version: 2, name: 'Designer', agentType: 'general',
    roleLabel: 'Product designer',
    instructions: 'Review authorised product context and return concrete design guidance.',
    ambientTriggers: ['design', 'ux', 'interface'], participationMode: 'reactive',
    replyMode: 'adaptive', requiredCapabilities: ['design_assets'], permissionCeiling: 'read_only',
    expectedResultShapes: ['concise_text', 'structured_finding'],
    nonResponsibilities: ['Repository changes', 'Product prioritisation'], automatic: false,
    staySilentWhen: [
      'No design decision is being requested',
      'The discussion only concerns implementation'
    ]
  },
  'security-reviewer': {
    key: 'security-reviewer', version: 2, name: 'Security Reviewer', agentType: 'general',
    roleLabel: 'Security reviewer',
    instructions: 'Review authorised evidence for security risk without changing repositories.',
    ambientTriggers: ['security', 'threat', 'vulnerability'], participationMode: 'reactive',
    replyMode: 'thread', requiredCapabilities: ['repository_read'], permissionCeiling: 'read_only',
    expectedResultShapes: ['structured_finding'],
    nonResponsibilities: ['Repository changes', 'Credential access', 'Security administration'],
    automatic: false,
    staySilentWhen: [
      'No security boundary or risk is implicated',
      'The available evidence is outside authorised scope'
    ]
  }
};

export class AgentTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentTemplateError';
  }
}

interface TemplatePreviewInput {
  availableCapabilities: AgentCapability[];
  existingAgents: Array<Pick<ConfigurableAgent, 'name' | 'roleLabel' | 'ambientTriggers'>>;
  name?: string;
  roleLabel?: string;
  ambientTriggers?: string[];
}

function roleTerms(roleLabel: string): Set<string> {
  return new Set(
    roleLabel.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)
      ?.filter((term) => term.length >= 4 && term !== 'agent' && term !== 'specialist') ?? []
  );
}

function rolesOverlap(left: string, right: string): boolean {
  const rightTerms = roleTerms(right);
  return [...roleTerms(left)].some((term) => rightTerms.has(term));
}

export function previewAgentTemplate(
  key: string,
  input: TemplatePreviewInput
): { template: AgentTemplate; disabledCapabilities: AgentCapability[]; warnings: string[] } {
  const template = TEMPLATES[key as AgentTemplateKey];
  if (!template) throw new AgentTemplateError('Agent template was not found');
  const name = input.name?.trim() || template.name;
  const roleLabel = input.roleLabel?.trim() || template.roleLabel;
  const ambientTriggers = input.ambientTriggers ?? template.ambientTriggers;
  const warnings: string[] = [];
  const named = input.existingAgents.find((agent) =>
    agent.name.toLocaleLowerCase() === name.toLocaleLowerCase()
  );
  if (named) warnings.push(`An Agent named ${name} already exists.`);
  for (const trigger of ambientTriggers) {
    const overlapping = input.existingAgents.find((agent) =>
      agent.ambientTriggers.some(
        (existing) => existing.toLocaleLowerCase() === trigger.toLocaleLowerCase()
      )
    );
    if (overlapping) {
      warnings.push(`Ambient topic “${trigger}” overlaps with ${overlapping.name}.`);
      break;
    }
  }
  const roleOverlap = input.existingAgents.find((agent) =>
    rolesOverlap(agent.roleLabel, roleLabel)
  );
  if (roleOverlap) warnings.push(`Role responsibilities overlap with ${roleOverlap.name}.`);
  const available = new Set(input.availableCapabilities);
  return {
    template: structuredClone(template),
    disabledCapabilities: template.requiredCapabilities.filter((capability) => !available.has(capability)),
    warnings
  };
}

export function listAgentTemplates(): AgentTemplate[] {
  return Object.values(TEMPLATES).map((template) => structuredClone(template));
}

export function findAgentTemplateUpgrade(
  provenance: { key: string; version: number }
): { key: AgentTemplateKey; fromVersion: number; toVersion: number } | null {
  const template = TEMPLATES[provenance.key as AgentTemplateKey];
  if (!template || provenance.version >= template.version) return null;
  return {
    key: template.key,
    fromVersion: provenance.version,
    toVersion: template.version
  };
}

export function renderAgentTemplateExecutionBounds(input: {
  expectedResultShapes: AgentExpectedResultShape[];
  nonResponsibilities: string[];
  staySilentWhen: string[];
  disabledCapabilities: AgentCapability[];
  permissionCeiling: AgentPermissionCeiling;
}): string {
  return [
    input.nonResponsibilities.length > 0
      ? `Do not take responsibility for: ${input.nonResponsibilities.join('; ')}.`
      : '',
    input.staySilentWhen.length > 0
      ? `On an ambient turn, return exactly [RELAY_SILENT] when: ${input.staySilentWhen.join('; ')}.`
      : '',
    input.disabledCapabilities.length > 0
      ? `Unavailable capabilities are disabled and must not be attempted or claimed: ${input.disabledCapabilities.join(', ')}.`
      : '',
    input.permissionCeiling === 'read_only'
      ? 'You have a read-only permission ceiling and must not make changes.'
      : input.permissionCeiling === 'none'
        ? 'You have no external-action permission and must not use external capabilities.'
        : '',
    input.expectedResultShapes.includes('structured_finding')
      ? 'Return a concise answer plus a final fenced relay-finding JSON object containing summary, confidence, observedEvidence, inferences, assumptions, openQuestions, and evidence. Each evidence item needs type, stableReference, title, retrievedAt, and claim.'
      : ''
  ].filter(Boolean).join('\n');
}

export async function loadAvailableAgentTemplateCapabilities(
  pool: Pool,
  access: WorkspaceAccess
): Promise<AgentCapability[]> {
  const project = await pool.query<{ id: string }>(
    `SELECT id FROM public.project
     WHERE workspace_id = $1
     ORDER BY created_at, id
     LIMIT 1`,
    [access.workspace.id]
  );
  const projectId = project.rows[0]?.id;
  if (!projectId) return [];
  const available: AgentCapability[] = [];
  available.push('project_data');
  if (await hasActiveLinkedRepositoryForProject(pool, access.workspace.id, projectId)) {
    available.push('repository_read');
  }
  return available;
}

export async function instantiateAgentTemplate(
  pool: Pool,
  access: WorkspaceAccess,
  key: string,
  input: TemplatePreviewInput & {
    roleLabel?: string;
    instructions?: string;
    ambientTriggers?: string[];
  }
): Promise<{ agent: ConfigurableAgent; disabledCapabilities: AgentCapability[]; warnings: string[] }> {
  const preview = previewAgentTemplate(key, input);
  if (preview.warnings.some((warning) => warning.startsWith('An Agent named'))) {
    throw new AgentTemplateError(preview.warnings[0]!);
  }
  const template = preview.template;
  assertAgentTemplatePermissionCeiling(template.agentType, template.permissionCeiling);
  const agent = await createWorkspaceAgent(pool, access, {
    name: input.name?.trim() || template.name,
    agentType: template.agentType,
    roleLabel: input.roleLabel?.trim() || template.roleLabel,
    instructions: input.instructions?.trim() || template.instructions,
    participationMode: template.participationMode,
    ambientTriggers: input.ambientTriggers ?? template.ambientTriggers,
    replyMode: template.replyMode,
    enabled: true
  }, {
    key: template.key,
    version: template.version,
    snapshot: template,
    permissionCeiling: template.permissionCeiling,
    requiredCapabilities: template.requiredCapabilities,
    disabledCapabilities: preview.disabledCapabilities
  });
  return {
    agent: {
      ...agent,
      templateProvenance: { key: template.key, version: template.version },
      permissionCeiling: template.permissionCeiling,
      disabledCapabilities: preview.disabledCapabilities
    },
    disabledCapabilities: preview.disabledCapabilities,
    warnings: preview.warnings
  };
}
