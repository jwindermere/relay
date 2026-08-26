import { createHmac, timingSafeEqual } from 'node:crypto';

interface RealtimeTicketPayload {
  expiresAt: number;
  sessionId: string;
}

function signature(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest();
}

export function issueRealtimeTicket(
  sessionId: string,
  secret: string,
  now = Date.now(),
  lifetimeMs = 60_000
): string {
  const payload = Buffer.from(JSON.stringify({
    expiresAt: now + lifetimeMs,
    sessionId
  } satisfies RealtimeTicketPayload)).toString('base64url');
  return `${payload}.${signature(payload, secret).toString('base64url')}`;
}

export function verifyRealtimeTicket(
  ticket: string,
  sessionId: string,
  secret: string,
  now = Date.now()
): boolean {
  const [payload, suppliedSignature, extra] = ticket.split('.');
  if (!payload || !suppliedSignature || extra) return false;
  try {
    const expected = signature(payload, secret);
    const supplied = Buffer.from(suppliedSignature, 'base64url');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return false;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as RealtimeTicketPayload;
    return parsed.sessionId === sessionId
      && Number.isSafeInteger(parsed.expiresAt)
      && now <= parsed.expiresAt;
  } catch {
    return false;
  }
}

export function requireRealtimeSecret(environment: NodeJS.ProcessEnv = process.env): string {
  const secret = environment.RELAY_REALTIME_SECRET;
  if (!secret) throw new Error('RELAY_REALTIME_SECRET is required');
  return secret;
}
