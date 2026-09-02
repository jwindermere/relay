import { readFile } from 'node:fs/promises';

export type InvitationDeliveryMode = 'email' | 'manual';

export const WORKER_SECRET_ENVIRONMENT = Object.freeze([
  'DATABASE_URL',
  'RELAY_GITHUB_PRIVATE_KEY'
]);

export async function loadFileBackedEnvironment(
  names: readonly string[],
  environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  for (const name of names) {
    const fileVariable = `${name}_FILE`;
    const file = environment[fileVariable];
    if (!file) continue;
    if (environment[name]) {
      throw new Error(`${name} and ${fileVariable} must not both be set`);
    }

    const value = (await readFile(file, 'utf8')).replace(/[\r\n]+$/, '');
    if (!value) throw new Error(`${fileVariable} points to an empty secret`);
    environment[name] = value;
    delete environment[fileVariable];
  }
}

export function getInvitationDeliveryMode(
  environment: NodeJS.ProcessEnv = process.env
): InvitationDeliveryMode {
  const configured = environment.RELAY_INVITATION_DELIVERY_MODE?.trim().toLowerCase() || 'email';
  if (configured !== 'email' && configured !== 'manual') {
    throw new Error('RELAY_INVITATION_DELIVERY_MODE must be email or manual');
  }
  return configured;
}

export function getJitsiBaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.RELAY_JITSI_BASE_URL?.trim() || 'https://meet.jit.si';
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('RELAY_JITSI_BASE_URL must be an absolute URL');
  }
  const localDevelopment = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(localDevelopment && url.protocol === 'http:')) {
    throw new Error('RELAY_JITSI_BASE_URL must use HTTPS (HTTP is allowed only for localhost)');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('RELAY_JITSI_BASE_URL must not contain credentials, a query, or a fragment');
  }
  return url.toString().replace(/\/$/, '');
}

export function isJitsiEmbeddingEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  const configured = environment.RELAY_JITSI_EMBED_ENABLED?.trim().toLowerCase();
  if (!configured) return false;
  if (!['true', 'false'].includes(configured)) {
    throw new Error('RELAY_JITSI_EMBED_ENABLED must be true or false');
  }
  if (configured === 'false') return false;

  const baseUrl = new URL(getJitsiBaseUrl(environment));
  if (baseUrl.hostname === 'meet.jit.si') {
    throw new Error('Embedded Calls require a self-hosted Jitsi deployment');
  }
  if (baseUrl.pathname !== '/') {
    throw new Error('Embedded Jitsi must use a dedicated origin without a base path');
  }
  return true;
}

export function buildJitsiMeetingUrl(
  roomName: string,
  environment: NodeJS.ProcessEnv = process.env
): string {
  if (!/^[a-zA-Z0-9_-]{16,200}$/.test(roomName)) {
    throw new Error('Jitsi room name is invalid');
  }
  return `${getJitsiBaseUrl(environment)}/${encodeURIComponent(roomName)}`;
}
