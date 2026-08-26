import assert from 'node:assert/strict';
import { test } from 'node:test';

import { issueRealtimeTicket, verifyRealtimeTicket } from '../src/lib/server/realtime-ticket.js';

test('a WebSocket ticket is scoped to one session and expires', () => {
  const ticket = issueRealtimeTicket('session-27', 'realtime-secret', 1_000, 1_500);
  assert.equal(verifyRealtimeTicket(ticket, 'session-27', 'realtime-secret', 2_000), true);
  assert.equal(verifyRealtimeTicket(ticket, 'another-session', 'realtime-secret', 2_000), false);
  assert.equal(verifyRealtimeTicket(ticket, 'session-27', 'realtime-secret', 3_000), false);
});

test('rotating the WebSocket secret independently revokes outstanding tickets', () => {
  const ticket = issueRealtimeTicket('session-27', 'old-realtime-secret', 1_000, 10_000);
  assert.equal(verifyRealtimeTicket(ticket, 'session-27', 'new-realtime-secret', 2_000), false);
});
