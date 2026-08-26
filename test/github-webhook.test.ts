import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import {
  GitHubWebhookSignatureError,
  parseSignedGitHubWebhook
} from '../src/lib/server/github/webhooks.js';

test('signed GitHub webhooks are validated and reduced to redacted correlation evidence', () => {
  const secret = 'webhook-test-secret';
  const body = Buffer.from(JSON.stringify({
    ref: 'refs/heads/relay/run-25',
    after: 'a'.repeat(40),
    repository: { id: 202, full_name: 'relay-owner/pilot' },
    installation: { id: 101, access_token: 'must-not-survive' },
    pull_request: { number: 17, html_url: 'https://github.test/pr/17' },
    token: 'also-private'
  }));
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  const delivery = parseSignedGitHubWebhook({
    deliveryId: 'delivery-25', eventName: 'push', signature, body, secret
  });

  assert.equal(delivery.repositoryId, '202');
  assert.equal(delivery.installationId, '101');
  assert.equal(delivery.branch, 'relay/run-25');
  assert.equal(delivery.agentRunId, 'run-25');
  assert.equal(delivery.commitSha, 'a'.repeat(40));
  assert.equal(delivery.pullRequestNumber, 17);
  assert.doesNotMatch(JSON.stringify(delivery.payload), /must-not-survive|also-private/);
  assert.match(JSON.stringify(delivery.payload), /\[REDACTED\]/);
});

test('an invalid webhook signature is rejected before its payload is parsed', () => {
  assert.throws(() => parseSignedGitHubWebhook({
    deliveryId: 'delivery-bad',
    eventName: 'push',
    signature: `sha256=${'0'.repeat(64)}`,
    body: Buffer.from('{not json'),
    secret: 'webhook-test-secret'
  }), GitHubWebhookSignatureError);
});
