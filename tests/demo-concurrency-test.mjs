import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { classifyV2AnswerIds } from '../js/classificationEngine.js';
import { derivePrizeEligibility } from '../js/prizeEligibility.js';
import { validateAnonymousPayload } from '../js/participationValidation.js';

export const LEVELS = Object.freeze({ baseline: [1], medium: [10, 20], high: [30, 40] });
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PRIZES = ['cap', 'soft_cup', 'socks', 'arm_sleeves', 'shopping_bag'];

export async function configuredUrl() {
  const source = await readFile(new URL('../js/environment.js', import.meta.url), 'utf8');
  const match = source.match(/const APPS_SCRIPT_WEB_APP_URL = "([^"]+)";/);
  if (!match) throw new Error('API_CONFIG_UNKNOWN');
  const url = new URL(match[1]);
  url.searchParams.set('mode', 'apps-script-demo');
  return url.href;
}

export function assertDemo(raw, configured) {
  const u = new URL(raw), expected = new URL(configured);
  if (u.protocol !== 'https:' || u.origin !== 'https://script.google.com' || u.username || u.password || u.hash ||
      u.pathname !== expected.pathname || !u.pathname.endsWith('/exec') ||
      u.searchParams.getAll('mode').length !== 1 || u.searchParams.get('mode') !== 'apps-script-demo' ||
      [...u.searchParams.keys()].some(k => k !== 'mode')) throw new Error('DEMO_URL_REJECTED');
  return u.href;
}

export function makePayload(batchId, index) {
  const types = ['experience', 'lifestyle', 'performance'];
  const answers = Object.fromEntries(['q1', 'q2', 'q3', 'q5'].map((q, n) => [q, `${q}_${types[(index + n % 2) % 3]}`]));
  answers.q4 = `q4_${['precision', 'rest', 'pioneer'][index % 3]}`;
  const c = classifyV2AnswerIds(answers);
  return validateAnonymousPayload({ submissionVersion: 1, quizVersion: 2, answers,
    hydrationStyle: c.hydrationStyle, q4Answer: c.q4Answer,
    ...derivePrizeEligibility({ runnerType: c.runnerType, existingSelfHydration: c.existingSelfHydration,
      hydrationCommitment: index % 2 ? 'joined' : 'considering' }),
    requestId: `${batchId}-${randomUUID()}`, sessionId: `session-${randomUUID()}` });
}

// Apps Script ContentService uses 302/303 to a GET-only googleusercontent URL.
// Never forward POST bodies across hosts or accept a redirect back to a production /exec.
export async function http(url, { payload, timeoutMs = 15000, fetchImpl = fetch } = {}) {
  const startedAt = new Date().toISOString(), start = performance.now();
  const signal = AbortSignal.timeout(timeoutMs);
  let method = payload ? 'POST' : 'GET', current = new URL(url), redirected = false;
  let httpStatus = null;
  try {
    for (let n = 0; n < 6; n++) {
      const response = await fetchImpl(current, { method, redirect: 'manual', signal,
        ...(method === 'POST' ? { headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(payload) } : {}) });
      httpStatus = response.status;
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error('INVALID_REDIRECT');
        const next = new URL(location, current);
        await response.body?.cancel();
        if (next.protocol !== 'https:' || next.hostname !== 'script.googleusercontent.com' || next.username || next.password ||
            (method === 'POST' && [307, 308].includes(response.status))) throw new Error('UNSAFE_REDIRECT');
        method = 'GET'; current = next; redirected = true; continue;
      }
      const text = await response.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* Never persist HTML, cookies or raw error bodies. */ }
      const quota = /quota|too many|rate.?limit|simultaneously|service invoked too many/i.test(text);
      const invalidResponse = !body || typeof body !== 'object' || Array.isArray(body);
      return { startedAt, durationMs: performance.now() - start, httpStatus, redirected,
        timeout: false, invalidResponse, ok: response.ok && body?.ok === true,
        errorCode: quota ? 'QUOTA_OR_EXECUTION_LIMIT' : !response.ok ? `HTTP_${httpStatus}` : invalidResponse ? 'INVALID_JSON' : body.code || '', body };
    }
    throw new Error('TOO_MANY_REDIRECTS');
  } catch (e) {
    return { startedAt, durationMs: performance.now() - start, httpStatus, redirected, ok: false,
      timeout: signal.aborted, invalidResponse: false, errorCode: signal.aborted ? 'TIMEOUT' :
        ['UNSAFE_REDIRECT', 'INVALID_REDIRECT', 'TOO_MANY_REDIRECTS'].includes(e.message) ? e.message : 'NETWORK_ERROR', body: null };
  }
}

export function validStatus(r) {
  return r.ok && r.body?.demoMode === true && r.body.quizVersion === 2 && r.body.submissionVersion === 1 && r.body.allocationEnabled === true;
}

export function actionUrl(apiUrl, action, payload) {
  const u = new URL(apiUrl); u.searchParams.set('action', action);
  if (payload) for (const k of ['requestId', 'sessionId']) u.searchParams.set(k, payload[k]);
  return u.href;
}

export function validAllocation(body, payload) {
  return body?.ok === true && body.demoMode === true && body.requestId === payload.requestId && body.sessionId === payload.sessionId &&
    typeof body.participantId === 'string' && body.participantId.startsWith('staging_') &&
    body.runnerType === payload.runnerType && body.sustainabilityRewardEligible === payload.sustainabilityRewardEligible &&
    ((body.allocationStatus === 'allocated' && PRIZES.includes(body.prize?.prizeId) &&
      (body.prize.prizeId !== 'shopping_bag' || payload.premiumPrizeEligible)) ||
      (body.allocationStatus === 'paused' && body.prize === null));
}

export function publicRecord(r, meta, operation) {
  const timing = r.body?.demoMode === true || r.body?.diagnostics?.demoMode === true ? r.body?.diagnostics : null;
  const measured = {};
  if (timing?.demoMode === true && timing.requestId === meta.requestId && timing.version === 2 &&
    ['lockWaitMs','lockHeldMs','totalMs','requestLookupMs','sheetReadMs','sheetWriteMs'].every(k=>Number.isFinite(timing[k])&&timing[k]>=0)) {
    for (const key of ['lockWaitMs','lockHeldMs','totalMs','requestLookupMs','sheetReadMs','sheetWriteMs']) {
      if (Number.isFinite(timing[key]) && timing[key] >= 0) measured[`backend_${key}`] = timing[key];
    }
    measured.backend_attemptId = String(timing.attemptId || '');
    if (Number.isFinite(timing.sheetFlushMs) && timing.sheetFlushMs >= 0) measured.backend_sheetFlushMs = timing.sheetFlushMs;
  }
  return { ...meta, ...measured, operation, startedAt: r.startedAt, durationMs: +r.durationMs.toFixed(2), httpStatus: r.httpStatus,
    ok: r.ok, errorCode: r.errorCode, timeout: r.timeout, invalidResponse: r.invalidResponse, redirected: r.redirected,
    allocationStatus: r.body?.allocationStatus || '', prizeId: r.body?.prize?.prizeId || '',
    idempotentReplay: r.body?.idempotentReplay === true,
    recoveryFound: typeof r.body?.found === 'boolean' ? r.body.found : '',
    recoveryAllocationStatus: r.body?.allocation?.allocationStatus || '' };
}

export async function runner(apiUrl, payload, meta, workflow, httpRows, transport = http) {
  const start = performance.now(), startedAt = new Date().toISOString();
  if (workflow === 'flow') {
    const get = await transport(actionUrl(apiUrl, 'getPublicCampaignStatus'));
    if (!validStatus(get)) { get.ok = false; get.errorCode ||= 'DEMO_PREFLIGHT_FAILED'; }
    httpRows.push(publicRecord(get, meta, 'status'));
    if (!get.ok) return { ...meta, startedAt, durationMs: performance.now() - start, ok: false,
      errorCode: get.errorCode, timeout: get.timeout, posted: false, finalState: 'NOT_SUBMITTED' };
  }
  const post = await transport(apiUrl, { payload, timeoutMs: 30000 });
  if (post.ok && !validAllocation(post.body, payload)) { post.ok = false; post.errorCode = 'ALLOCATION_CONTRACT_MISMATCH'; }
  httpRows.push(publicRecord(post, meta, 'submit'));
  return { ...publicRecord(post, meta, 'runner'), startedAt, durationMs: performance.now() - start, posted: true,
    participantId: post.body?.participantId || '', sessionId: payload.sessionId,
    finalState: post.ok ? post.body.allocationStatus : 'UNKNOWN' };
}

export function stopReason(rows) {
  if (rows.some(r => !r.ok)) return rows.find(r => !r.ok).errorCode || 'FAILED_REQUEST';
  if (rows.some(r => r.durationMs >= 25000)) return 'ABNORMAL_LATENCY_25S';
  if (rows.some(r => r.allocationStatus === 'paused')) return 'DEMO_STOCK_UNAVAILABLE';
  if (rows.some(r => r.idempotentReplay)) return 'UNEXPECTED_REPLAY';
  return null;
}

export function quantile(values, p) {
  const a = [...values].sort((x, y) => x - y);
  return a.length ? a[Math.max(0, Math.ceil(a.length * p) - 1)] : null;
}

export function summarize(rows, httpRows) {
  const groups = Map.groupBy(rows, r => `${r.workflow}/${r.concurrency}/${r.round}`);
  return [...groups.values()].map(g => {
    const m = g[0], times = g.map(r => r.durationMs), success = g.filter(r => r.ok && r.allocationStatus === 'allocated');
    const ids = new Set(g.map(r => r.requestId)), h = httpRows.filter(r => ids.has(r.requestId));
    const posts = h.filter(r => r.operation === 'submit');
    const elapsed = Math.max(...g.map(r => Date.parse(r.startedAt) + r.durationMs)) - Math.min(...g.map(r => Date.parse(r.startedAt)));
    return { workflow: m.workflow, concurrency: m.concurrency, round: m.round, totalRequests: g.length,
      successCount: success.length, successRate: success.length / g.length,
      httpErrorCount: h.filter(r => r.httpStatus >= 400).length,
      lockBusyCount: h.filter(r => r.errorCode === 'LOCK_BUSY').length,
      quotaErrorCount: h.filter(r => r.errorCode === 'QUOTA_OR_EXECUTION_LIMIT').length,
      timeoutCount: g.filter(r => r.timeout).length, invalidResponseCount: h.filter(r => r.invalidResponse).length,
      averageMs: times.reduce((a, b) => a + b, 0) / times.length,
      ...Object.fromEntries([50, 90, 95, 99].map(p => [`p${p}Ms`, quantile(times, p / 100)])), maximumMs: Math.max(...times),
      maximumSuccessfulResponseMs: success.length ? Math.max(...success.map(r => r.durationMs)) : null,
      ...Object.fromEntries([5, 10, 15, 20, 30].map(s => [`completedWithin${s}s`, success.filter(r => r.durationMs <= s * 1000).length])),
      startSpreadMs: Math.max(...g.map(r => Date.parse(r.startedAt))) - Math.min(...g.map(r => Date.parse(r.startedAt))),
      postStartSpreadMs: posts.length ? Math.max(...posts.map(r => Date.parse(r.startedAt))) - Math.min(...posts.map(r => Date.parse(r.startedAt))) : null,
      statusGetCount: h.filter(r => r.operation === 'status').length,
      submitCount: posts.length,
      averagePostMs: posts.length ? posts.reduce((sum, r) => sum + r.durationMs, 0) / posts.length : null,
      throughputPerSecond: g.length * 1000 / Math.max(1, elapsed),
      backendAverageLockWait: '未量測', backendAverageLockHeld: '未量測', finalInventoryConsistency: '未驗證' };
  });
}

function csv(rows, fallback) {
  const keys = rows.length ? [...new Set(rows.flatMap(Object.keys))] : fallback;
  const cell = v => `"${String(v ?? '').replaceAll('"', '""')}"`;
  return [keys, ...rows.map(r => keys.map(k => r[k]))].map(r => r.map(cell).join(',')).join('\n') + '\n';
}

// Static SVGs contain only measured data (no placeholder simulation values).
function chart(rows, kind) {
  const w = 850, h = 350, left = 65, top = 30, bottom = 285, right = 800;
  const groups = [...Map.groupBy(rows, r => `${r.workflow}/${r.concurrency}`).entries()];
  const max = kind === 'success' ? 100 : Math.max(1, ...rows.map(r => r.durationMs / 1000));
  const y = v => bottom - v / max * (bottom - top);
  const marks = groups.flatMap(([label, g], i) => {
    const x = left + (i + 0.5) * (right - left) / Math.max(1, groups.length);
    const text = `<text x="${x}" y="310" text-anchor="middle" font-size="12">${label}</text>`;
    if (kind === 'distribution') return [text, ...g.map((r, j) => `<circle cx="${x + (j % 7 - 3) * 3}" cy="${y(r.durationMs / 1000)}" r="3" fill="${r.ok ? '#176b91' : '#c53737'}"/>`)];
    const vals = kind === 'success' ? [g.filter(r => r.ok && r.allocationStatus === 'allocated').length / g.length * 100] : [quantile(g.map(r => r.durationMs / 1000), .5), quantile(g.map(r => r.durationMs / 1000), .95)];
    return [text, ...vals.map((v, j) => `<circle cx="${x + j * 8}" cy="${y(v)}" r="5" fill="${j ? '#b45a00' : '#176b91'}"/>`)];
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="white"/><text x="65" y="18" font-size="14">${kind === 'success' ? 'Allocated success (%)' : kind === 'distribution' ? 'Runner latency distribution (seconds); red = unsuccessful' : 'P50 (blue) / P95 (orange), seconds'}</text><path d="M65 30V285H800" fill="none" stroke="black"/>${[0,.25,.5,.75,1].map(f => `<text x="55" y="${y(f * max) + 4}" text-anchor="end" font-size="12">${(f * max).toFixed(1)}</text>`).join('')}${marks.join('')}<text x="420" y="340" text-anchor="middle" font-size="12">workflow / concurrency</text></svg>`;
}

export async function save(state, folder) {
  await mkdir(folder, { recursive: true });
  const summary = summarize(state.runners, state.http);
  const finalAllocated = state.runners.filter(r => ['allocated', 'RECOVERED_ALLOCATED'].includes(r.finalState));
  const expectedPrizes = Object.fromEntries(PRIZES.map(id => [id, finalAllocated.filter(r => r.prizeId === id).length]));
  await writeFile(resolve(folder, 'http.csv'), csv(state.http, ['requestId', 'operation', 'durationMs', 'ok', 'errorCode']));
  await writeFile(resolve(folder, 'runners.csv'), csv(state.runners, ['requestId', 'sessionId', 'finalState']));
  await writeFile(resolve(folder, 'summary.csv'), csv(summary, ['workflow', 'concurrency', 'totalRequests']));
  const report = ['# Garmin Run Demo 並行測試報告', '', `批次：${state.batchId}；UTC：${state.createdAt}`, '',
    `API：${state.apiUrl}`, `階段：${state.phase}；停止原因：${state.stopped || '無（本階段完成）'}`, '',
    '## 實際量測', '', `Demo 預檢：${state.preflight || '尚未完成'}；跑者樣本 ${state.runners.length}；HTTP 請求 ${state.http.length}。`,
    'HTTP 詳細資料見 http.csv；含 status、submit、health、recovery；跑者總流程耗時見 runners.csv。',
    `彙整見 summary.csv：flow 為 GET＋POST 全程、post 為 POST 全程；每情境原定 ${state.rounds || 3} 輪，異常即停止，因此實際輪數以 CSV 為準。百分位採 nearest-rank。P99 樣本小，參考價值有限。`,
    '逾時樣本 durationMs 為客戶端截尾等待時間，不是後端實際完成時間；其 P95／P99／maximumMs 不代表真正完整延遲分布。maximumSuccessfulResponseMs 單獨列出已成功收到結果的最大耗時。', '',
    ...summary.map(s => `- ${s.workflow}/${s.concurrency} 人第 ${s.round} 輪：成功 ${s.successCount}/${s.totalRequests}；平均 ${s.averageMs.toFixed(0)} ms；P50/P95 ${s.p50Ms.toFixed(0)}/${s.p95Ms.toFixed(0)} ms；5/10/15/20/30 秒完成 ${[5,10,15,20,30].map(n=>s[`completedWithin${n}s`]).join('/')}；啟動離散 ${s.startSpreadMs} ms。`), '',
    ...(state.runners.length ? ['![P50/P95](latency.svg)', '![成功率](success.svg)', '![各跑者反應時間](distribution.svg)'] : ['無 POST 樣本，未生成空白圖或推估數據。']), '',
    '## 最終狀態與資料一致性', '',
    ...Object.entries(Object.groupBy(state.runners, r => r.finalState)).map(([k,v]) => `- ${k}：${v.length}`),
    `- 依成功/恢復回應推導的預期分配數（不是工作表實測扣減）：${JSON.stringify(expectedPrizes)}。`,
    ...(state.stopped === 'DEMO_STOCK_UNAVAILABLE' ? [`- 庫存不可用，已停止。尚餘測試最多需要 ${(state.plannedPosts ?? LEVELS[state.phase]?.reduce((a,b)=>a+b,0)*6) - finalAllocated.length} 件測試獎品；目前庫存明細不可讀，確切需補數量未確認。`] : []),
    '- DemoParticipants／DemoRequests／DemoAllocations／DemoInventoryLog／DemoPrizes 新增筆數、重複列、負庫存、部分寫入：未驗證（既有公開 API 無明細讀取權限）。',
    '- HTTP 成功或 recovery found 不代表已確認跨表交易完整。逾時後 found=false 只代表尚未觀察到完成，不可視為後端失敗。',
    '- 未對 Production 發送測試或調整庫存；正式服務是否受影響：沒有營運監測資料，未驗證。', '',
    '## 基於程式碼的推論（非後端實測）', '',
    '- Demo／Production／管理員庫存調整共用 Script Lock，tryLock 30 秒與前端 POST 30 秒沒有處理/網路緩衝。',
    '- 鎖內全表掃描與多次逐格 Sheets 寫入可能造成排隊；未取得 lockWaitMs 等資料，不能斷言主要瓶頸或線性關係。',
    '- 未執行的 30／40 人不能推論平台執行上限；GET+POST 的額外 GET 耗時可由 http.csv 分離比較。', '',
    '## 優化評估順序（待實測驗證）', '',
    '1. 在鎖內重用 Requests／Prizes 讀取結果與已知新增列位置，避免第二次 findRequest 全表掃描；不移除指紋與鎖內去重。',
    '2. 合併同列 setValues 與必要的資料讀取，減少 RPC；先確保錯誤復原與一致性，不貿然將庫存讀寫移出鎖。',
    '3. 前端提交逾時後用原 requestId/sessionId 退避查詢結果；目前主要於 pageshow/初始化復原。',
    '4. 取得鎖等待資料後再評估等待上限；不要直接延長前端 timeout。',
    '5. 量測前置 GET 的成本；若快取狀態，仍由 POST 重新驗證環境/資格/分配。管理員與抽獎對同一庫存須保留互斥。',
    '6. 只有證實平台配額是瓶頸才評估隔離部署或替代架構。', '',
    '## 尚未量測', '',
    '本 HTTP 報表不從端到端時間推估後端遙測；若另有匯入真實執行日誌，請參閱同批 performance.md 與 backend.csv。', ''].join('\n');
  await writeFile(resolve(folder, 'report.md'), report);
  if (state.runners.length) for (const [name, kind] of [['latency','latency'], ['success','success'], ['distribution','distribution']]) {
    await writeFile(resolve(folder, `${name}.svg`), chart(state.runners, kind));
  }
}

export async function recover(apiUrl, pairs, state) {
  const deadline = Date.now() + 90000;
  for (let attempt = 0; attempt < 3; attempt++) {
    const pending = pairs.filter(([r]) => r.posted && r.finalState === 'UNKNOWN');
    if (!pending.length || Date.now() >= deadline) break;
    await delay(Math.min(10000, Math.max(1, deadline - Date.now())));
    for (const [record, payload] of pending) {
      if (Date.now() >= deadline) break;
      const response = await http(actionUrl(apiUrl, 'getExistingAllocation', payload), { timeoutMs: Math.min(15000, Math.max(1, deadline - Date.now())) });
      state.http.push(publicRecord(response, recordMeta(record), 'recovery'));
      if (response.ok && response.body?.demoMode === true && response.body.found === true && validAllocation(response.body.allocation, payload)) {
        record.finalState = response.body.allocation.allocationStatus === 'allocated' ? 'RECOVERED_ALLOCATED' : 'RECOVERED_PAUSED';
        record.prizeId = response.body.allocation.prize?.prizeId || '';
        record.participantId = response.body.allocation.participantId;
        record.finalObservedAt = new Date().toISOString();
        record.finalObservedAfterMs = Date.parse(record.finalObservedAt) - Date.parse(record.startedAt);
      }
    }
  }
}

function recordMeta(r) { return Object.fromEntries(['requestId', 'batchId', 'workflow', 'concurrency', 'round'].map(k => [k, r[k]])); }

export async function main(argv = process.argv.slice(2)) {
  const allowed = new Set(['--execute', '--off-peak-confirmed', '--approve-high', '--plan']);
  for (const arg of argv) if (!allowed.has(arg) && !/^--(phase|api-url)=/.test(arg)) throw new Error(`UNKNOWN_OPTION: ${arg}`);
  const get = key => argv.find(a => a.startsWith(`--${key}=`))?.split('=').slice(1).join('=');
  const phase = get('phase') || 'baseline';
  if (!LEVELS[phase]) throw new Error('INVALID_PHASE');
  const apiUrl = assertDemo(get('api-url') || await configuredUrl(), await configuredUrl());
  const execute = argv.includes('--execute');
  if (execute && !argv.includes('--off-peak-confirmed')) throw new Error('OFF_PEAK_CONFIRMATION_REQUIRED');
  if (execute && phase === 'high' && !argv.includes('--approve-high')) throw new Error('HIGH_PHASE_REVIEW_REQUIRED');
  const count = LEVELS[phase].reduce((a,b) => a+b, 0) * 3 * 2;
  console.log(JSON.stringify({ apiUrl, phase, workflows: ['post','flow'], rounds: 3, concurrency: LEVELS[phase],
    plannedPosts: execute ? count : 0, plannedStatusGets: execute ? count / 2 + 1 + LEVELS[phase].length * 6 : 1,
    recoveryGets: '僅異常時，最多每個未確認請求 3 次、整輪觀察上限 90 秒', maxConcurrency: 40 }, null, 2));
  if (argv.includes('--plan')) return;
  const batchId = `load-${new Date().toISOString().replace(/[-:.]/g,'')}-${randomUUID().slice(0,8)}`;
  const folder = resolve(ROOT, 'test-results', batchId);
  const state = { batchId, apiUrl, phase, createdAt: new Date().toISOString(), http: [], runners: [], stopped: null, preflight: '' };
  try {
    const preflight = await http(actionUrl(apiUrl, 'getPublicCampaignStatus'));
    state.http.push(publicRecord(preflight, { batchId }, 'preflight'));
    state.preflight = validStatus(preflight) ? 'PASS: demoMode=true, quizVersion=2, submissionVersion=1' : `FAIL: ${preflight.errorCode || 'ENVIRONMENT_MISMATCH'}`;
    if (!validStatus(preflight)) { state.stopped = 'DEMO_PREFLIGHT_FAILED'; process.exitCode = 1; return; }
    if (!execute) return;
    for (const concurrency of LEVELS[phase]) for (const workflow of ['post', 'flow']) for (let round = 1; round <= 3; round++) {
      if (state.stopped) continue;
      const payloads = Array.from({ length: concurrency }, (_, i) => makePayload(batchId, i + round));
      // No per-user timer: launch all runners synchronously in one event loop turn.
      const records = await Promise.all(payloads.map(p => runner(apiUrl, p, { requestId: p.requestId, batchId, concurrency, round, workflow }, workflow, state.http)));
      state.runners.push(...records);
      state.stopped = stopReason(records);
      const participantIds = state.runners.filter(r => r.participantId).map(r => r.participantId);
      if (new Set(participantIds).size !== participantIds.length) state.stopped = 'DUPLICATE_PARTICIPANT_RESPONSE';
      const pairs = records.map((r,i) => [r, payloads[i]]);
      await save(state, folder); // checkpoint before recovery/cooldown, never silently lose a completed round
      await recover(apiUrl, pairs, state);
      if (records.some(r => r.finalState === 'UNKNOWN')) state.stopped ||= 'BACKEND_FINAL_STATE_UNKNOWN';
      console.log(`${workflow} ${concurrency} 人第 ${round} 輪：${records.filter(r=>r.ok).length}/${records.length}；${state.stopped || '完成'}`);
      if (!state.stopped) {
        const health = await http(actionUrl(apiUrl, 'getPublicCampaignStatus'));
        state.http.push(publicRecord(health, { batchId, concurrency, round, workflow }, 'health'));
        if (!validStatus(health) || health.durationMs >= 15000) state.stopped = 'HEALTH_CHECK_FAILED';
        await save(state, folder);
        if (!state.stopped) await delay(10000);
      }
    }
  } catch (e) { state.stopped ||= e.code || 'LOCAL_TEST_ERROR'; console.error(state.stopped); }
  finally { await save(state, folder); console.log(`結果：${folder}`); }
  if (state.stopped) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
