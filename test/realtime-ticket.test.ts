import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { issueRealtimeTicket, verifyRealtimeTicket } from '../src/lib/server/realtime-ticket.js';
import { createRealtimeDevelopmentPlugin } from '../src/lib/server/realtime-vite.js';
import viteConfig from '../vite.config.js';

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

test('the Vite development server attaches and closes Relay realtime', () => {
  const configured = viteConfig as { plugins?: Array<{ name?: string }> };
  assert.ok(configured.plugins?.some(({ name }) => name === 'relay-realtime'));

  const httpServer = new EventEmitter();
  let attached = 0;
  let closed = 0;
  const plugin = createRealtimeDevelopmentPlugin(() => {
    attached += 1;
    return { close: () => { closed += 1; } };
  });
  const configureServer = plugin.configureServer as unknown as (
    server: { httpServer: EventEmitter | null }
  ) => void;

  configureServer({ httpServer });
  assert.equal(attached, 1);
  httpServer.emit('close');
  assert.equal(closed, 1);
});
