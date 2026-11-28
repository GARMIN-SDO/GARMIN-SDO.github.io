import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseContent } from '../js/contentData.js';

const source = readFileSync(new URL('../js/appV2.js', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('async function submitAnonymousResult()'), source.indexOf('function renderRedemption('));
const ui = parseContent(readFileSync(new URL('../content.csv', import.meta.url), 'utf8')).ui;
const failureMessage = '抽獎排隊人潮眾多，請重新抽獎～';
function environment() {
  let pending = null;
  const sent = [], rendered = [], elements = new Map();
  const state = { result: { sustainability: true, runnerType: 'experience', hydrationStyle: 'pioneer', q4Answer: 'q4_pioneer' },
    language: 'zh', requestId: null, sessionId: 'original-session', answers: { q1: 'original' } };
  const ctx = vm.createContext({ state, API_STATUS: { configured: true }, MOCK_MODE: false, APPS_SCRIPT_DEMO_MODE: true,
    $: key => { if (!elements.has(key)) elements.set(key, {}); return elements.get(key); },
    document: { querySelectorAll: () => [] }, copy: key => ui[key]?.zh || key, id: () => 'original-request',
    derivePrizeEligibility: () => ({}), readPendingRequest: () => pending,
    savePendingRequest: value => { pending = structuredClone(value); }, clearPendingRequest: () => { pending = null; },
    getPublicCampaignStatus: async () => ({ ok: true, demoMode: true, quizVersion: 2, submissionVersion: 1 }),
    getExistingAllocation: async () => ({ ok: true, found: false }),
    sendAnonymousResult: async payload => { sent.push(structuredClone(payload)); throw new Error('TIMEOUT'); },
    confirmAllocation: async () => null, isConfirmedAllocation: r => Boolean(r?.found && r.allocation?.ok),
    renderRedemption: value => rendered.push(value)
  });
  vm.runInContext(functions, ctx);
  return { ctx, state, sent, rendered, elements, pending: () => pending };
}

test('timeout keeps original payload and IDs; manual retry never uses subsequently edited answers', async () => {
  const e = environment();
  await e.ctx.submitAnonymousResult();
  assert.equal(e.pending().requestId, 'original-request');
  assert.equal(e.pending().demoMode, true);
  assert.equal(e.state.submitInProgress, false);
  assert.equal(e.elements.get('[data-result-error]').textContent, failureMessage);
  assert.equal(e.elements.get('[data-action=continue]').textContent, '重新抽獎');
  e.state.answers.q1 = 'changed'; e.state.requestId = null;
  await e.ctx.submitAnonymousResult();
  assert.equal(e.sent.length, 2);
  assert.deepEqual(e.sent[1], e.sent[0]);
  assert.equal(Object.hasOwn(e.sent[1], 'demoMode'), false);
});

test('confirmed original result avoids retry POST; wrong environment cannot replay', async () => {
  const e = environment(); await e.ctx.submitAnonymousResult();
  e.ctx.APPS_SCRIPT_DEMO_MODE = false;
  await e.ctx.submitAnonymousResult();
  assert.equal(e.sent.length, 1); assert.ok(e.pending());
  e.ctx.APPS_SCRIPT_DEMO_MODE = true;
  e.ctx.getExistingAllocation = async () => ({ found: true, allocation: { ok: true, requestId: 'original-request' } });
  await e.ctx.submitAnonymousResult();
  assert.equal(e.sent.length, 1); assert.equal(e.pending(), null); assert.equal(e.rendered.length, 1);
});

test('automatic recovery clears pending only after a confirmed result and prevents overlapping submit', async () => {
  const e = environment(); let release;
  e.ctx.confirmAllocation = () => new Promise(resolve => { release = resolve; });
  const first = e.ctx.submitAnonymousResult();
  // Allow status and failed POST promises to reach the confirmation phase.
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(e.state.submitInProgress, true);
  await e.ctx.submitAnonymousResult(); assert.equal(e.sent.length, 1);
  release({ ok: true, requestId: 'original-request' }); await first;
  assert.equal(e.pending(), null); assert.equal(e.state.submitInProgress, false);
});

test('legacy pending remains queryable but unknown origin never causes a new POST or ID', async () => {
  const e = environment(); await e.ctx.submitAnonymousResult();
  delete e.pending().environment; delete e.pending().demoMode;
  e.ctx.id = () => { throw new Error('NEW_ID_FORBIDDEN'); };
  e.state.requestId = null;
  await e.ctx.submitAnonymousResult();
  assert.equal(e.sent.length, 1); assert.ok(e.pending());
  assert.equal(e.pending().environment, undefined);
  assert.equal(e.elements.get('[data-result-error]').textContent, failureMessage);
  e.ctx.getExistingAllocation = async () => ({ found: true, allocation: { ok: true } });
  await e.ctx.submitAnonymousResult();
  assert.equal(e.pending(), null); assert.equal(e.sent.length, 1);
});

test('all final submission failures share the same message and draw-again button', async () => {
  for (const code of ['TIMEOUT','UNKNOWN','LOCK_BUSY','INTERNAL_ERROR','INVALID_ANSWER','UNSUPPORTED_QUIZ_VERSION','API_ENVIRONMENT_MISMATCH']) {
    const e = environment();
    e.ctx.sendAnonymousResult = async () => ({ ok: false, code });
    await e.ctx.submitAnonymousResult();
    assert.equal(e.elements.get('[data-result-error]').textContent, failureMessage, code);
    assert.equal(e.elements.get('[data-action=continue]').textContent, '重新抽獎', code);
    assert.ok(e.pending(), code);
  }
  const unavailable = environment(); unavailable.ctx.API_STATUS.configured = false;
  await unavailable.ctx.submitAnonymousResult();
  assert.equal(unavailable.elements.get('[data-result-error]').textContent, failureMessage);
  assert.equal(unavailable.elements.get('[data-action=continue]').textContent, '重新抽獎');
  assert.equal(unavailable.sent.length, 0);
});

test('allocated and confirmed sold-out responses keep the redemption path, including recovery', async () => {
  for (const allocationStatus of ['allocated','paused']) for (const recovery of [false,true]) {
    const e = environment();
    const allocation = { ok: true, demoMode: true, allocationStatus, requestId: 'original-request' };
    if (recovery) e.ctx.confirmAllocation = async () => allocation;
    else e.ctx.sendAnonymousResult = async () => allocation;
    await e.ctx.submitAnonymousResult();
    assert.equal(e.pending(), null);
    assert.equal(e.rendered.length, 1);
    assert.equal(e.rendered[0].allocationStatus, allocationStatus);
    assert.equal(e.elements.get('[data-result-error]').hidden, true);
  }
});

test('Mock pending cannot replay into Apps Script Demo even though both have demoMode true', async () => {
  const e = environment(); e.ctx.MOCK_MODE = true; await e.ctx.submitAnonymousResult();
  assert.equal(e.pending().environment, 'mock');
  e.ctx.MOCK_MODE = false;
  e.ctx.getExistingAllocation = async () => { throw new Error('CROSS_MODE_LOOKUP_FORBIDDEN'); };
  await e.ctx.submitAnonymousResult();
  assert.equal(e.sent.length, 1); assert.equal(e.pending().environment, 'mock');
});
