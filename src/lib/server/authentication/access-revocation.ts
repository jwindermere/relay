import type { Notification, Pool, QueryResult } from 'pg';

const ACCESS_REVOCATION_CHANNEL = 'relay_access_revoked';

export type AccessRevocation =
  | { kind: 'session'; sessionId: string; userId: string }
  | { kind: 'membership'; membershipId: string };

interface Queryable {
  query: (text: string, values?: unknown[]) => Promise<QueryResult>;
}

export async function publishAccessRevoked(
  database: Queryable,
  revocation: AccessRevocation
): Promise<void> {
  await database.query('SELECT pg_notify($1, $2)', [
    ACCESS_REVOCATION_CHANNEL,
    JSON.stringify(revocation)
  ]);
}

export async function subscribeToAccessRevocations(
  pool: Pool,
  onRevoked: (revocation: AccessRevocation) => void
): Promise<() => Promise<void>> {
  const client = await pool.connect();
  const onNotification = ({ channel, payload }: Notification) => {
    if (channel !== ACCESS_REVOCATION_CHANNEL || !payload) return;
    try {
      const revocation = JSON.parse(payload) as AccessRevocation;
      if (
        revocation.kind === 'membership' &&
        typeof revocation.membershipId === 'string'
      ) {
        onRevoked(revocation);
      } else if (
        revocation.kind === 'session' &&
        typeof revocation.userId === 'string' &&
        typeof revocation.sessionId === 'string'
      ) {
        onRevoked(revocation);
      }
    } catch {
      // Ignore malformed notifications; request-level authorization remains authoritative.
    }
  };

  client.on('notification', onNotification);
  await client.query(`LISTEN ${ACCESS_REVOCATION_CHANNEL}`);

  return async () => {
    client.removeListener('notification', onNotification);
    await client.query(`UNLISTEN ${ACCESS_REVOCATION_CHANNEL}`);
    client.release();
  };
}
