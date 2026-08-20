import { json } from '@sveltejs/kit';

import { getDatabasePool } from '$lib/server/database/pool.js';
import { formatError } from '$lib/server/errors.js';
import { checkRuntimeReadiness } from '$lib/server/runtime.js';

export async function GET(): Promise<Response> {
  try {
    const readiness = await checkRuntimeReadiness(getDatabasePool());
    return json({ service: 'web', status: 'ok', ...readiness });
  } catch (error) {
    console.error(JSON.stringify({ event: 'web.health.failed', error: formatError(error) }));
    return json({ service: 'web', status: 'unavailable' }, { status: 503 });
  }
}
