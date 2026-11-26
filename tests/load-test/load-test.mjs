#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxIyhmulILe7wMpy0bNbP7ATv2YDEdzHkaCoacGnmR_nwsoT1PJmWp1lYRZ689uP9hEZg/exec?mode=apps-script-demo";
const DEMO_MODE = "apps-script-demo";
const LEVELS = [1, 2, 5, 10];
const MAX_REQUESTS_PER_STAGE = 10;
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_ACCEPTABLE_LATENCY_MS = 30_000;
const REPORT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "reports");

function parseArgs(argv) {
  const args = new Set(argv);
  const apiArg = argv.find((arg) => arg.startsWith("--api-url="));
  return {
    execute: args.has("--execute"),
    confirm: args.has("--confirm-demo"),
    skipDuplicate: args.has("--skip-duplicate"),
    apiUrl: apiArg ? apiArg.slice("--api-url=".length) : SCRIPT_URL
  };
}

function demoApiUrl(rawUrl, action) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error("API URL 必須使用 HTTPS");
  if (url.searchParams.get("mode") !== DEMO_MODE) {
    throw new Error("安全停止：API URL 必須明確帶有 mode=apps-script-demo，拒絕 Production URL");
  }
  if (action) url.searchParams.set("action", action);
  return url;
}

function makePayload(index, duplicateOf = null) {
  const type = ["experience", "lifestyle", "performance"][index % 3];
  const style = index % 4 === 0 ? "pioneer" : "rest";
  const answers = { q1: `q1_${type}`, q2: `q2_${type}`, q3: `q3_${type}`, q4: `q4_${style}`, q5: `q5_${type}` };
  const existing = style === "pioneer";
  return {
    submissionVersion: 1,
    quizVersion: 2,
    requestId: duplicateOf?.requestId || `load-${Date.now()}-${randomUUID()}`,
    sessionId: duplicateOf?.sessionId || `session-${randomUUID()}`,
    answers,
    runnerType: type,
    hydrationStyle: style,
    q4Answer: answers.q4,
    existingSelfHydration: existing,
    hydrationCommitment: existing ? "existing" : "joined",
    sustainabilityRewardEligible: true,
    premiumPrizeEligible: existing
  };
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}

function summarize(records, elapsedMs) {
  const durations = records.map((record) => record.durationMs).filter(Number.isFinite);
  const successes = records.filter((record) => record.success).length;
  const allocations = records.filter((record) => record.success && record.allocationStatus === "allocated" && !record.idempotentReplay);
  return {
    requests: records.length,
    successes,
    failures: records.length - successes,
    successRate: records.length ? successes / records.length : 0,
    averageMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
    p95Ms: percentile(durations, 0.95),
    maxMs: durations.length ? Math.max(...durations) : null,
    throughput: elapsedMs > 0 ? records.length / (elapsedMs / 1000) : 0,
    nonReplayAllocations: allocations.length,
    prizes: allocations.reduce((counts, record) => {
      counts[record.prizeId] = (counts[record.prizeId] || 0) + 1;
      return counts;
    }, {})
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: "follow", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  return { response, body, finalUrl: response.url, redirected: response.redirected };
}

async function preflight(apiUrl) {
  const url = demoApiUrl(apiUrl, "getPublicCampaignStatus");
  const result = await fetchJson(url);
  if (!result.response.ok || !result.body?.ok || result.body.demoMode !== true ||
      result.body.quizVersion !== 2 || result.body.submissionVersion !== 1) {
    throw new Error(`Demo preflight 失敗：HTTP ${result.response.status} ${JSON.stringify(result.body)}`);
  }
  return result;
}

async function submit(apiUrl, payload) {
  const started = performance.now();
  const record = { requestId: payload.requestId, sessionId: payload.sessionId, startedAt: new Date().toISOString() };
  try {
    const result = await fetchJson(demoApiUrl(apiUrl), {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(payload)
    });
    const body = result.body || {};
    Object.assign(record, {
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      httpStatus: result.response.status,
      redirected: result.redirected,
      finalUrl: result.finalUrl,
      success: result.response.ok && body.ok === true,
      code: body.code || (result.response.ok ? "OK" : `HTTP_${result.response.status}`),
      allocationStatus: body.allocationStatus || null,
      prizeId: body.prize?.prizeId || null,
      idempotentReplay: body.idempotentReplay === true,
      responseRequestId: body.requestId || null,
      demoMode: body.demoMode
    });
  } catch (error) {
    Object.assign(record, {
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      success: false,
      code: error.name === "TimeoutError" ? "REQUEST_TIMEOUT" : (error.message || "REQUEST_FAILED")
    });
  }
  return record;
}

async function runStage(apiUrl, concurrency, stageNumber) {
  const count = Math.min(concurrency, MAX_REQUESTS_PER_STAGE);
  const payloads = Array.from({ length: count }, (_, index) => makePayload(stageNumber * 100 + index));
  const started = performance.now();
  const records = await Promise.all(payloads.map((payload) => submit(apiUrl, payload)));
  const elapsedMs = performance.now() - started;
  return { concurrency, records, elapsedMs, summary: summarize(records, elapsedMs) };
}

function stopReason(stage) {
  return stage.records.find((record) => ["LOCK_BUSY", "REQUEST_TIMEOUT", "QUOTA_EXCEEDED", "SERVICE_UNAVAILABLE", "HTTP_429", "HTTP_503"].includes(record.code) ||
    record.durationMs >= MAX_ACCEPTABLE_LATENCY_MS)?.code ||
    (stage.records.some((record) => record.demoMode !== true) ? "NON_DEMO_RESPONSE" : null);
}

function md(value) { return String(value ?? "—").replaceAll("|", "\\|"); }

function renderReport({ apiUrl, preflightResult, stages, duplicate, stopped }) {
  const lines = [
    "# Garmin Run Demo API 並行測試報告",
    "",
    `- 執行時間：${new Date().toISOString()}`,
    `- API URL：\`${apiUrl}\``,
    `- Demo 識別：status GET 回覆 \`demoMode: true\`；所有 POST 回覆亦須為 Demo`,
    `- Redirect：使用 fetch \`redirect: "follow"\`，記錄最終 URL`,
    `- Preflight：HTTP ${preflightResult.status}，Demo=${preflightResult.body.demoMode}`,
    `- 結果：${stopped ? `提前停止（${stopped}）` : "所有階段完成"}`,
    "",
    "## 階段統計",
    "",
    "| 並行數 | 請求數 | 成功率 | 平均 ms | P95 ms | 最長 ms | req/s | 非重播分配 |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...stages.map((stage) => {
      const s = stage.summary;
      return `| ${stage.concurrency} | ${s.requests} | ${(s.successRate * 100).toFixed(1)}% | ${md(s.averageMs?.toFixed(2))} | ${md(s.p95Ms?.toFixed(2))} | ${md(s.maxMs?.toFixed(2))} | ${s.throughput.toFixed(2)} | ${s.nonReplayAllocations} |`;
    }),
    "",
    "## 每筆結果",
    "",
    "| requestId | 耗時 ms | 成功 | code | allocation | prize | replay |",
    "|---|---:|:---:|---|---|---|:---:|",
    ...stages.flatMap((stage) => stage.records.map((r) => `| ${md(r.requestId)} | ${md(r.durationMs)} | ${r.success ? "是" : "否"} | ${md(r.code)} | ${md(r.allocationStatus)} | ${md(r.prizeId)} | ${r.idempotentReplay ? "是" : "否"} |`)),
    ...(duplicate ? ["", "## requestId 去重檢查", "", `- 首次提交：${duplicate.first.requestId}，${duplicate.first.success ? "成功" : "失敗"}，replay=${duplicate.first.idempotentReplay ? "是" : "否"}`, `- 重播提交：${duplicate.replay.requestId}，${duplicate.replay.success ? "成功" : "失敗"}，replay=${duplicate.replay.idempotentReplay ? "是" : "否"}`, `- 判定：${duplicate.passed ? "通過：相同 requestId 僅有一次非重播分配" : "失敗：請人工核對 DemoRequests／DemoAllocations／DemoInventoryLog"}`] : []),
    "",
    "## 庫存一致性與風險",
    "",
    "- 工具以非重播 `allocationStatus: allocated` 回應計算預期扣減，並確認 replay 不計入第二次分配。",
    "- API 沒有唯讀庫存/工作表查詢端點，因此本工具不能直接讀取 DemoPrizes 與 DemoInventoryLog；請在 Google Sheet 執行既有 `verifyInventoryConsistency()` 完成最終交叉核對。",
    "- 本次工具不清空、不重設、不調整庫存；既有 Demo 資料會被保留。",
    ""
  ];
  return lines.join("\n");
}

async function confirmPlan({ apiUrl, duplicate, stages }) {
  console.log("測試目標：僅對 Google Apps Script Demo API 進行並行提交，觀察延遲、錯誤、requestId 去重及分配結果。");
  console.log(`實際 API URL：${apiUrl}`);
  console.log("Demo 識別方式：URL 必須有 mode=apps-script-demo，且執行前 status GET 必須回覆 demoMode=true。");
  console.log(`預計請求數：${stages.reduce((sum, n) => sum + n, 0) + (duplicate ? 2 : 0)}（階段 ${stages.join(", ")}，每階段最多 ${MAX_REQUESTS_PER_STAGE} 筆${duplicate ? "，另含 2 筆去重檢查" : ""}）`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("正式執行需要互動式終端；請先確認測試計畫後再以 TTY 執行 --execute");
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question("確認只使用 Demo API 並開始發送？輸入 RUN-DEMO：");
  rl.close();
  if (answer.trim() !== "RUN-DEMO") throw new Error("未確認，未發送任何提交請求");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const apiUrl = demoApiUrl(options.apiUrl).toString();
  if (!options.execute) {
    console.log(`Dry-run：不會發送請求。API URL=${apiUrl}`);
    console.log(`預計階段：${LEVELS.join(", ")}；每階段最多 ${MAX_REQUESTS_PER_STAGE} 筆；去重檢查另 2 筆。`);
    console.log("正式執行：node tests/load-test/load-test.mjs --execute --confirm-demo");
    return;
  }
  if (!options.confirm) throw new Error("正式執行必須明確帶上 --confirm-demo");
  await confirmPlan({ apiUrl, duplicate: !options.skipDuplicate, stages: LEVELS });
  const preflightResult = await preflight(apiUrl);
  const stages = [];
  let stopped = null;
  for (const concurrency of LEVELS) {
    const stage = await runStage(apiUrl, concurrency, stages.length + 1);
    stages.push(stage);
    stopped = stopReason(stage);
    if (stopped) break;
  }
  let duplicate = null;
  if (!stopped && !options.skipDuplicate) {
    const payload = makePayload(999);
    const first = await submit(apiUrl, payload);
    const replay = await submit(apiUrl, payload);
    duplicate = {
      first,
      replay,
      passed: first.success && !first.idempotentReplay && replay.success && replay.idempotentReplay &&
        first.requestId === replay.requestId && first.responseRequestId === replay.responseRequestId
    };
  }
  await mkdir(REPORT_DIR, { recursive: true });
  const reportPath = resolve(REPORT_DIR, `load-test-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.md`);
  await writeFile(reportPath, renderReport({ apiUrl, preflightResult, stages, duplicate, stopped }), "utf8");
  console.log(`完成。報告：${basename(reportPath)}`);
}

main().catch((error) => { console.error(`停止：${error.message}`); process.exitCode = 1; });
