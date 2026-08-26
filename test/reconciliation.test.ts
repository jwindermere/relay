import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyChannelReconciliation,
  decodeAgentRunCursors,
  encodeAgentRunCursors,
  mergeChannelMessages
} from '../src/lib/reconciliation.js';

test('Channel reconciliation advances only through ordered unseen AgentRun events', () => {
  const initial = applyChannelReconciliation({}, {
    channelId: 'channel-1',
    runs: [{
      id: 'run-1',
      sourceMessageId: 'message-1',
      status: 'queued',
      summary: 'Engineering request queued',
      sequence: 1,
      events: [{
        sequence: 1,
        status: 'queued',
        summary: 'Engineering request queued'
      }]
    }]
  });
  assert.deepEqual(initial, {
    'run-1': {
      id: 'run-1',
      sourceMessageId: 'message-1',
      status: 'queued',
      summary: 'Engineering request queued',
      sequence: 1,
      milestones: [{
        sequence: 1,
        status: 'queued',
        summary: 'Engineering request queued'
      }]
    }
  });

  const afterDroppedWakeup = applyChannelReconciliation(initial, {
    channelId: 'channel-1',
    runs: [{
      id: 'run-1',
      sourceMessageId: 'message-1',
      status: 'working',
      summary: 'File change completed',
      sequence: 3,
      events: [
        { sequence: 2, status: 'working', summary: 'Working on the request' },
        { sequence: 3, status: 'working', summary: 'Working on the request' }
      ]
    }]
  });
  assert.equal(afterDroppedWakeup['run-1']?.sequence, 3);
  assert.equal(afterDroppedWakeup['run-1']?.summary, 'File change completed');
  assert.deepEqual(
    afterDroppedWakeup['run-1']?.milestones.map(({ sequence }) => sequence),
    [1, 2]
  );

  const duplicate = applyChannelReconciliation(afterDroppedWakeup, {
    channelId: 'channel-1',
    runs: [{
      id: 'run-1', sourceMessageId: 'message-1', status: 'working',
      summary: 'File change completed', sequence: 3, events: []
    }]
  });
  assert.deepEqual(duplicate, afterDroppedWakeup);

  const outOfOrder = applyChannelReconciliation(duplicate, {
    channelId: 'channel-1',
    runs: [{
      id: 'run-1', sourceMessageId: 'message-1', status: 'planning',
      summary: 'Codex thread started', sequence: 2, events: []
    }]
  });
  assert.deepEqual(outOfOrder, afterDroppedWakeup);

  const gap = applyChannelReconciliation(outOfOrder, {
    channelId: 'channel-1',
    runs: [{
      id: 'run-1', sourceMessageId: 'message-1', status: 'completed',
      summary: 'Engineering request completed', sequence: 5,
      events: [{
        sequence: 5,
        status: 'completed',
        summary: 'Engineering request completed'
      }]
    }]
  });
  assert.deepEqual(gap, afterDroppedWakeup);

  const fullRefresh = applyChannelReconciliation(afterDroppedWakeup, {
    channelId: 'channel-1',
    runs: [{
      id: 'run-1', sourceMessageId: 'message-1', status: 'completed',
      summary: 'Engineering request completed', sequence: 4,
      events: [
        { sequence: 1, status: 'queued', summary: 'Engineering request queued' },
        { sequence: 2, status: 'working', summary: 'Working on the request' },
        { sequence: 3, status: 'working', summary: 'Working on the request' },
        { sequence: 4, status: 'completed', summary: 'Engineering request completed' }
      ]
    }]
  });
  assert.equal(fullRefresh['run-1']?.sequence, 4);
  assert.equal(fullRefresh['run-1']?.status, 'completed');
  assert.deepEqual(
    fullRefresh['run-1']?.milestones.map(({ sequence }) => sequence),
    [1, 2, 4]
  );
});

test('Channel reconciliation merges committed Messages once in durable order', () => {
  const initial = [{ id: 'message-2', createdAt: '2026-08-26T10:00:02.000Z' }];
  const merged = mergeChannelMessages(initial, [
    { id: 'message-1', createdAt: '2026-08-26T10:00:01.000Z' },
    { id: 'message-2', createdAt: '2026-08-26T10:00:02.000Z' }
  ]);
  assert.deepEqual(merged.map(({ id }) => id), ['message-1', 'message-2']);
});

test('AgentRun cursors round-trip as a validated map', () => {
  assert.deepEqual(
    decodeAgentRunCursors(encodeAgentRunCursors({ 'run:with:colons': 7 })),
    { 'run:with:colons': 7 }
  );
  assert.deepEqual(decodeAgentRunCursors('{"run-1":-1,"run-2":"2"}'), {});
});
