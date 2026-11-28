import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmAllocation, isConfirmedAllocation } from '../js/allocationConfirmation.js';

const pending = { requestId: 'original-request', sessionId: 'original-session' };
const response = () => ({ ok: true, found: true, demoMode: true, allocation: {
  ok: true, demoMode: true, ...pending, participantId: 'participant', allocationStatus: 'allocated'
} });

test('bounded recovery retains original identity through misses and transport failures', async () => {
  const waits = [], seen = [];
  const result = await confirmAllocation(pending, async original => {
    seen.push(original);
    if (seen.length === 1) throw new Error('TIMEOUT');
    return seen.length === 2 ? { ok: true, found: false } : response();
  }, { demoMode: true, random: () => 0.5, wait: async ms => waits.push(ms) });
  assert.equal(result.requestId, pending.requestId);
  assert.deepEqual(waits, [1500, 3500, 7000]);
  assert.ok(seen.every(value => value === pending));
});

test('unresolved recovery stops at three GETs; wrong environment or identity cannot confirm', async () => {
  for (const change of [r => { r.allocation.sessionId = 'other'; }, r => { r.allocation.requestId = 'other'; },
    r => { r.demoMode = false; }, r => { r.allocation.demoMode = false; },
    r => { r.allocation.allocationStatus = 'processing'; }, r => { delete r.allocation.participantId; }]) {
    const wrong = response(); change(wrong); let calls = 0;
    assert.equal(await confirmAllocation(pending, async () => { calls++; return wrong; }, {
      demoMode: true, wait: async () => {}, random: () => 0
    }), null);
    assert.equal(calls, 3);
  }
});

test('confirmed result stops immediately; paused is valid and missing session only allowed for Mock', async () => {
  const r = response(); r.allocation.allocationStatus = 'paused'; let calls = 0;
  assert.equal((await confirmAllocation(pending, async () => { calls++; return r; }, {
    demoMode: true, wait: async () => {}
  })).allocationStatus, 'paused');
  assert.equal(calls, 1);
  delete r.allocation.sessionId;
  assert.equal(isConfirmedAllocation(r, pending, true), false);
  assert.equal(isConfirmedAllocation(r, pending, true, true), true);
});
