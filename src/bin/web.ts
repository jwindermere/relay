import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createDatabasePool } from '../lib/server/database/pool.js';
import { loadFileBackedEnvironment } from '../lib/server/configuration.js';
import { getAuthDatabasePool, getRelayAuth } from '../lib/server/auth.js';
import { formatError } from '../lib/server/errors.js';
import { attachAuthenticatedRealtime } from '../lib/server/realtime.js';
import { requireRealtimeSecret } from '../lib/server/realtime-ticket.js';
import { checkRuntimeReadiness } from '../lib/server/runtime.js';

await loadFileBackedEnvironment([
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'RELAY_EMAIL_DELIVERY_TOKEN',
  'RELAY_REALTIME_SECRET',
  'RELAY_GITHUB_PRIVATE_KEY',
  'RELAY_GITHUB_WEBHOOK_SECRET'
]);
const pool = createDatabasePool();

try {
  const readiness = await checkRuntimeReadiness(pool);
  const handlerUrl = pathToFileURL(resolve(process.cwd(), 'build/handler.js')).href;
  const { handler } = (await import(handlerUrl)) as {
    handler: Parameters<typeof createServer>[0];
  };
  const host = process.env.HOST ?? '0.0.0.0';
  const port = Number(process.env.PORT ?? 3000);
  const server = createServer(handler);
  const realtime = attachAuthenticatedRealtime(
    server,
    pool,
    getRelayAuth(),
    requireRealtimeSecret()
  );

  server.listen(port, host, () => {
    console.log(JSON.stringify({ event: 'web.ready', host, port, ...readiness }));
  });

  const shutdown = (signal: NodeJS.Signals) => {
    console.log(JSON.stringify({ event: 'web.stopping', signal }));
    for (const client of realtime.clients) client.close(1001, 'Server stopping');
    realtime.close();
    server.close(async () => {
      await Promise.all([pool.end(), getAuthDatabasePool().end()]);
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  console.error(JSON.stringify({ event: 'web.startup.failed', error: formatError(error) }));
  await pool.end();
  process.exit(1);
}
