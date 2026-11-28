import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";

class Sheet {
  constructor(rows) { this.rows = structuredClone(rows); this.capacity = 1000; this.columns = 26; }
  getLastRow() { return this.rows.length; }
  getMaxRows() { return this.capacity; }
  insertRowsAfter(after, count) { assert.equal(after, this.capacity); this.capacity += count; }
  getLastColumn() { return Math.max(0, ...this.rows.map((row) => row.length)); }
  getDataRange() { return { getValues: () => structuredClone(this.rows) }; }
  getRange(row, col, height = 1, width = 1) {
    if (typeof row === 'string') { assert.equal(row, '1:1'); row=1;col=1;height=1;width=this.columns; }
    if (row + height - 1 > this.capacity) throw new Error('GRID_LIMIT');
    if (col + width - 1 > this.columns) throw new Error('COLUMN_LIMIT');
    return {
      createTextFinder: (value) => ({
        matchEntireCell() { return this; },
        matchCase() { return this; },
        useRegularExpression() { return this; },
        findAll: () => Array.from({ length: height }, (_, i) => row + i)
          .filter((r) => this.rows[r - 1]?.[col - 1] === value)
          .map((r) => ({ getRow: () => r }))
      }),
      getValues: () => Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => this.rows[row - 1 + r]?.[col - 1 + c] ?? "")),
      setValue: (value) => this.getRange(row, col).setValues([[value]]),
      setValues: (values) => { values.forEach((valuesRow, r) => { this.rows[row - 1 + r] ||= []; valuesRow.forEach((value, c) => { this.rows[row - 1 + r][col - 1 + c] = value; }); }); }
    };
  }
  appendRow(row) { this.rows.push([...row]); }
  deleteColumns(start, count) { this.rows.forEach((row) => row.splice(start - 1, count)); this.columns-=count; }
}
function environment({ diagnostics = false } = {}) {
  const sheets = new Map();
  const cache = new Map(), logs = [];
  const ss = { getSheetByName: (name) => sheets.get(name), insertSheet: (name) => { const sheet = new Sheet([]); sheets.set(name, sheet); return sheet; } };
  let uuid = 0;
  let held = false;
  let servingGet = false;
  const lock = { tryLock: () => { if (held) return false; held = true; return true; },
    waitLock: () => { assert.equal(held, false); held = true; }, releaseLock: () => { held = false; } };
  const spreadsheetApp = { getActive: () => ss, flush: () => {} };
  const context = vm.createContext({
    Date, JSON, SpreadsheetApp: spreadsheetApp, LockService: { getScriptLock: () => lock },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => String(diagnostics) }) },
    CacheService: { getScriptCache: () => ({ get: key => cache.get(key), put: (key, value) => {
      assert.equal(held, false); cache.set(key, value);
    } }) },
    console: { log: value => logs.push(JSON.parse(value)) },
    Utilities: { getUuid: () => `uuid-${++uuid}`, DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_algorithm, value) => [...createHash('sha256').update(value).digest()] },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: (text) => {
      if (!servingGet && JSON.parse(text).code !== 'LOCK_BUSY') assert.equal(held, false);
      return { text, setMimeType() { return this; } };
    } }
  });
  for (const name of ["Setup", "Inventory", "Validation", "Allocation", "Code"]) vm.runInContext(readFileSync(new URL(`../apps-script/${name}.gs`, import.meta.url), "utf8"), context);
  const get=context.doGet;
  context.doGet=(...args)=>{servingGet=true;try{return get(...args);}finally{servingGet=false;}};
  context.setupActivitySheets(); // In-memory workbook only; never connected to a remote Sheet.
  return {
    sheets,
    ss,
    spreadsheetApp,
    cache,
    logs,
    context,
    lockHeld: () => held,
    post: (data, mode = "apps-script-demo") => JSON.parse(context.doPost({
      parameter: mode ? { mode } : {},
      postData: { contents: JSON.stringify(data) }
    }).text)
  };
}

test("Demo timing is session-bound, outside lock, nonpersistent and optional", () => {
  const e = environment({ diagnostics: true }), request = data('pioneer', 'existing', 'load-timing');
  const response = e.post(request);
  for (const key of ['lockWaitMs','lockHeldMs','totalMs','requestLookupMs','sheetReadMs','sheetWriteMs','sheetFlushMs']) {
    assert.ok(Number.isFinite(response.diagnostics[key]) && response.diagnostics[key] >= 0, key);
  }
  assert.equal(e.logs.length, 1);
  const get = (sessionId = request.sessionId, mode = 'apps-script-demo') => JSON.parse(e.context.doGet({ parameter: {
    mode, action: 'getDemoRequestTiming', requestId: request.requestId, sessionId
  } }).text);
  assert.equal(get().diagnostics.attemptId, response.diagnostics.attemptId);
  assert.equal(get('different-session').found, false);
  assert.equal(get(request.sessionId, 'production').code, 'DIAGNOSTICS_UNAVAILABLE');
  const persisted = JSON.parse(e.sheets.get('DemoRequests').rows[1][4]);
  assert.equal(persisted.diagnostics, undefined);
  for (const key of ['answers', 'sessionId', 'redemptionCode']) assert.equal(key in response.diagnostics, false);
  e.cache.clear(); assert.equal(get().found, false);
  e.context.CacheService.getScriptCache = () => { throw new Error('CACHE_UNAVAILABLE'); };
  e.context.console.log = () => { throw new Error('LOG_UNAVAILABLE'); };
  assert.equal(e.post(data('rest', 'considering', 'load-no-cache')).ok, true);
  assert.equal(environment().post(request).diagnostics, undefined);
});

test("request lookup does not read historical result JSON and recovery takes no ScriptLock", () => {
  const e = environment(), request = data(); e.post(request);
  e.sheets.get('DemoRequests').getDataRange = () => { throw new Error('FULL_SCAN_FORBIDDEN'); };
  assert.equal(e.post(request).idempotentReplay, true);
  e.context.LockService.getScriptLock = () => { throw new Error('LOCK_FORBIDDEN'); };
  const recovery = JSON.parse(e.context.doGet({ parameter: {
    mode: 'apps-script-demo', action: 'getExistingAllocation', requestId: request.requestId, sessionId: request.sessionId
  } }).text);
  assert.equal(recovery.found, true);
});
function data(style = "rest", commitment = "considering", requestId = "test-request") {
  const existing = style === "pioneer";
  return {
    submissionVersion: 1, quizVersion: 2, requestId, sessionId: "test-session",
    answers: { q1: "q1_experience", q2: "q2_experience", q3: "q3_experience", q4: `q4_${style}`, q5: "q5_experience" },
    runnerType: "experience", hydrationStyle: style, q4Answer: `q4_${style}`, existingSelfHydration: existing,
    hydrationCommitment: existing ? "existing" : commitment,
    sustainabilityRewardEligible: existing || commitment === "joined", premiumPrizeEligible: existing
  };
}

test("WebP prize URLs are current for new responses, old request replays and GET recovery", () => {
  const { sheets, context, post } = environment();
  // Simulate an existing workbook whose image column still points at PNG files.
  sheets.get("DemoPrizes").rows.slice(1).forEach((row) => { row[8] = row[8].replace(/\.webp$/, ".png"); });
  const request = data("pioneer");
  const response = post(request);
  assert.equal(response.prize.imagePath, "./assets/prizes/Garmin簍空購物袋.webp");
  const stored = sheets.get("DemoRequests").rows[1];
  const oldResult = JSON.parse(stored[4]);
  oldResult.prize.imagePath = oldResult.prize.imagePath.replace(/\.webp$/, ".png");
  stored[4] = JSON.stringify(oldResult);
  const before = JSON.stringify([...sheets].map(([name, sheet]) => [name, sheet.rows]));
  assert.equal(post(request).prize.imagePath, response.prize.imagePath);
  const recovery = JSON.parse(context.doGet({ parameter: {
    action: "getExistingAllocation", requestId: request.requestId, sessionId: request.sessionId,
    mode: "apps-script-demo"
  } }).text);
  assert.equal(recovery.allocation.prize.imagePath, response.prize.imagePath);
  assert.equal(JSON.stringify([...sheets].map(([name, sheet]) => [name, sheet.rows])), before);
});

test("Append-only migration preserves existing rows and all stock; repeatable, schema conflicts stop", () => {
  const { sheets, context } = environment();
  const demo = sheets.get("DemoParticipants");
  const requests = sheets.get("DemoRequests");
  demo.rows = [demo.rows[0].slice(0, 18), Array(18).fill("legacy-value")];
  requests.rows = [requests.rows[0].slice(0, 7), Array(7).fill("legacy-request")];
  const oldData = [structuredClone(demo.rows[1]), structuredClone(requests.rows[1])];
  const stock = JSON.stringify([sheets.get("Prizes").rows, sheets.get("DemoPrizes").rows]);
  context.migrateStagingAnonymousSchema(); context.migrateStagingAnonymousSchema();
  assert.deepEqual(demo.rows[0].map(context.internalHeader), [
    "participantId","requestId","createdAt","runnerType","existingSelfHydration","hydrationCommitment",
    "sustainabilityRewardEligible","premiumPrizeEligible","raffleOptIn","name","email","privacyNoticeVersion",
    "privacyAcknowledgedAt","prizeId","allocationStatus","allocationTime","redemptionCode","redemptionStatus",
    "quizVersion","hydrationStyle","q4Answer","submissionVersion","q1Answer","q2Answer","q3Answer","q5Answer"
  ]);
  assert.deepEqual(demo.rows[1], oldData[0]);
  assert.deepEqual(requests.rows[1], oldData[1]);
  assert.deepEqual(requests.rows[0].slice(7).map(context.internalHeader), ["submissionVersion", "submissionFingerprint"]);
  assert.equal(JSON.stringify([sheets.get("Prizes").rows, sheets.get("DemoPrizes").rows]), stock);
  demo.rows[0][18] = "unknown";
  assert.throws(() => context.migrateStagingAnonymousSchema(), /UNKNOWN_SCHEMA/);
});

test("Anonymous submit records complete raw answers, existing priority and exact idempotent replay", () => {
  const { sheets, post, context } = environment();
  const productionStock = JSON.stringify(sheets.get("Prizes").rows);
  const request = data("pioneer");
  const first = post(request);
  assert.equal(first.ok, true);
  assert.equal(first.prize.prizeId, "shopping_bag");
  const stockAfter = JSON.stringify(sheets.get("DemoPrizes").rows);
  assert.equal(post(request).idempotentReplay, true);
  assert.equal(JSON.stringify(sheets.get("DemoPrizes").rows), stockAfter);
  assert.equal(sheets.get("DemoAllocations").rows.length, 2);
  const participant = sheets.get("DemoParticipants").rows[1];
  assert.equal(participant[8], "否");
  assert.deepEqual(participant.slice(9, 13), ["", "", "", ""]);
  assert.deepEqual(participant.slice(18), [2, "永續先鋒隊", "優雅地拿出自己的軟水杯／軟水壺裝水", 1, "跑者大拜拜之一，必須搶！", "蛤? 訓練是什麼?", "儀式感要有，裝備排好來張大合照！", "準備好！我要漂亮進站"]);
  assert.equal(sheets.get("DemoRequests").rows[1][7], 1);
  assert.ok(sheets.get("DemoRequests").rows[1][8].includes("q4_pioneer"));
  assert.equal(JSON.stringify(sheets.get("Prizes").rows), productionStock);
  const recovered = JSON.parse(context.doGet({ parameter: { action: "getExistingAllocation", requestId: request.requestId, sessionId: request.sessionId, mode: "apps-script-demo" } }).text);
  assert.equal(recovered.found, true);
  assert.equal(recovered.allocation.prize.prizeId, "shopping_bag");
  assert.equal(Object.hasOwn(recovered.allocation, "name"), false);
});

test("Paused allocation is saved and recoverable without claiming a prize", () => {
  const { sheets, post, context } = environment();
  for (const row of sheets.get("DemoPrizes").rows.slice(1)) row[5] = 0;
  const request = data("rest", "joined", "paused-request");
  const paused = post(request);
  assert.equal(paused.ok, true);
  assert.equal(paused.allocationStatus, "paused");
  assert.equal(paused.prize, null);
  assert.equal(sheets.get("DemoAllocations").rows.length, 1);
  assert.equal(sheets.get("DemoParticipants").rows[1][14], "暫停分配");
  const recovered = JSON.parse(context.doGet({ parameter: { action: "getExistingAllocation", requestId: request.requestId, sessionId: request.sessionId, mode: "apps-script-demo" } }).text);
  assert.equal(recovered.found, true);
  assert.equal(recovered.allocation.allocationStatus, "paused");
  assert.equal(post(request).idempotentReplay, true);
  assert.equal(sheets.get("DemoParticipants").rows.length, 2);
});

test("Server rejects personal fields, mismatches, repeated IDs with different payload and environment override before stock changes", () => {
  const { sheets, post } = environment();
  const before = JSON.stringify(sheets.get("DemoPrizes").rows);
  const beforeTotal = sheets.get("DemoPrizes").rows.slice(1).reduce((sum, row) => sum + row[5], 0);
  assert.equal(post({ ...data(), name: "must not persist" }).code, "PERSONAL_DATA_NOT_ALLOWED");
  assert.equal(post({ ...data(), email: "must-not-persist@example.invalid" }).code, "PERSONAL_DATA_NOT_ALLOWED");
  assert.equal(post({ ...data(), demoMode: false }).code, "ENVIRONMENT_OVERRIDE_NOT_ALLOWED");
  assert.equal(post({ ...data(), premiumPrizeEligible: true }).code, "ELIGIBILITY_MISMATCH");
  const initial = data("rest", "joined", "same-id");
  assert.equal(post(initial).ok, true);
  assert.equal(post({ ...initial, hydrationCommitment: "considering", sustainabilityRewardEligible: false }).code, "REQUEST_ID_CONFLICT");
  const afterTotal = sheets.get("DemoPrizes").rows.slice(1).reduce((sum, row) => sum + row[5], 0);
  assert.equal(afterTotal, beforeTotal - 1);
  assert.notEqual(before, JSON.stringify(sheets.get("DemoPrizes").rows));
});

test("One Web App routes Demo and Production by mode; Production is the default", () => {
  const { sheets, post, context } = environment();
  const demoStatus = JSON.parse(context.doGet({ parameter: { action: "getPublicCampaignStatus", mode: "apps-script-demo" } }).text);
  const productionStatus = JSON.parse(context.doGet({ parameter: { action: "getPublicCampaignStatus" } }).text);
  assert.equal(demoStatus.demoMode, true);
  assert.equal(productionStatus.demoMode, false);

  const demoPrizeBefore = JSON.stringify(sheets.get("DemoPrizes").rows);
  const productionResult = post(data("rest", "considering", "production-test"), "production");
  assert.equal(productionResult.ok, true);
  assert.equal(productionResult.demoMode, false);
  assert.equal(JSON.stringify(sheets.get("DemoPrizes").rows), demoPrizeBefore);
  assert.equal(sheets.get("Participants").rows.length, 2);
  assert.equal(sheets.get("DemoParticipants").rows.length, 1);

  assert.equal(post(data("rest", "considering", "invalid-mode"), "mock").code, "INVALID_API_MODE");
});

test("Bag fallback and joined participants remain in the general weighted pool", () => {
  const { sheets, post } = environment();
  const rows = sheets.get("DemoPrizes").rows;
  rows.find((row) => row[0] === "shopping_bag")[5] = 0;
  const fallback = post(data("pioneer"));
  assert.equal(fallback.allocationMethod, "premium_fallback");
  assert.notEqual(fallback.prize.prizeId, "shopping_bag");
  rows.find((row) => row[0] === "shopping_bag")[5] = 120;
  const joined = post(data("precision", "joined", "joined-request"));
  assert.equal(joined.allocationMethod, "general_weighted");
  assert.notEqual(joined.prize.prizeId, "shopping_bag");
});


test("Chinese localization preserves technical records and stock and accepts legacy headers", () => {
  const { sheets, context, post } = environment();
  const participants = sheets.get("DemoParticipants");
  participants.rows[0] = participants.rows[0].map(context.internalHeader);
  assert.equal(post(data()).ok, true);
  participants.rows[1][3] = "performance";
  participants.rows[1][4] = false;
  const unchanged = JSON.stringify([...sheets].filter(([name]) => !["Participants", "DemoParticipants"].includes(name)).map(([name, sheet]) => [name, sheet.rows.slice(1)]));
  context.localizeActivitySheets();
  context.localizeActivitySheets();
  assert.equal(participants.rows[0][0], "參與者代碼");
  assert.equal(participants.rows[0][3], "跑者風格");
  assert.equal(participants.rows[1][3], "配速計算機");
  assert.equal(participants.rows[1][4], "否");
  assert.equal(JSON.stringify([...sheets].filter(([name]) => !["Participants", "DemoParticipants"].includes(name)).map(([name, sheet]) => [name, sheet.rows.slice(1)])), unchanged);
  assert.equal(post(data()).idempotentReplay, true);
  assert.equal(post(data("rest", "considering", "after-localization")).ok, true);
});


test("Production summary stores 13 ordered Chinese columns, prize names, replay and recovery", () => {
  const { sheets, context, post } = environment();
  const demoBefore = JSON.stringify([...sheets].filter(([name]) => name.startsWith("Demo")).map(([name, sheet]) => [name, sheet.rows]));
  const request = data("pioneer", "existing", "summary-production");
  const result = post(request, "production");
  assert.equal(result.ok, true);
  const rows = sheets.get("Participants").rows;
  assert.deepEqual(rows[0], ["參與者代號", "建立時間", "跑者風格", "自備補水裝備", "永續獎勵資格", "優先獎品資格", "補水風格", "第1題答案", "第2題答案", "第3題答案", "第4題答案", "第5題答案", "獎品中文名稱"]);
  assert.equal(rows[1].length, 13);
  assert.equal(rows[1][0], result.participantId);
  assert.deepEqual(rows[1].slice(2, 7), ["賽事收藏家", "是", "是", "是", "永續先鋒隊"]);
  for (let q = 1; q <= 5; q++) assert.equal(rows[1][q + 6], context.CHINESE_PARTICIPANT_VALUES[request.answers[`q${q}`]]);
  assert.equal(rows[1][12], result.prize.nameZh);
  const stock = JSON.stringify(sheets.get("Prizes").rows);
  assert.equal(post(request, "production").idempotentReplay, true);
  assert.equal(JSON.stringify(sheets.get("Prizes").rows), stock);
  assert.equal(rows.length, 2);
  const recovery = JSON.parse(context.doGet({ parameter: { action: "getExistingAllocation", requestId: request.requestId, sessionId: request.sessionId } }).text);
  assert.equal(recovery.allocation.prize.nameZh, rows[1][12]);
  assert.equal(JSON.stringify([...sheets].filter(([name]) => name.startsWith("Demo")).map(([name, sheet]) => [name, sheet.rows])), demoBefore);
  context.migrateProductionAnonymousSchema();
  assert.equal(rows[0].length, 13);
});

test("Production summary migration drops excluded data, preserves answers and other sheets, repeatable", () => {
  const { sheets, context, post } = environment();
  const sheet = sheets.get("Participants");
  sheet.rows = [Array.from(context.LEGACY_PARTICIPANT_HEADERS).concat(Array.from(context.V2_PARTICIPANT_HEADERS), Array.from(context.ANONYMOUS_PARTICIPANT_HEADERS))];
  const request = data("pioneer", "existing", "legacy-production");
  assert.equal(post(request, "production").ok, true);
  sheet.rows[1][9] = "synthetic-name";
  sheet.rows[1][10] = "synthetic@example.invalid";
  const expectedAnswers = [22, 23, 24, 20, 25].map((i) => sheet.rows[1][i]);
  const otherSheets = () => JSON.stringify([...sheets].filter(([name]) => name !== "Participants").map(([name, sheet]) => [name, sheet.rows]));
  const before = otherSheets();
  context.migrateProductionParticipantSummary();
  assert.equal(sheet.getLastColumn(), 13);
  assert.deepEqual(sheet.rows[1].slice(7, 12), expectedAnswers);
  assert.equal(sheet.rows[1][12], "Garmin 鏤空購物袋");
  assert.equal(JSON.stringify(sheet.rows).includes("synthetic"), false);
  const migrated = JSON.stringify(sheet.rows);
  context.migrateProductionParticipantSummary();
  assert.equal(JSON.stringify(sheet.rows), migrated);
  assert.equal(otherSheets(), before);
  assert.equal(post(request, "production").idempotentReplay, true);
  assert.equal(post(data("rest", "considering", "new-production"), "production").ok, true);
  assert.equal(sheet.rows[2].length, 13);
});

test("Production paused summary has no prize name or inventory changes", () => {
  const { sheets, post } = environment();
  sheets.get("Settings").rows.find((row) => row[0] === "allocationEnabled")[1] = "false";
  const before = JSON.stringify(sheets.get("Prizes").rows);
  const request = data("rest", "considering", "summary-paused");
  assert.equal(post(request, "production").allocationStatus, "paused");
  const row = sheets.get("Participants").rows[1];
  assert.equal(row.length, 13);
  assert.equal(row[12], "");
  assert.deepEqual(row.slice(3, 6), ["否", "否", "否"]);
  assert.equal(post(request, "production").idempotentReplay, true);
  assert.equal(JSON.stringify(sheets.get("Prizes").rows), before);
});

test("Production summary migration rejects unknown schemas and unresolved prizes before writes", () => {
  const { sheets, context } = environment();
  const sheet = sheets.get("Participants");
  sheet.rows = [["unknown"], ["unchanged"]];
  const before = JSON.stringify(sheet.rows);
  assert.throws(() => context.migrateProductionParticipantSummary(), /UNKNOWN_SCHEMA/);
  assert.equal(JSON.stringify(sheet.rows), before);
  sheet.rows = [Array.from(context.LEGACY_PARTICIPANT_HEADERS), Array(18).fill("")];
  sheet.rows[1][13] = "unknown-prize";
  const unresolved = JSON.stringify(sheet.rows);
  assert.throws(() => context.migrateProductionParticipantSummary(), /PRIZE_NOT_FOUND/);
  assert.equal(JSON.stringify(sheet.rows), unresolved);
  sheet.rows[1][13] = "";
  context.migrateProductionParticipantSummary();
  assert.equal(sheet.rows[1][12], "");
  assert.deepEqual(sheet.rows[1].slice(7, 12), ["", "", "", "", ""]);
});

test("A failed dependent flush keeps the request pending and prevents a second stock decrement", () => {
  for (const mode of ['apps-script-demo','production']) for (const soldOut of [false, true]) {
    const { sheets, context, spreadsheetApp, post } = environment();
    const names=context.getModeSheetNames(mode==='apps-script-demo');
    if (soldOut) sheets.get(names.prizes).rows.slice(1).forEach((row) => { row[5] = 0; });
    const request = data("pioneer");
    const stockBefore=JSON.stringify(sheets.get(names.prizes).rows);
    let flushCount=0;
    const recover = () => JSON.parse(context.doGet({ parameter: {
      action: "getExistingAllocation", mode: mode,
      requestId: request.requestId, sessionId: request.sessionId
    } }).text);
    spreadsheetApp.flush = () => {
      flushCount++;
      assert.equal(sheets.get(names.requests).rows[1][3], "processing");
      assert.equal(recover().found, false);
      if (flushCount === 1) {
        assert.equal(JSON.stringify(sheets.get(names.prizes).rows),stockBefore);
        assert.equal(sheets.get(names.participants).rows.length,1);
        return;
      }
      assert.equal(sheets.get(names.participants).rows.length,2);
      throw new Error("simulated write failure");
    };
    assert.equal(post(request,mode).code, "INTERNAL_ERROR");assert.equal(flushCount,2);
    assert.equal(sheets.get(names.requests).rows[1][3], "processing");
    const beforeRetry = JSON.stringify(sheets.get(names.prizes).rows);
    assert.equal(post(request,mode).code, "REQUEST_PENDING_RETRY");
    assert.equal(JSON.stringify(sheets.get(names.prizes).rows), beforeRetry);
    assert.equal(recover().found, false);
  }
});

test("processing flush failure stops before stock/participant writes in both modes", () => {
  for (const mode of ['apps-script-demo','production']) {
    const e=environment(),names=e.context.getModeSheetNames(mode==='apps-script-demo');
    const stock=JSON.stringify(e.sheets.get(names.prizes).rows);
    let calls=0;e.spreadsheetApp.flush=()=>{calls++;throw new Error('PROCESSING_COMMIT_FAILURE');};
    const request=data('pioneer');assert.equal(e.post(request,mode).code,'INTERNAL_ERROR');
    assert.equal(calls,1);assert.equal(e.sheets.get(names.requests).rows[1][3],'processing');
    assert.equal(JSON.stringify(e.sheets.get(names.prizes).rows),stock);
    for(const table of [names.participants,names.allocations,names.inventoryLog])assert.equal(e.sheets.get(table).rows.length,1);
    assert.equal(e.post(request,mode).code,'REQUEST_PENDING_RETRY');assert.equal(calls,1);
  }
});

test("full-header validation detects missing/reordered/extra headers without width queries", () => {
  for (const mode of ['apps-script-demo','production']) for (const table of ['participants','requests']) for (const defect of ['missing','reordered','extra']) {
    const e=environment(),names=e.context.getModeSheetNames(mode==='apps-script-demo'),sheet=e.sheets.get(names[table]);
    const stock=JSON.stringify(e.sheets.get(names.prizes).rows);
    if(defect==='missing')sheet.rows[0].splice(0,1);
    if(defect==='reordered')[sheet.rows[0][0],sheet.rows[0][1]]=[sheet.rows[0][1],sheet.rows[0][0]];
    if(defect==='extra'){sheet.columns=30;sheet.rows[0][29]='unexpected-extra-header';}
    sheet.getLastColumn=()=>{throw new Error('WIDTH_READ_FORBIDDEN');};
    assert.equal(e.post(data('pioneer'),mode).code,'ANONYMOUS_SCHEMA_MIGRATION_REQUIRED');
    assert.equal(JSON.stringify(e.sheets.get(names.prizes).rows),stock);
    assert.equal(e.sheets.get(names.requests).rows.length,1);
  }
});

test("Demo26 and Production13/26 reduce metadata reads while preserving writes and all commit barriers", () => {
  for (const layout of ['demo26', 'production13', 'production26']) for (const paused of [false, true]) {
    const e = environment(), demo = layout === 'demo26', mode = demo ? 'apps-script-demo' : 'production';
    const names = e.context.getModeSheetNames(demo);
    if (layout === 'production26') e.sheets.get(names.participants).rows[0] = Array.from(e.context.LEGACY_PARTICIPANT_HEADERS)
      .concat(Array.from(e.context.V2_PARTICIPANT_HEADERS), Array.from(e.context.ANONYMOUS_PARTICIPANT_HEADERS));
    if (paused) e.sheets.get(names.prizes).rows.slice(1).forEach(r => { r[5] = 0; });
    assert.equal(e.post(data('pioneer', 'existing', 'historical'), mode).ok, true);
    const requests = e.sheets.get(names.requests), history = JSON.stringify(requests.rows);
    const otherMode = () => JSON.stringify([...e.sheets].filter(([n]) => demo ? !n.startsWith('Demo') : n.startsWith('Demo')).map(([n,s]) => [n,s.rows]));
    const otherBefore = otherMode();
    let lastReads = 0, capacityReads = 0, writes = 0, valueReads = 0, searches = 0;
    const flushStates = [];
    const originalLastRow = requests.getLastRow.bind(requests);
    requests.getLastColumn = () => { throw new Error('UNEXPECTED_WIDTH_READ'); };
    e.sheets.get(names.participants).getLastColumn = () => { throw new Error('UNEXPECTED_WIDTH_READ'); };
    requests.getLastRow = () => { assert.equal(e.lockHeld(), true); lastReads++; return originalLastRow(); };
    requests.getMaxRows = () => { capacityReads++; throw new Error('UNEXPECTED_CAPACITY_READ'); };
    for (const name of Object.values(names).concat('Settings')) {
      const sheet = e.sheets.get(name), range = sheet.getRange.bind(sheet), append = sheet.appendRow.bind(sheet);
      const dataRange=sheet.getDataRange.bind(sheet);
      sheet.getDataRange=()=>{
        const result=dataRange(),read=result.getValues;
        result.getValues=()=>{valueReads++;return read();};return result;
      };
      sheet.getRange = (...args) => {
        const result = range(...args), set = result.setValues, read = result.getValues, search = result.createTextFinder;
        result.getValues = () => { valueReads++; return read(); };
        result.createTextFinder = query => {
          const finder=search(query),find=finder.findAll;
          finder.findAll=()=>{searches++;return find();};return finder;
        };
        result.setValues = values => { assert.equal(e.lockHeld(), true); writes++; return set(values); };
        return result;
      };
      sheet.appendRow = row => { assert.equal(e.lockHeld(), true); assert.notEqual(name, names.requests); writes++; return append(row); };
    }
    e.spreadsheetApp.flush = () => {
      assert.equal(e.lockHeld(), true);
      assert.equal(e.sheets.get(names.participants).rows.length, flushStates.length === 0 ? 2 : 3);
      flushStates.push(requests.rows[2][3]);
    };
    const payload = data('pioneer', 'existing', 'new-request'), result = e.post(payload, mode);
    assert.equal(result.allocationStatus, paused ? 'paused' : 'allocated', layout);
    assert.equal(lastReads, 1, layout); assert.equal(capacityReads, 0);
    assert.equal(writes, paused ? 3 : 6);
    assert.deepEqual(flushStates, ['processing', 'processing', paused ? 'paused' : 'allocated']);
    assert.equal(valueReads,demo?3:4);assert.equal(searches,1);
    assert.equal(valueReads+searches+lastReads+writes+flushStates.length,demo?(paused?11:14):(paused?12:15));
    assert.equal(JSON.stringify(requests.rows.slice(0, 2)), history);
    assert.equal(requests.rows[2][0], payload.requestId);
    const snapshot = JSON.stringify([...e.sheets].map(([n,s]) => [n,s.rows]));
    assert.equal(e.post(payload, mode).idempotentReplay, true);
    assert.equal(JSON.stringify([...e.sheets].map(([n,s]) => [n,s.rows])), snapshot);
    assert.equal(otherMode(), otherBefore);
    requests.getLastRow = originalLastRow;
    const recovery = JSON.parse(e.context.doGet({parameter:{mode,action:'getExistingAllocation',requestId:payload.requestId,sessionId:payload.sessionId}}).text);
    assert.equal(recovery.found, true); assert.equal(recovery.allocation.participantId, result.participantId);
  }
});

test("Requests grid exhaustion grows safely in both environments without losing historical rows", () => {
  for (const mode of ['apps-script-demo','production']) for (const paused of [false,true]) {
    const e = environment(), names = e.context.getModeSheetNames(mode === 'apps-script-demo');
    if (paused) e.sheets.get(names.prizes).rows.slice(1).forEach(r => { r[5] = 0; });
    assert.equal(e.post(data('pioneer','existing','historical'),mode).ok,true);
    const sheet=e.sheets.get(names.requests), before=JSON.stringify(sheet.rows);
    sheet.capacity=sheet.rows.length;
    let capacityReads=0,growths=0;
    const max=sheet.getMaxRows.bind(sheet),grow=sheet.insertRowsAfter.bind(sheet);
    sheet.getMaxRows=()=>{assert.equal(e.lockHeld(),true);capacityReads++;return max();};
    sheet.insertRowsAfter=(...args)=>{assert.equal(e.lockHeld(),true);growths++;return grow(...args);};
    const request=data('pioneer','existing','needs-room');
    assert.equal(e.post(request,mode).allocationStatus,paused?'paused':'allocated');
    assert.equal(capacityReads,1);assert.equal(growths,1);assert.equal(sheet.rows.length,3);
    assert.equal(JSON.stringify(sheet.rows.slice(0,2)),before);
    assert.equal(sheet.rows[2][0],request.requestId);
    assert.equal(e.post(request,mode).idempotentReplay,true);assert.equal(growths,1);
  }
});

test("ordinary or ambiguous processing writes are never blindly retried and cannot consume stock", () => {
  for (const mode of ['apps-script-demo','production']) for (const committed of [false,true]) {
    const e=environment(),names=e.context.getModeSheetNames(mode==='apps-script-demo'),sheet=e.sheets.get(names.requests);
    const original=sheet.getRange.bind(sheet),stock=JSON.stringify(e.sheets.get(names.prizes).rows);
    let attempts=0;
    sheet.insertRowsAfter=()=>{throw new Error('UNEXPECTED_GROWTH');};
    sheet.getRange=(row,col,height,width)=>{
      const range=original(row,col,height,width),set=range.setValues;
      if(row===2&&col===1&&width===9)range.setValues=values=>{
        attempts++;if(committed)set(values);throw new Error('SIMULATED_WRITE_FAILURE');
      };
      return range;
    };
    const request=data('pioneer','existing','failed-write');
    assert.equal(e.post(request,mode).code,'INTERNAL_ERROR');assert.equal(attempts,1);
    assert.equal(JSON.stringify(e.sheets.get(names.prizes).rows),stock);
    assert.equal(e.sheets.get(names.allocations).rows.length,1);
    sheet.getRange=original;
    const retry=e.post(request,mode);
    assert.equal(retry.code,committed?'REQUEST_PENDING_RETRY':undefined);
    assert.equal(retry.ok,!committed);
    if(committed)assert.equal(JSON.stringify(e.sheets.get(names.prizes).rows),stock);
  }
});
