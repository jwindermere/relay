import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';

export class GitHubWebhookSignatureError extends Error {
  constructor() {
    super('GitHub webhook signature is invalid');
    this.name = 'GitHubWebhookSignatureError';
  }
}

export interface ParsedGitHubWebhook {
  deliveryId: string;
  eventName: string;
  repositoryId: string;
  installationId: string;
  branch?: string;
  agentRunId?: string;
  commitSha?: string;
  pullRequestNumber?: number;
  payload: Record<string, unknown>;
}

export function parseSignedGitHubWebhook(input: {
  deliveryId: string;
  eventName: string;
  signature: string;
  body: Buffer;
  secret: string;
}): ParsedGitHubWebhook {
  const expected = createHmac('sha256', input.secret).update(input.body).digest();
  const signatureMatch = /^sha256=([a-f0-9]{64})$/i.exec(input.signature);
  const supplied = signatureMatch ? Buffer.from(signatureMatch[1]!, 'hex') : Buffer.alloc(0);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new GitHubWebhookSignatureError();
  }
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(input.deliveryId)
    || !/^[A-Za-z0-9._-]{1,100}$/.test(input.eventName)) {
    throw new Error('GitHub webhook headers are invalid');
  }

  const parsed: unknown = JSON.parse(input.body.toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('GitHub webhook payload is invalid');
  }
  const payload = parsed as Record<string, unknown>;
  const repository = asRecordOrEmpty(payload.repository);
  const installation = asRecordOrEmpty(payload.installation);
  const pullRequest = asRecordOrEmpty(payload.pull_request);
  const repositoryId = safeIdentifier(repository.id, 'repository ID');
  const installationId = safeIdentifier(installation.id, 'installation ID');
  const branch = readBranch(payload, pullRequest);
  const commitSha = readCommitSha(payload, pullRequest);
  const pullRequestNumber = safePositiveInteger(pullRequest.number);

  return {
    deliveryId: input.deliveryId,
    eventName: input.eventName,
    repositoryId,
    installationId,
    ...(branch ? { branch } : {}),
    ...(branch?.startsWith('relay/') ? { agentRunId: branch.slice('relay/'.length) } : {}),
    ...(commitSha ? { commitSha } : {}),
    ...(pullRequestNumber ? { pullRequestNumber } : {}),
    payload: safeWebhookEvidence(payload, {
      repositoryId, installationId, branch, commitSha, pullRequestNumber
    })
  };
}

export async function ingestGitHubWebhook(
  pool: Pool,
  input: Parameters<typeof parseSignedGitHubWebhook>[0]
): Promise<{ accepted: true; duplicate: boolean; agentRunId?: string }> {
  const delivery = parseSignedGitHubWebhook(input);
  const repository = await pool.query<{
    id: string;
    workspace_id: string;
    agent_run_id: string | null;
  }>(
    `SELECT linked.id, linked.workspace_id, run.id AS agent_run_id
     FROM public.linked_repository linked
     JOIN public.github_connection connection
       ON connection.id = linked.github_connection_id
      AND connection.workspace_id = linked.workspace_id
     LEFT JOIN public.agent_run run
       ON run.id = $3
      AND run.linked_repository_id = linked.id
      AND run.workspace_id = linked.workspace_id
     WHERE linked.repository_id = $1 AND connection.installation_id = $2`,
    [delivery.repositoryId, delivery.installationId, delivery.agentRunId ?? null]
  );
  const linked = repository.rows[0];
  if (!linked) throw new Error('GitHub webhook is for an unlinked repository');

  const inserted = await pool.query(
    `INSERT INTO public.github_webhook_delivery (
       delivery_id, event_name, workspace_id, linked_repository_id, agent_run_id,
       installation_id, repository_id, branch, commit_sha, pull_request_number, payload
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (delivery_id) DO NOTHING`,
    [
      delivery.deliveryId,
      delivery.eventName,
      linked.workspace_id,
      linked.id,
      linked.agent_run_id,
      delivery.installationId,
      delivery.repositoryId,
      delivery.branch ?? null,
      delivery.commitSha ?? null,
      delivery.pullRequestNumber ?? null,
      delivery.payload
    ]
  );
  return {
    accepted: true,
    duplicate: inserted.rowCount === 0,
    ...(linked.agent_run_id ? { agentRunId: linked.agent_run_id } : {})
  };
}

function asRecordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeIdentifier(value: unknown, name: string): string {
  if ((typeof value !== 'string' && typeof value !== 'number')
    || !/^[A-Za-z0-9_-]{1,100}$/.test(String(value))) {
    throw new Error(`GitHub webhook omitted ${name}`);
  }
  return String(value);
}

function safePositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function readBranch(payload: Record<string, unknown>, pullRequest: Record<string, unknown>) {
  const ref = typeof payload.ref === 'string' ? payload.ref : undefined;
  if (ref?.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  const headRef = asRecordOrEmpty(pullRequest.head).ref;
  return typeof headRef === 'string' && headRef.length <= 255 ? headRef : undefined;
}

function readCommitSha(payload: Record<string, unknown>, pullRequest: Record<string, unknown>) {
  const candidate = typeof payload.after === 'string'
    ? payload.after
    : asRecordOrEmpty(pullRequest.head).sha;
  return typeof candidate === 'string' && /^[a-f0-9]{40,64}$/i.test(candidate)
    ? candidate.toLowerCase()
    : undefined;
}

function safeWebhookEvidence(
  payload: Record<string, unknown>,
  correlation: {
    repositoryId: string;
    installationId: string;
    branch?: string;
    commitSha?: string;
    pullRequestNumber?: number;
  }
): Record<string, unknown> {
  const sender = asRecordOrEmpty(payload.sender);
  const senderId = typeof sender.id === 'number' || typeof sender.id === 'string'
    ? String(sender.id)
    : undefined;
  const senderLogin = typeof sender.login === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(sender.login)
    ? sender.login
    : undefined;
  const action = typeof payload.action === 'string' && /^[a-z_]{1,100}$/.test(payload.action)
    ? payload.action
    : undefined;
  return {
    repository: { id: correlation.repositoryId },
    installation: { id: correlation.installationId },
    ...(correlation.branch ? { branch: correlation.branch } : {}),
    ...(correlation.commitSha ? { commitSha: correlation.commitSha } : {}),
    ...(correlation.pullRequestNumber
      ? { pullRequest: { number: correlation.pullRequestNumber } }
      : {}),
    ...(action ? { action } : {}),
    ...(senderId || senderLogin ? { sender: { id: senderId, login: senderLogin } } : {})
  };
}
