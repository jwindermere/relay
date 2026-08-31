import type { Pool } from 'pg';

import type { WorkspaceAccess } from '../authentication/authorization.js';
import {
  createWorkspaceAgent,
  type AgentParticipationMode,
  type AgentReplyMode,
  type AgentType,
  type ConfigurableAgent
} from './agents.js';

export type AgentTemplateKey = 'support' | 'data-analyst' | 'designer' | 'security-reviewer';
export type AgentCapability = 'repository_read' | 'project_data' | 'design_assets' | 'support_history';

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
  permissionCeiling: 'none' | 'read_only' | 'repository_write';
  expectedResultShapes: Array<'concise_text' | 'structured_finding'>;
  nonResponsibilities: string[];
  automatic: false;
}

const TEMPLATES: Record<AgentTemplateKey, AgentTemplate> = {
  support: {
    key: 'support', version: 1, name: 'Support', agentType: 'support',
    roleLabel: 'Support specialist',
    instructions: 'Clarify support questions and provide concise source-backed answers.',
    ambientTriggers: ['support', 'customer', 'incident'], participationMode: 'reactive',
    replyMode: 'adaptive', requiredCapabilities: ['support_history'], permissionCeiling: 'none',
    expectedResultShapes: ['concise_text', 'structured_finding'],
    nonResponsibilities: ['Repository changes', 'Production administration'], automatic: false
  },
  'data-analyst': {
    key: 'data-analyst', version: 1, name: 'Data Analyst', agentType: 'general',
    roleLabel: 'Data analyst',
    instructions: 'Analyse authorised Project data and state evidence, assumptions, and uncertainty.',
    ambientTriggers: ['data', 'metric', 'analysis'], participationMode: 'reactive',
    replyMode: 'adaptive', requiredCapabilities: ['project_data'], permissionCeiling: 'read_only',
    expectedResultShapes: ['structured_finding'],
    nonResponsibilities: ['Changing source data', 'Repository changes'], automatic: false
  },
  designer: {
    key: 'designer', version: 1, name: 'Designer', agentType: 'general',
    roleLabel: 'Product designer',
    instructions: 'Review authorised product context and return concrete design guidance.',
    ambientTriggers: ['design', 'ux', 'interface'], participationMode: 'reactive',
    replyMode: 'adaptive', requiredCapabilities: ['design_assets'], permissionCeiling: 'read_only',
    expectedResultShapes: ['concise_text', 'structured_finding'],
    nonResponsibilities: ['Repository changes', 'Product prioritisation'], automatic: false
  },
  'security-reviewer': {
    key: 'security-reviewer', version: 1, name: 'Security Reviewer', agentType: 'general',
    roleLabel: 'Security reviewer',
    instructions: 'Review authorised evidence for security risk without changing repositories.',
    ambientTriggers: ['security', 'threat', 'vulnerability'], participationMode: 'reactive',
    replyMode: 'thread', requiredCapabilities: ['repository_read'], permissionCeiling: 'read_only',
    expectedResultShapes: ['structured_finding'],
    nonResponsibilities: ['Repository changes', 'Credential access', 'Security administration'],
    automatic: false
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
}

export function previewAgentTemplate(
  key: string,
  input: TemplatePreviewInput
): { template: AgentTemplate; disabledCapabilities: AgentCapability[]; warnings: string[] } {
  const template = TEMPLATES[key as AgentTemplateKey];
  if (!template) throw new AgentTemplateError('Agent template was not found');
  const name = input.name?.trim() || template.name;
  const warnings: string[] = [];
  const named = input.existingAgents.find((agent) =>
    agent.name.toLocaleLowerCase() === name.toLocaleLowerCase()
  );
  if (named) warnings.push(`An Agent named ${name} already exists.`);
  for (const trigger of template.ambientTriggers) {
    const overlapping = input.existingAgents.find((agent) =>
      agent.ambientTriggers.some((existing) => existing.toLocaleLowerCase() === trigger)
    );
    if (overlapping) {
      warnings.push(`Ambient topic “${trigger}” overlaps with ${overlapping.name}.`);
      break;
    }
  }
  const roleOverlap = input.existingAgents.find((agent) =>
    agent.roleLabel.toLocaleLowerCase() === template.roleLabel.toLocaleLowerCase()
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
