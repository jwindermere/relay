import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createDatabasePool } from '../lib/server/database/pool.js';
import { checkRuntimeReadiness } from '../lib/server/runtime.js';

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

  server.listen(port, host, () => {
    console.log(JSON.stringify({ event: 'web.ready', host, port, ...readiness }));
  });

  const shutdown = (signal: NodeJS.Signals) => {
    console.log(JSON.stringify({ event: 'web.stopping', signal }));
    server.close(async () => {
      await pool.end();
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
