import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import type { WorkspaceAccess } from '../authentication/authorization.js';
import { recordCollaborationEvaluationEvent } from './evaluation.js';

export type EvidenceType = 'external' | 'repository' | 'message' | 'artifact';
export type MemoryType =
  | 'decision' | 'terminology' | 'constraint' | 'finding' | 'convention' | 'rejected_approach';

export interface FindingEvidenceInput {
  type: EvidenceType;
  stableReference: string;
  title: string;
  retrievedAt: string;
  claim: string;
}

export interface FindingInput {
  summary: string;
  confidence: number;
  observedEvidence: string[];
  inferences: string[];
  assumptions: string[];
  openQuestions: string[];
  evidence: FindingEvidenceInput[];
}

export interface ProjectMemoryContextEntry {
  id: string;
  type: MemoryType;
  statement: string;
  lifecycle: 'active' | 'superseded' | 'archived' | 'deleted';
  createdAt: string;
}

export class FindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FindingError';
  }
}

const RESTRICTED_MEMORY_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\b(?:sk|ghp)_[A-Za-z0-9_-]{12,}\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{12,}\b/u,
  /\bAKIA[A-Z0-9]{16}\b/u,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/iu,
  /\bauthorization\s*:\s*(?:basic|bearer)\s+\S+/iu,
  /\b(?:api[ _-]?key|password|secret|token)\s*[:=]\s*\S{8,}/iu,
  /\b(?:api[ _-]?key|password|secret|token|credential)\s+(?:is|was)\s+\S+/iu,
  /\b(?:credentialStoreReference|providerEventId|encrypted_reasoning)\b/u,
  /"(?:method|params|result)"\s*:/u,
  /\b(?:chain[ -]of[ -]thought|hidden reasoning|internal reasoning)\b/iu,
  /(?:^|\n)\s*(?:user|assistant|system)\s*:.*\n\s*(?:user|assistant|system)\s*:/iu,
  /```(?:json)?[\s\S]*"(?:method|params|result)"\s*:/iu
];

function assertContainsNoRecognizedRestrictedMaterial(statement: string): void {
  if (RESTRICTED_MEMORY_PATTERNS.some((pattern) => pattern.test(statement))) {
    throw new FindingError('Memory must not contain credentials or Provider traces');
  }
}

function cleanList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new FindingError(`${label} must be a list of concise statements`);
  }
  const cleaned = value.map((item) => item.trim()).filter(Boolean);
  if (cleaned.length > 50 || cleaned.some((item) => item.length > 2000)) {
    throw new FindingError(`${label} exceeds its safe limit`);
  }
  return cleaned;
}

export function normalizeFindingInput(input: FindingInput): FindingInput {
  const summary = input?.summary?.trim();
  if (!summary || summary.length > 4000) throw new FindingError('Finding summary is required');
  assertContainsNoRecognizedRestrictedMaterial(summary);
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new FindingError('Finding confidence must be between 0 and 1');
  }
  if (!Array.isArray(input.evidence) || input.evidence.length > 100) {
    throw new FindingError('Finding evidence exceeds its safe limit');
  }
  const evidence = input.evidence.map((item) => {
    if (!['external', 'repository', 'message', 'artifact'].includes(item.type)) {
      throw new FindingError('Finding evidence type is invalid');
    }
    const stableReference = item.stableReference?.trim();
    const title = item.title?.trim();
    const claim = item.claim?.trim();
    const retrievedAt = new Date(item.retrievedAt);
    if (!stableReference || !title || !claim || Number.isNaN(retrievedAt.getTime())) {
      throw new FindingError('Finding evidence is incomplete');
    }
    if (item.type === 'external') {
      let url: URL;
      try { url = new URL(stableReference); } catch { throw new FindingError('External evidence requires a safe HTTPS URL'); }
      if (url.protocol !== 'https:') throw new FindingError('External evidence requires a safe HTTPS URL');
    }
    if (item.type === 'repository' && (
      stableReference.startsWith('/') || stableReference.includes('://')
      || stableReference.split('/').includes('..')
      || !/^[\p{L}\p{N}_.@+\-/ ]+(?::\d+)?$/u.test(stableReference)
    )) throw new FindingError('Repository evidence requires a relative repository path');
    return { type: item.type, stableReference, title, claim, retrievedAt: retrievedAt.toISOString() };
  });
  const keys = evidence.map((item) => `${item.type}\u0000${item.stableReference}\u0000${item.claim}`);
  if (new Set(keys).size !== keys.length) throw new FindingError('Finding contains duplicate evidence');
  return {
    summary,
    confidence: input.confidence,
    observedEvidence: cleanList(input.observedEvidence, 'Observed evidence'),
    inferences: cleanList(input.inferences, 'Inferences'),
    assumptions: cleanList(input.assumptions, 'Assumptions'),
    openQuestions: cleanList(input.openQuestions, 'Open questions'),
    evidence
  };
}

export function parseFindingResult(body: string): { message: string; finding: FindingInput } | null {
  const match = body.match(/```relay-finding\s*([\s\S]*?)```/iu);
  if (!match?.[1]) return null;
  let decoded: unknown;
  try { decoded = JSON.parse(match[1]); } catch { throw new FindingError('Structured finding JSON is invalid'); }
  return {
    message: body.replace(match[0], '').trim(),
    finding: normalizeFindingInput(decoded as FindingInput)
  };
}

export function selectProjectMemoryContext<T extends ProjectMemoryContextEntry>(
  entries: T[], limit = 20
): T[] {
  const safeLimit = Math.max(0, Math.min(100, Math.trunc(limit)));
  if (safeLimit === 0 || !Number.isFinite(safeLimit)) return [];
  return entries
    .filter(({ lifecycle }) => lifecycle === 'active')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .slice(-safeLimit);
}

export async function createFinding(
  pool: Pool,
  access: WorkspaceAccess,
  input: FindingInput & {
    projectId: string;
    authorAgentId: string;
    resultMessageId?: string;
    sourceHandoffId?: string;
  }
): Promise<string> {
  const finding = normalizeFindingInput(input);
  const client = await pool.connect();
  const id = randomUUID();
  try {
    await client.query('BEGIN');
    const authorized = await client.query<{ allowed: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM public.project_membership project_member
         JOIN public.workspace_member pilot ON pilot.id = project_member.workspace_member_id
         JOIN public.workspace_membership membership ON membership.id = pilot.pilot_membership_id
         JOIN public.agent agent ON agent.id = $4 AND agent.workspace_id = $1
         JOIN public.workspace_member agent_member ON agent_member.agent_id = agent.id
         JOIN public.project_membership agent_project
           ON agent_project.workspace_member_id = agent_member.id
          AND agent_project.project_id = project_member.project_id
         WHERE project_member.project_id = $3 AND project_member.workspace_id = $1
           AND membership.id = $2 AND membership.revoked_at IS NULL
       ) AS allowed`,
      [access.workspace.id, access.membership.id, input.projectId, input.authorAgentId]
    );
    if (!authorized.rows[0]?.allowed) throw new FindingError('authorised Project evidence is required');
    const inserted = await client.query(
      `INSERT INTO public.agent_finding (
         id, workspace_id, project_id, author_agent_id, result_message_id, source_handoff_id,
         summary, confidence, observed_evidence, inferences, assumptions, open_questions
       )
       SELECT $1, $2, $3, $4, result.id, handoff.id, $7, $8, $9, $10, $11, $12
       FROM (SELECT 1) seed
       LEFT JOIN public.message result ON result.id = $5 AND result.workspace_id = $2
       LEFT JOIN public.workspace_member result_author
         ON result_author.id = result.author_workspace_member_id
        AND result_author.workspace_id = result.workspace_id
       LEFT JOIN public.channel result_channel
         ON result_channel.id = result.channel_id AND result_channel.project_id = $3
       LEFT JOIN public.agent_handoff handoff
         ON handoff.id = $6 AND handoff.workspace_id = $2 AND handoff.project_id = $3
       WHERE ($5::text IS NULL OR (result_channel.id IS NOT NULL AND result_author.agent_id = $4))
         AND ($6::text IS NULL OR (handoff.id IS NOT NULL AND handoff.target_agent_id = $4))`,
      [id, access.workspace.id, input.projectId, input.authorAgentId,
        input.resultMessageId ?? null, input.sourceHandoffId ?? null,
        finding.summary, finding.confidence, JSON.stringify(finding.observedEvidence),
        JSON.stringify(finding.inferences), JSON.stringify(finding.assumptions),
        JSON.stringify(finding.openQuestions)]
    );
    if (inserted.rowCount !== 1) throw new FindingError('Finding provenance is outside the Project');
    for (const evidence of finding.evidence) {
      if (evidence.type === 'message' || evidence.type === 'artifact' || evidence.type === 'repository') {
        const reference = await client.query<{ allowed: boolean }>(
          evidence.type === 'message'
            ? `SELECT EXISTS (
                 SELECT 1 FROM public.message message JOIN public.channel channel ON channel.id = message.channel_id
                 WHERE message.id = $1 AND message.workspace_id = $2 AND channel.project_id = $3
               ) AS allowed`
            : evidence.type === 'artifact' ? `SELECT EXISTS (
                 SELECT 1 FROM public.artifact
                 WHERE id = $1 AND workspace_id = $2 AND project_id = $3
               ) AS allowed` : `SELECT EXISTS (
                 SELECT 1 FROM public.linked_repository
                 WHERE workspace_id = $2 AND project_id = $3
               ) AS allowed`,
          [evidence.stableReference, access.workspace.id, input.projectId]
        );
        if (!reference.rows[0]?.allowed) throw new FindingError('Evidence reference is outside the Project');
      }
      await client.query(
        `INSERT INTO public.finding_evidence (
           id, workspace_id, project_id, finding_id, evidence_type,
           stable_reference, title, retrieved_at, claim
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [randomUUID(), access.workspace.id, input.projectId, id, evidence.type,
          evidence.stableReference, evidence.title, evidence.retrievedAt, evidence.claim]
      );
    }
    await client.query('COMMIT');
    return id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

type AgentFindingResultInput = FindingInput & {
  workspaceId: string; projectId: string; authorAgentId: string;
  resultMessageId: string; sourceHandoffId?: string; routingPolicyVersion: string;
  agentConfigurationVersion: string;
  agentType: string;
};

export async function persistFindingFromAgentResult(
  client: PoolClient,
  input: AgentFindingResultInput
): Promise<string> {
  const finding = normalizeFindingInput(input);
  const id = randomUUID();
  const source = await client.query<{ author_member_id: string }>(
      `SELECT author.id AS author_member_id
       FROM public.message message
       JOIN public.channel channel ON channel.id = message.channel_id
       JOIN public.workspace_member author ON author.id = message.author_workspace_member_id
       WHERE message.id = $1 AND message.workspace_id = $2 AND channel.project_id = $3
         AND author.agent_id = $4`,
      [input.resultMessageId, input.workspaceId, input.projectId, input.authorAgentId]
    );
    if (!source.rows[0]) throw new FindingError('Finding result is outside the Agent Project');
    await client.query(
      `INSERT INTO public.agent_finding (
         id, workspace_id, project_id, author_agent_id, result_message_id, source_handoff_id,
         summary, confidence, observed_evidence, inferences, assumptions, open_questions
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [id, input.workspaceId, input.projectId, input.authorAgentId,
        input.resultMessageId, input.sourceHandoffId ?? null, finding.summary, finding.confidence,
        JSON.stringify(finding.observedEvidence), JSON.stringify(finding.inferences),
        JSON.stringify(finding.assumptions), JSON.stringify(finding.openQuestions)]
    );
    for (const evidence of finding.evidence) {
      let accessible = true;
      if (evidence.type === 'message' || evidence.type === 'artifact' || evidence.type === 'repository') {
        const reference = await client.query<{ allowed: boolean }>(
          evidence.type === 'message'
            ? `SELECT EXISTS (
                 SELECT 1 FROM public.message message JOIN public.channel channel ON channel.id = message.channel_id
                 WHERE message.id = $1 AND message.workspace_id = $2 AND channel.project_id = $3
               ) AS allowed`
            : evidence.type === 'artifact' ? `SELECT EXISTS (
                 SELECT 1 FROM public.artifact
                 WHERE id = $1 AND workspace_id = $2 AND project_id = $3
               ) AS allowed` : `SELECT EXISTS (
                 SELECT 1 FROM public.linked_repository
                 WHERE workspace_id = $2 AND project_id = $3
               ) AS allowed`,
          [evidence.stableReference, input.workspaceId, input.projectId]
        );
        accessible = Boolean(reference.rows[0]?.allowed);
      }
      await client.query(
        `INSERT INTO public.finding_evidence (
           id, workspace_id, project_id, finding_id, evidence_type,
           stable_reference, title, retrieved_at, claim, accessible
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [randomUUID(), input.workspaceId, input.projectId, id, evidence.type,
          evidence.stableReference, evidence.title, evidence.retrievedAt, evidence.claim, accessible]
      );
    }
    await client.query(
      `INSERT INTO public.project_memory (
         id, workspace_id, project_id, author_workspace_member_id,
         memory_type, statement, source_references
       ) VALUES ($1, $2, $3, $4, 'finding', $5, $6)`,
      [randomUUID(), input.workspaceId, input.projectId, source.rows[0].author_member_id,
        finding.summary, JSON.stringify([`finding:${id}`, `message:${input.resultMessageId}`])]
    );
    await recordCollaborationEvaluationEvent(client, {
      workspaceId: input.workspaceId, projectId: input.projectId,
      eventType: 'outcome.completed', agentId: input.authorAgentId,
      routingPolicyVersion: input.routingPolicyVersion, promptVersion: 'conversation-v1',
      agentConfigurationVersion: input.agentConfigurationVersion,
      agentType: input.agentType,
      permissionPolicyVersion: 'read-only-v1', outcomeType: 'finding', outcomeId: id,
      evidence: { status: 'completed', evidenceCount: finding.evidence.length }
    });
    if (finding.evidence.length === 0 && finding.confidence >= 0.8) {
      await recordCollaborationEvaluationEvent(client, {
        workspaceId: input.workspaceId, projectId: input.projectId,
        eventType: 'unsupported.certainty', agentId: input.authorAgentId,
        routingPolicyVersion: input.routingPolicyVersion, promptVersion: 'conversation-v1',
        agentConfigurationVersion: input.agentConfigurationVersion,
        agentType: input.agentType,
        permissionPolicyVersion: 'read-only-v1', outcomeType: 'finding', outcomeId: id,
        evidence: { confidence: finding.confidence, evidenceCount: 0 }
      });
    }
    const duplicate = await client.query<{ id: string }>(
      `SELECT id FROM public.agent_finding
       WHERE workspace_id = $1 AND project_id = $2 AND id <> $3
         AND lower(trim(summary)) = lower(trim($4))
       ORDER BY created_at, id LIMIT 1`,
      [input.workspaceId, input.projectId, id, finding.summary]
    );
    if (duplicate.rows[0]) {
      await recordCollaborationEvaluationEvent(client, {
        workspaceId: input.workspaceId, projectId: input.projectId,
        eventType: 'duplicate.investigation', agentId: input.authorAgentId,
        routingPolicyVersion: input.routingPolicyVersion, promptVersion: 'conversation-v1',
        agentConfigurationVersion: input.agentConfigurationVersion,
        agentType: input.agentType,
        permissionPolicyVersion: 'read-only-v1', outcomeType: 'finding', outcomeId: id,
        evidence: { duplicatesFindingId: duplicate.rows[0].id }
      });
    }
  return id;
}

export async function createFindingFromAgentResult(
  pool: Pool,
  input: AgentFindingResultInput
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = await persistFindingFromAgentResult(client, input);
    await client.query('COMMIT');
    return id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function createProjectMemory(
  pool: Pool,
  access: WorkspaceAccess,
  input: { projectId: string; type: MemoryType; statement: string; sourceReferences: string[]; supersedesId?: string }
): Promise<string> {
  const projectId = typeof input?.projectId === 'string' ? input.projectId.trim() : '';
  if (!projectId) throw new FindingError('Project is required');
  const statement = typeof input?.statement === 'string' ? input.statement.trim() : '';
  if (!statement || statement.length > 4000) throw new FindingError('Memory statement is required');
  assertContainsNoRecognizedRestrictedMaterial(statement);
  const allowedTypes: MemoryType[] = ['decision', 'terminology', 'constraint', 'finding', 'convention', 'rejected_approach'];
  if (!allowedTypes.includes(input.type)) throw new FindingError('Memory type is invalid');
  if (!Array.isArray(input.sourceReferences)
    || input.sourceReferences.some((reference) => typeof reference !== 'string')) {
    throw new FindingError('Memory requires authorised provenance');
  }
  const sourceReferences = [...new Set(input.sourceReferences.map((reference) => reference.trim()))]
    .filter(Boolean);
  if (sourceReferences.length === 0 || sourceReferences.length > 50) {
    throw new FindingError('Memory requires authorised provenance');
  }
  const supersedesId = input.supersedesId === undefined
    ? undefined
    : typeof input.supersedesId === 'string' && input.supersedesId.trim()
      ? input.supersedesId.trim()
      : null;
  if (supersedesId === null) throw new FindingError('Memory supersession is invalid');
  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const actor = await client.query<{ id: string }>(
      `SELECT member.id FROM public.workspace_member member
       JOIN public.workspace_membership membership ON membership.id = member.pilot_membership_id
       JOIN public.project_membership project_member ON project_member.workspace_member_id = member.id
       WHERE membership.id = $2 AND member.workspace_id = $1 AND project_member.project_id = $3
         AND membership.revoked_at IS NULL`,
      [access.workspace.id, access.membership.id, projectId]
    );
    if (!actor.rows[0]) throw new FindingError('active Project membership is required');
    for (const reference of sourceReferences) {
      const match = reference.match(/^(message|handoff|task|agent_run|artifact|finding):(.+)$/u);
      if (!match) throw new FindingError('Memory provenance type is invalid');
      const table = {
        message: `public.message item JOIN public.channel channel ON channel.id = item.channel_id`,
        handoff: 'public.agent_handoff item', task: 'public.task item',
        agent_run: 'public.agent_run item JOIN public.task task ON task.id = item.task_id',
        artifact: 'public.artifact item', finding: 'public.agent_finding item'
      }[match[1]!];
      const projectPredicate = match[1] === 'message'
        ? 'channel.project_id = $3'
        : match[1] === 'agent_run' ? 'task.project_id = $3' : 'item.project_id = $3';
      const found = await client.query<{ allowed: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM ${table}
         WHERE item.id = $1 AND item.workspace_id = $2 AND ${projectPredicate}) AS allowed`,
        [match[2], access.workspace.id, projectId]
      );
      if (!found.rows[0]?.allowed) throw new FindingError('Memory provenance is outside the Project');
    }
    const inserted = await client.query(
      `INSERT INTO public.project_memory (
         id, workspace_id, project_id, author_workspace_member_id,
         memory_type, statement, source_references, supersedes_id, corrected_from_id
       )
       SELECT $1, $2, $3, $4, $5, $6, $7, prior.id, prior.id
       FROM (SELECT 1) seed
       LEFT JOIN public.project_memory prior
         ON prior.id = $8 AND prior.workspace_id = $2 AND prior.project_id = $3
        AND prior.lifecycle = 'active'
       WHERE $8::text IS NULL OR prior.id IS NOT NULL`,
      [id, access.workspace.id, projectId, actor.rows[0].id, input.type,
        statement, JSON.stringify(sourceReferences), supersedesId ?? null]
    );
    if (inserted.rowCount !== 1) throw new FindingError('Memory provenance is outside the Project');
    if (supersedesId) {
      await client.query(
        `UPDATE public.project_memory SET lifecycle = 'superseded', updated_at = now()
         WHERE id = $1 AND workspace_id = $2 AND project_id = $3 AND lifecycle = 'active'`,
        [supersedesId, access.workspace.id, projectId]
      );
    }
    await client.query('COMMIT');
    return id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function setProjectMemoryLifecycle(
  pool: Pool,
  access: WorkspaceAccess,
  memoryId: string,
  lifecycle: 'archived' | 'deleted'
): Promise<void> {
  if (!['archived', 'deleted'].includes(lifecycle)) {
    throw new FindingError('Memory lifecycle is invalid');
  }
  const updated = await pool.query(
    `UPDATE public.project_memory memory
     SET lifecycle = $4,
         statement = CASE WHEN $4 = 'deleted' THEN '[deleted]' ELSE statement END,
         source_references = CASE WHEN $4 = 'deleted' THEN '[]'::jsonb ELSE source_references END,
         deleted_at = CASE WHEN $4 = 'deleted' THEN now() ELSE NULL END,
         updated_at = now()
     WHERE memory.id = $1 AND memory.workspace_id = $2
       AND memory.lifecycle <> 'deleted'
       AND EXISTS (
         SELECT 1 FROM public.workspace_member member
         JOIN public.workspace_membership membership ON membership.id = member.pilot_membership_id
         JOIN public.project_membership project_member ON project_member.workspace_member_id = member.id
         WHERE member.workspace_id = $2 AND membership.id = $3
           AND membership.revoked_at IS NULL AND project_member.project_id = memory.project_id
       )`,
    [memoryId, access.workspace.id, access.membership.id, lifecycle]
  );
  if (updated.rowCount !== 1) throw new FindingError('Project memory was not found');
}

export async function loadAgentProjectMemoryContext(
  pool: Pool,
  scope: { workspaceId: string; projectId: string; agentId: string },
  limit = 20
): Promise<ProjectMemoryContextEntry[]> {
  const rows = await pool.query<{
    id: string; memory_type: MemoryType; statement: string;
    lifecycle: ProjectMemoryContextEntry['lifecycle']; created_at: Date;
  }>(
    `SELECT memory.id, memory.memory_type, memory.statement, memory.lifecycle, memory.created_at
     FROM public.project_memory memory
     WHERE memory.workspace_id = $1 AND memory.project_id = $2
       AND EXISTS (
         SELECT 1 FROM public.agent agent
         JOIN public.workspace_member member
           ON member.agent_id = agent.id AND member.workspace_id = agent.workspace_id
         JOIN public.project_membership project_member
           ON project_member.workspace_member_id = member.id
          AND project_member.workspace_id = member.workspace_id
         WHERE agent.id = $3 AND agent.workspace_id = memory.workspace_id
           AND project_member.project_id = memory.project_id
       )
     ORDER BY memory.created_at, memory.id`,
    [scope.workspaceId, scope.projectId, scope.agentId]
  );
  return selectProjectMemoryContext(rows.rows.map((row) => ({
    id: row.id, type: row.memory_type, statement: row.statement,
    lifecycle: row.lifecycle, createdAt: row.created_at.toISOString()
  })), limit);
}

export function renderProjectMemoryContext(entries: ProjectMemoryContextEntry[]): string {
  return entries
    .map(({ type, statement }) => `[${type}] ${statement.slice(0, 1000)}`)
    .join('\n');
}

export async function loadProjectMemoryContext(
  pool: Pool,
  access: WorkspaceAccess,
  projectId: string,
  limit = 20
): Promise<ProjectMemoryContextEntry[]> {
  const rows = await pool.query<{
    id: string; memory_type: MemoryType; statement: string;
    lifecycle: ProjectMemoryContextEntry['lifecycle']; created_at: Date;
  }>(
    `SELECT memory.id, memory.memory_type, memory.statement, memory.lifecycle, memory.created_at
     FROM public.project_memory memory
     WHERE memory.workspace_id = $1 AND memory.project_id = $3
       AND EXISTS (
         SELECT 1 FROM public.workspace_member member
         JOIN public.workspace_membership membership ON membership.id = member.pilot_membership_id
         JOIN public.project_membership project_member ON project_member.workspace_member_id = member.id
         WHERE member.workspace_id = $1 AND membership.id = $2
           AND membership.revoked_at IS NULL AND project_member.project_id = memory.project_id
       )
     ORDER BY memory.created_at, memory.id`,
    [access.workspace.id, access.membership.id, projectId]
  );
  return selectProjectMemoryContext(rows.rows.map((row) => ({
    id: row.id, type: row.memory_type, statement: row.statement,
    lifecycle: row.lifecycle, createdAt: row.created_at.toISOString()
  })), limit);
}
