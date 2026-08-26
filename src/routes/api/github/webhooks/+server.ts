import { json } from '@sveltejs/kit';

import { getDatabasePool } from '$lib/server/database/pool.js';
import {
  GitHubWebhookSignatureError,
  ingestGitHubWebhook
} from '$lib/server/github/webhooks.js';

export async function POST({ request }) {
  try {
    const secret = process.env.RELAY_GITHUB_WEBHOOK_SECRET;
    if (!secret) throw new Error('RELAY_GITHUB_WEBHOOK_SECRET is required');
    const deliveryId = request.headers.get('x-github-delivery') ?? '';
    const eventName = request.headers.get('x-github-event') ?? '';
    const signature = request.headers.get('x-hub-signature-256') ?? '';
    const result = await ingestGitHubWebhook(getDatabasePool(), {
      deliveryId,
      eventName,
      signature,
      body: Buffer.from(await request.arrayBuffer()),
      secret
    });
    return json(result, { status: result.duplicate ? 200 : 202 });
  } catch (error) {
    if (error instanceof GitHubWebhookSignatureError) {
      return json({ message: error.message }, { status: 401 });
    }
    if (error instanceof SyntaxError) {
      return json({ message: 'GitHub webhook payload is invalid' }, { status: 400 });
    }
    throw error;
  }
}
