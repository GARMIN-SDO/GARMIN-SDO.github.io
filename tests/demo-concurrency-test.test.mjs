import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseCsv } from './combine-demo-results.mjs';
import { assertDemo, configuredUrl, makePayload, http, validStatus, validAllocation, runner, stopReason, summarize, quantile, LEVELS, main, publicRecord } from './demo-concurrency-test.mjs';

const url = await configuredUrl();
const payload = makePayload('offline-test', 2);
const allocation = p => ({ ok: true, demoMode: true, requestId: p.requestId, sessionId: p.sessionId,
  participantId: `staging_${p.requestId}`, runnerType: p.runnerType,
  sustainabilityRewardEligible: p.sustainabilityRewardEligible, allocationStatus: 'allocated', prize: { prizeId: 'cap' } });

test('timing capture requires complete matching Demo measurements and excludes response secrets', () => {
  const diagnostics = { version: 2, demoMode: true, requestId: payload.requestId, attemptId: 'attempt',
    ...Object.fromEntries(['lockWaitMs','lockHeldMs','totalMs','requestLookupMs','sheetReadMs','sheetWriteMs'].map(k=>[k,5])),
    sessionId: 'never-copy', redemptionCode: 'never-copy' };
  const r={durationMs:10,body:{diagnostics}};
  const recorded=publicRecord(r,{requestId:payload.requestId},'submit');
  assert.equal(recorded.backend_lockHeldMs,5); assert.equal(recorded.backend_attemptId,'attempt');
  assert.equal(JSON.stringify(recorded).includes('never-copy'),false);
  diagnostics.requestId='wrong'; assert.equal(publicRecord(r,{requestId:payload.requestId},'submit').backend_totalMs,undefined);
  diagnostics.requestId=payload.requestId; diagnostics.sheetWriteMs=-1;
  assert.equal(publicRecord(r,{requestId:payload.requestId},'submit').backend_totalMs,undefined);
});

test('only current explicit Demo deployment is accepted, including rejecting ambiguous mode', () => {
  assert.equal(assertDemo(url, url), url);
  for (const invalid of [url.replace('?mode=apps-script-demo',''), url + '&mode=production', url + '&demoMode=false',
    url.replace('https:', 'http:'), url.replace('/s/', '/s/other'), url.replace('script.google.com','evil.test')]) {
    assert.throws(() => assertDemo(invalid, url), /DEMO_URL_REJECTED/);
  }
  assert.equal(Math.max(...Object.values(LEVELS).flat()), 40);
});

test('generated payloads cover mixed types/eligibilities with unique IDs', () => {
  const cases = Array.from({length: 40}, (_, i) => makePayload('offline-test', i));
  for (const p of cases) {
    assert.ok(p.requestId.length <= 128 && p.sessionId.length <= 128);
    assert.equal(Object.hasOwn(p,'demoMode'), false);
  }
  assert.equal(new Set(cases.map(p=>p.requestId)).size,40);
  assert.equal(new Set(cases.map(p=>p.runnerType)).size,3);
  assert.equal(new Set(cases.map(p=>p.hydrationStyle)).size,3);
  assert.equal(new Set(cases.map(p=>p.hydrationCommitment)).size,3);
});

test('optional ignored local backend validator agrees', { skip: !existsSync(new URL('../apps-script/Validation.gs', import.meta.url)) }, () => {
  const ctx = vm.createContext({});
  vm.runInContext(readFileSync(new URL('../apps-script/Validation.gs', import.meta.url), 'utf8'), ctx);
  for (let i=0; i<40; i++) assert.equal(ctx.validateAnonymousSubmission(makePayload('offline-test',i), true).demoMode,true);
});

test('write and high-load gates fail offline before any request', async () => {
  for (const args of [['--execute','--plan'],['--execute','--off-peak-confirmed','--phase=high','--plan'],['--phase=41','--plan']]) {
    await assert.rejects(main(args), /OFF_PEAK_CONFIRMATION_REQUIRED|HIGH_PHASE_REVIEW_REQUIRED|INVALID_PHASE/);
  }
});

test('GAS 302 switches POST to GET without forwarding payload', async () => {
  const calls = [];
  const r = await http(url, { payload, fetchImpl: async (u, opts) => {
    calls.push({ url: String(u), ...opts });
    return calls.length === 1 ? new Response(null, {status:302,headers:{location:'https://script.googleusercontent.com/macros/echo?x=test'}}) : Response.json(allocation(payload));
  }});
  assert.equal(r.ok, true); assert.equal(r.redirected, true);
  assert.equal(calls[0].method,'POST'); assert.equal(calls[1].method,'GET'); assert.equal(calls[1].body,undefined);
});

test('unsafe body-preserving redirect, production redirect, invalid JSON, HTTP quota classified', async () => {
  for (const [status, location] of [[307,'https://script.googleusercontent.com/macros/echo'],[302,url.replace('?mode=apps-script-demo','')]]) {
    let n = 0;
    const r = await http(url,{payload,fetchImpl:async()=>{ n++; return new Response(null,{status,headers:{location}}); }});
    assert.equal(r.errorCode,'UNSAFE_REDIRECT'); assert.equal(n,1);
  }
  assert.equal((await http(url,{fetchImpl:async()=>new Response('<html>Error</html>')})).invalidResponse,true);
  assert.equal((await http(url,{fetchImpl:async()=>new Response('Too many simultaneous executions',{status:429})})).errorCode,'QUOTA_OR_EXECUTION_LIMIT');
});

test('timeout classified separately from network failure', async () => {
  const keepAlive = setTimeout(()=>{}, 1000);
  try {
    const r = await http(url,{timeoutMs:5,fetchImpl:async(_u,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))});
    assert.equal(r.timeout,true); assert.equal(r.errorCode,'TIMEOUT');
  } finally { clearTimeout(keepAlive); }
});

test('flow GET guard prevents POST; runner launch uses a common barrier', async () => {
  let count=0;
  const records=[];
  const base={startedAt:new Date().toISOString(),durationMs:1,httpStatus:200,ok:true,errorCode:'',timeout:false,invalidResponse:false};
  const r=await runner(url,payload,{},'flow',records,async()=>{count++;return {...base,body:{ok:true,demoMode:false}};});
  assert.equal(count,1); assert.equal(r.posted,false);
  let launched=0, release;
  const barrier=new Promise(r=>{release=r;});
  const jobs=Array.from({length:40},(_,i)=>{
    const p=makePayload('offline-test',i);
    return runner(url,p,{requestId:p.requestId},'post',records,async()=>{launched++;await barrier;return {...base,body:allocation(p)};});
  });
  assert.equal(launched,40); release();
  assert.ok((await Promise.all(jobs)).every(r=>r.ok));
});

test('mismatched identity/eligibility rejected; failure/latency/empty stock stop escalation', () => {
  assert.equal(validStatus({ok:true,body:{demoMode:true,quizVersion:2,submissionVersion:1,allocationEnabled:true}}),true);
  assert.equal(validAllocation(allocation(payload),payload),true);
  assert.equal(validAllocation({...allocation(payload),requestId:'wrong'},payload),false);
  assert.equal(stopReason([{ok:true,durationMs:25000}]),'ABNORMAL_LATENCY_25S');
  assert.equal(stopReason([{ok:false,errorCode:'LOCK_BUSY'}]),'LOCK_BUSY');
  assert.equal(stopReason([{ok:true,durationMs:1,allocationStatus:'paused'}]),'DEMO_STOCK_UNAVAILABLE');
});

test('summary thresholds use successful completions and percentiles include failed user waits', () => {
  const rows=[1000,6000,30000].map((durationMs,i)=>({workflow:'post',concurrency:3,round:1,requestId:String(i),
    startedAt:'2026-11-27T00:00:00Z',durationMs,ok:i<2,timeout:i===2,allocationStatus:i<2?'allocated':''}));
  const s=summarize(rows,[])[0];
  assert.equal(s.successCount,2); assert.equal(s.timeoutCount,1);
  assert.equal(s.completedWithin5s,1); assert.equal(s.completedWithin10s,2); assert.equal(s.p95Ms,30000);
  assert.equal(quantile([3,1,2],.5),2); assert.equal(s.finalInventoryConsistency,'未驗證');
});

test('local aggregation parses quoted CSV without corrupting booleans or escaped cells', () => {
  assert.deepEqual(parseCsv('"requestId","ok","durationMs","errorCode"\n"load-test","false","30000.5","a,""b"""\n'),
    [{ requestId:'load-test',ok:false,durationMs:30000.5,errorCode:'a,"b"' }]);
  assert.throws(()=>parseCsv('"broken'),/INVALID_CSV/);
});
