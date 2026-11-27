import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareMessages, nextStatus } from '../src/domain/ordering.js';

const apply = (events: string[]) => events.reduce(nextStatus, 'queued');

test('status moves forward through the normal lifecycle', () => {
  assert.equal(apply(['sent', 'delivered']), 'delivered');
  assert.equal(apply(['sent', 'failed']), 'failed');
});

test('delivered arriving before sent is not undone by the late sent', () => {
  assert.equal(apply(['delivered', 'sent']), 'delivered');
});

test('duplicate and unknown statuses change nothing', () => {
  assert.equal(apply(['sent', 'sent', 'sent']), 'sent');
  assert.equal(apply(['sent', 'read_by_martians']), 'sent');
});

test('the first final status wins', () => {
  assert.equal(apply(['delivered', 'failed']), 'delivered');
  assert.equal(apply(['failed', 'delivered']), 'failed');
});

test('messages sort by occurred_at, then message id, regardless of arrival order', () => {
  const arrived = [
    { pigeon_id: 'pmsg_00003', occurred_at: '2026-11-18T09:30:02.000Z' },
    { pigeon_id: 'pmsg_00002', occurred_at: '2026-11-18T09:30:00.500Z' },
    { pigeon_id: 'pmsg_00005', occurred_at: '2026-11-18T09:30:00.500Z' },
    { pigeon_id: 'pmsg_00001', occurred_at: '2026-11-18T09:30:00.123Z' },
  ];
  assert.deepEqual(
    [...arrived].sort(compareMessages).map((m) => m.pigeon_id),
    ['pmsg_00001', 'pmsg_00002', 'pmsg_00005', 'pmsg_00003'],
  );
});
