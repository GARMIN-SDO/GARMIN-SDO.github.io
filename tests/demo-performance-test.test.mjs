import test from 'node:test';
import assert from 'node:assert/strict';
import { options, report, functional, dispatchStopReason } from './demo-performance-test.mjs';
import { makePayload } from './demo-concurrency-test.mjs';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schedule, dispatch, SCENARIOS, perSecond } from './demo-traffic.mjs';
import { auditSnapshots, parseMetrics } from './demo-data-audit.mjs';
import { combineStates } from './combine-phase2-results.mjs';
import { JITTER_SCENARIOS, summary as jitterSummary, main as suiteMain, pendingJobs } from './demo-jitter-suite.mjs';
import { parseCsv } from './combine-demo-results.mjs';

test('phase3 comparison keeps original success separate from recovery and imports response timings',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'garmin-comparison-unit-')),before=join(folder,'before'),after=join(folder,'after');
  t.after(()=>rm(folder,{recursive:true,force:true})); await mkdir(before);
  const state={batchId:'perf-unit',phase:'phase3',scenario:'uniform20-10',seed:20261127,rounds:3,plannedPosts:60,
    apiUrl:'https://script.google.com/unit?mode=apps-script-demo',createdAt:'2026-11-27T00:00:00Z',
    runners:[{requestId:'load-unit',sessionId:'session-unit',workflow:'flow',concurrency:20,round:1,
      startedAt:'2026-11-27T00:00:00Z',durationMs:30001,ok:false,timeout:true,posted:true,
      finalState:'RECOVERED_ALLOCATED',prizeId:'cap',participantId:'participant-unit'}],
    http:[{requestId:'load-unit',operation:'diagnostics',backend_attemptId:'attempt',
      ...Object.fromEntries(['lockWaitMs','lockHeldMs','totalMs','requestLookupMs','sheetReadMs','sheetWriteMs'].map(k=>[`backend_${k}`,5]))}],
    events:[],schedule:[],cancelled:0,peakHttpInFlight:0,stopped:null};
  await writeFile(join(before,'run.json'),JSON.stringify({scenario:state.scenario,seed:state.seed}));
  await writeFile(join(before,'runners.csv'),'workflow,concurrency,durationMs,ok,timeout,allocationStatus,finalState\nflow,20,30000,false,true,,UNKNOWN\n');
  await report(state,after,{before});
  const summary=parseCsv(await readFile(join(after,'summary.csv'),'utf8'))[0];
  assert.equal(summary.originalSuccessRate,0); assert.equal(summary.finalConfirmationRate,1);
  assert.equal(summary.unknownCount,0); assert.equal(summary.backendAverageLockHeld,5);
  const comparison=parseCsv(await readFile(join(after,'before-after.csv'),'utf8'));
  assert.equal(comparison[0].finalConfirmationRate,0);assert.equal(comparison[1].finalConfirmationRate,1);
  assert.equal(comparison[1].successRate,0);
  await writeFile(join(before,'run.json'),JSON.stringify({scenario:'clustered20',seed:state.seed}));
  await assert.rejects(report(state,after,{before}),/BEFORE_SCENARIO_OR_SEED_MISMATCH/);
});

test('new deployment/phase acceptance gates reject before any HTTP',()=>{
  assert.equal(options([]).execute,undefined);
  assert.equal(options(['--scenario=sync10','--workflow=post','--defer-record-audit']).workflow,'post');
  assert.throws(()=>options(['--scenario=post-single','--workflow=flow']),/INVALID_WORKFLOW/);
  assert.throws(()=>options(['--scenario=sync30','--defer-record-audit']),/AUDIT_DEFERRAL_PHASE2_ONLY/);
  for(const [args,code] of [
    [['--execute'],'DEPLOYMENT_AND_OFF_PEAK'],
    [['--execute','--deployment-confirmed','--off-peak-confirmed'],'FUNCTIONAL_ACCEPTANCE'],
    [['--execute','--deployment-confirmed','--off-peak-confirmed','--functional-accepted','--scenario=sync10'],'BASELINE_ACCEPTANCE'],
    [['--execute','--deployment-confirmed','--off-peak-confirmed','--scenario=uniform20-20'],'PHASE2_ACCEPTANCE'],
    [['--execute','--deployment-confirmed','--off-peak-confirmed','--phase2-accepted','--scenario=sync30'],'JITTER_ACCEPTANCE'],
    [['--execute','--deployment-confirmed','--off-peak-confirmed','--phase2-accepted','--jitter-accepted','--scenario=sync40'],'EXPLICIT_30_40'],
    [['--analyze=perf-local','--execute'],'ANALYZE_IS_OFFLINE'],
    [['--scenario=sync100'],'INVALID_SCENARIO'],[['--seed=-1'],'INVALID_SCENARIO'],
    [['--seed=1','--seed=2'],'DUPLICATE'],[['--api-url=https://example.test'],'UNKNOWN']]) assert.throws(()=>options(args),new RegExp(code));
});

test('all jitter schedules are deterministic, bounded and cover the requested bursts',()=>{
  for(const [name,s] of Object.entries(SCENARIOS)){
    const a=schedule(name,123,1);assert.deepEqual(a,schedule(name,123,1));assert.equal(a.length,s.count);
    assert.ok(a.every((p,i)=>p.offsetMs>=0&&(!i||p.offsetMs>=a[i-1].offsetMs)));
    if(s.shape==='uniform') {assert.ok(a.every(p=>p.offsetMs<=s.windowMs));assert.notDeepEqual(a,schedule(name,124,1));}
  }
  const burst=schedule('clustered20',123).map(p=>p.offsetMs);
  assert.equal(burst.filter(t=>t<=1000).length,8);assert.equal(burst.filter(t=>t>=3000&&t<=5000).length,7);assert.equal(burst.filter(t=>t>=7000&&t<=10000).length,5);
  const field=schedule('field50-240',123);assert.equal(field[0].offsetMs,0);assert.equal(field.at(-1).offsetMs,240000);
});

test('50 scheduled runners never exceed 40 active; first failure cancels unsent arrivals',async()=>{
  let active=0,peak=0;
  const r=await dispatch(Array.from({length:50},(_,index)=>({index,offsetMs:0})),async()=>{
    active++;peak=Math.max(peak,active);await Promise.resolve();active--;return {ok:true};
  },{wait:async()=>{}});
  assert.equal(r.records.length,50);assert.ok(peak<=40);assert.ok(r.peakInFlight<=40);
  const stopped=await dispatch([{index:0,offsetMs:0},{index:1,offsetMs:1}],async()=>({ok:false}),
    {maxInFlight:1,wait:async()=>{},shouldStop:r=>r.ok?null:'TIMEOUT'});
  assert.equal(stopped.stopped,'TIMEOUT');assert.equal(stopped.records.length,1);assert.deepEqual(stopped.cancelled,[1]);
  await assert.rejects(dispatch([],async()=>{}, {maxInFlight:41}),/MAX_IN_FLIGHT/);
  const broken=await dispatch([{index:0,offsetMs:0}],async()=>{throw new Error('local');},{wait:async()=>{}});
  assert.equal(broken.stopped,'LOCAL_RUNNER_ERROR');
});

test('per-second arrival/completion rates and in-flight are derived from real event timestamps',()=>{
  const rows=perSecond([{at:'2026-11-27T00:00:00.100Z',type:'start',operation:'submit'},
    {at:'2026-11-27T00:00:01.100Z',type:'end',operation:'submit'},
    {at:'2026-11-27T00:00:01.101Z',type:'complete',ok:true,allocationStatus:'allocated'}]);
  assert.equal(rows[0].arrivals,1);assert.equal(rows[0].httpInFlightAtEnd,1);
  assert.equal(rows[1].completions,1);assert.equal(rows[1].httpInFlightAtEnd,0);
});

function snapshot(){return {demoMode:true,scope:'full-demo',
  prizes:Object.fromEntries(['cap','soft_cup','socks','arm_sleeves','shopping_bag'].map(k=>[k,{initialStock:10,remainingStock:10,allocatedCount:0}])),
  requests:[],participants:[],allocations:[],inventoryLog:[]};}

test('offline full-demo audit verifies joins, counts, stock and partial writes, not just HTTP',()=>{
  const before=snapshot(),after=structuredClone(before);
  after.prizes.cap.remainingStock=9;after.prizes.cap.allocatedCount=1;
  after.requests.push({requestId:'load-test',sessionId:'session-test',participantId:'p',status:'allocated'});
  after.participants.push({requestId:'load-test',participantId:'p',prizeId:'cap',allocationStatus:'allocated'});
  after.allocations.push({requestId:'load-test',participantId:'p',allocationId:'a',prizeId:'cap',allocationStatus:'allocated'});
  after.inventoryLog.push({logId:'l',relatedAllocationId:'a',action:'allocation',prizeId:'cap',quantityDelta:-1,beforeStock:10,afterStock:9});
  const runners=[{requestId:'load-test',sessionId:'session-test',participantId:'p',prizeId:'cap',posted:true,finalState:'allocated'}];
  assert.equal(auditSnapshots(before,after,runners).status,'PASS');
  for(const mutate of [a=>a.participants.pop(),a=>a.requests.push(a.requests[0]),a=>a.inventoryLog[0].quantityDelta=-2,
    a=>a.prizes.cap.remainingStock=8,a=>a.allocations[0].participantId='wrong',a=>a.requests[0].status='processing']){
    const a=structuredClone(after);mutate(a);assert.equal(auditSnapshots(before,a,runners).status,'FAIL');
  }
  assert.equal(auditSnapshots(before,before,[{...runners[0],finalState:'UNKNOWN'}]).status,'未驗證');
  assert.throws(()=>auditSnapshots(before,{...after,email:'sensitive'},runners),/SENSITIVE/);
  assert.throws(()=>auditSnapshots(before,{...after,demoMode:false},runners),/INVALID_DEMO/);
});

test('backend log import requires measured fields, matching test IDs and unique request association',()=>{
  const m={event:'garmin_run_post_timing',demoMode:true,requestId:'load-test',totalMs:10,validationMs:1,
    lockWaitMs:2,lockHeldMs:6,requestLookupMs:1,prizeReadMs:1,schemaReadMs:1,settingsReadMs:0,sheetReadMs:3,sheetWriteMs:3};
  const log=JSON.stringify({textPayload:JSON.stringify({...m,untrustedExtra:'must not copy'})});
  const parsed=parseMetrics(log,['load-test']);assert.equal(parsed.length,1);assert.equal(parsed[0].lockHeldMs,6);
  assert.equal(Object.hasOwn(parsed[0],'untrustedExtra'),false);
  assert.equal(parseMetrics(log,['other-test']).length,0);
  assert.throws(()=>parseMetrics(log+'\n'+log,['load-test']),/DUPLICATE/);
  assert.throws(()=>parseMetrics(JSON.stringify({...m,lockHeldMs:-1}),['load-test']),/INVALID_BACKEND/);
});

test('offline report pipeline creates CSV/Markdown without inventing measurements',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'garmin-report-unit-'));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  const state={batchId:'perf-offline-unit',phase:'phase2',scenario:'post-single',seed:1,rounds:10,plannedPosts:10,
    apiUrl:'https://script.google.com/unit?mode=apps-script-demo',createdAt:'2026-11-27T00:00:00Z',
    runners:[],http:[],events:[],schedule:[],cancelled:0,peakHttpInFlight:0,stopped:null,preflight:'unit fixture; no HTTP'};
  await report(state,folder,{});
  for(const file of ['run.json','http.csv','runners.csv','summary.csv','per-second.csv','schedule.csv','backend.csv','before-after.csv','performance.md']) assert.ok((await stat(join(folder,file))).isFile());
  const text=await readFile(join(folder,'performance.md'),'utf8');
  assert.match(text,/未量測/);assert.match(text,/未驗證/);assert.match(text,/沒有 POST 實測樣本/);
  await assert.rejects(stat(join(folder,'lock.svg')), {code:'ENOENT'});
  await assert.rejects(stat(join(folder,'latency.svg')), {code:'ENOENT'});
});

test('functional negative-answer request logs its real ID, not the initial allocation ID',async()=>{
  const payload=makePayload('load-offline-functional',2), state={batchId:'perf-unit',runners:[],http:[]}, calls=[];
  const allocation={ok:true,demoMode:true,requestId:payload.requestId,sessionId:payload.sessionId,
    participantId:'staging_unit',runnerType:payload.runnerType,sustainabilityRewardEligible:payload.sustainabilityRewardEligible,
    allocationStatus:'allocated',prize:{prizeId:'cap'}};
  await functional('https://script.google.com/unit?mode=apps-script-demo',state,payload,async(_u,opts={})=>{
    calls.push(opts.payload);
    const n=calls.length;
    const body=n===1?allocation:n===2?{...allocation,idempotentReplay:true}:n<=4?{ok:false,code:'REQUEST_ID_CONFLICT'}:
      n===5?{ok:false,code:'INVALID_ANSWER'}:{ok:true,demoMode:true,found:true,allocation};
    return {startedAt:'2026-11-27T00:00:00Z',durationMs:1,httpStatus:200,ok:body.ok,errorCode:body.code||'',timeout:false,invalidResponse:false,body};
  });
  assert.ok(state.functional.every(c=>c.passed));
  assert.equal(state.http.find(r=>r.operation==='無效答案拒絕').requestId,calls[4].requestId);
  assert.notEqual(calls[4].requestId,payload.requestId);
});

test('phase2 aggregation refuses double counting and preserves failed batch status',()=>{
  const s={batchId:'perf-unit',phase:'phase2',scenario:'post-single',preflight:'PASS: unit',apiUrl:'https://script.google.com/unit?mode=apps-script-demo',
    seed:1,plannedPosts:10,recordAuditDeferred:true,runners:[{requestId:'load-unit'}],http:[],events:[],schedule:[],cancelled:0,peakHttpInFlight:1,stopped:'TIMEOUT'};
  const merged=combineStates([s]);
  assert.equal(merged.stopped,'TIMEOUT');assert.equal(merged.recordAuditDeferred,true);
  assert.throws(()=>combineStates([s,s]),/DUPLICATE_REQUEST_IDS/);
  assert.throws(()=>combineStates([{...s,phase:'phase3'}]),/INVALID_PHASE2_BATCHES/);
});

test('explicit sync10 continuation tolerates latency/timeouts but not hard errors; scope stays bounded',()=>{
  const late={ok:true,allocationStatus:'allocated',durationMs:27000,idempotentReplay:false};
  const timed={ok:false,posted:true,timeout:true,errorCode:'TIMEOUT',durationMs:30000};
  assert.equal(dispatchStopReason(late),'ABNORMAL_LATENCY_25S');
  assert.equal(dispatchStopReason(late,true),null);assert.equal(dispatchStopReason(timed,true),null);
  for(const code of ['QUOTA_OR_EXECUTION_LIMIT','ALLOCATION_CONTRACT_MISMATCH','LOCK_BUSY','NETWORK_ERROR']) assert.equal(dispatchStopReason({ok:false,errorCode:code},true),code);
  assert.equal(dispatchStopReason({...late,idempotentReplay:true,durationMs:1},true),'UNEXPECTED_REPLAY');
  const o=options(['--scenario=sync10','--workflow=post','--start-round=2','--continue-sync10']);assert.equal(o.startRound,2);
  assert.throws(()=>options(['--scenario=sync10','--workflow=post','--start-round=4']),/INVALID_START_ROUND/);
  assert.throws(()=>options(['--scenario=sync30','--workflow=post','--continue-sync10']),/CONTINUATION_SYNC10_POST_ONLY/);
});

test('merging an explicitly resumed sync10 preserves errors but resolves the historical stop without double planning',()=>{
  const base={phase:'phase2',scenario:'sync10',preflight:'PASS: unit',apiUrl:'https://script.google.com/unit?mode=apps-script-demo',
    seed:1,workflows:['post'],recordAuditDeferred:true,http:[],events:[],schedule:[],cancelled:0,peakHttpInFlight:10};
  const rows=round=>Array.from({length:10},(_,i)=>({workflow:'post',concurrency:10,round,requestId:`load-${round}-${i}`,finalState:i===0?'RECOVERED_ALLOCATED':'allocated'}));
  const first={...base,batchId:'perf-first',plannedPosts:30,runners:rows(1),stopped:'ABNORMAL_LATENCY_25S'};
  const rest={...base,batchId:'perf-rest',startRound:2,continueSync10:true,plannedPosts:20,runners:[...rows(2),...rows(3)],stopped:null};
  const merged=combineStates([first,rest]);
  assert.equal(merged.stopped,null);assert.equal(merged.historicalStops.length,1);assert.equal(merged.plannedPosts,30);
  assert.equal(merged.runners.length,30);
  assert.equal(combineStates([first,{...rest,stopped:'QUOTA_OR_EXECUTION_LIMIT'}]).stopped,'QUOTA_OR_EXECUTION_LIMIT');
});

test('HTTP-only jitter approval never authorizes extreme sync; suite and scenario summaries remain bounded',async()=>{
  const o=options(['--scenario=uniform20-20','--execute','--deployment-confirmed','--off-peak-confirmed','--http-only-approved','--continue-jitter']);
  assert.equal(o['http-only-approved'],true);
  assert.throws(()=>options(['--scenario=sync30','--http-only-approved']),/JITTER_HTTP_ONLY_SCOPE/);
  assert.equal(JITTER_SCENARIOS.length,6);assert.ok(JITTER_SCENARIOS.every(n=>!SCENARIOS[n].extreme));
  assert.equal(JITTER_SCENARIOS.reduce((n,k)=>n+SCENARIOS[k].count*SCENARIOS[k].rounds*2,0),840);
  await assert.rejects(suiteMain(['--execute']),/SUITE_CONFIRMATIONS_REQUIRED/);
  const row={workflow:'post',round:1,requestId:'load-unit',ok:true,allocationStatus:'allocated',durationMs:2000,finalState:'allocated'};
  const sums=jitterSummary([{scenario:'uniform20-20',runners:[row],http:[],stopped:null},
    {scenario:'uniform20-30',runners:[{...row,requestId:'load-other',durationMs:4000}],http:[],stopped:null}]);
  assert.equal(sums.length,2);assert.equal(sums[0].meanMs,2000);assert.equal(sums[1].meanMs,4000);
  assert.equal(sums[0].roundsCompleted,0);
});

test('explicit UNKNOWN-retention resume plans only the missing 700 POSTs and merges split rounds',()=>{
  const args=['--scenario=uniform20-30','--workflow=flow','--start-round=2','--http-only-approved','--continue-jitter','--retain-unknown'];
  assert.equal(options(args).startRound,2);assert.equal(options(args)['retain-unknown'],true);
  assert.throws(()=>options(['--scenario=sync30','--retain-unknown']),/UNKNOWN_RETENTION_REQUIRES_JITTER_APPROVAL/);
  const rows=(scenario,workflow,round)=>Array.from({length:SCENARIOS[scenario].count},(_,i)=>({workflow,round,requestId:`${scenario}-${workflow}-${round}-${i}`,ok:true,allocationStatus:'allocated',durationMs:1000,finalState:'allocated'}));
  const first={scenario:'uniform10-10',runners:['post','flow'].flatMap(w=>[1,2,3].flatMap(r=>rows('uniform10-10',w,r))),http:[],stopped:null};
  const second={scenario:'uniform20-30',runners:[...[1,2,3].flatMap(r=>rows('uniform20-30','post',r)),...rows('uniform20-30','flow',1)],http:[],stopped:'BACKEND_FINAL_STATE_UNKNOWN'};
  const jobs=pendingJobs([first,second]);
  assert.deepEqual(jobs[0],{scenario:'uniform20-30',workflow:'flow',startRound:2,posts:40});
  assert.equal(jobs.reduce((n,j)=>n+j.posts,0),700);
  const rest={scenario:'uniform20-30',runners:[2,3].flatMap(r=>rows('uniform20-30','flow',r)),http:[],stopped:null};
  const sums=jitterSummary([second,rest]);assert.equal(sums.find(s=>s.workflow==='flow').samples,60);assert.equal(sums.find(s=>s.workflow==='flow').roundsCompleted,3);
  assert.throws(()=>pendingJobs([{...second,runners:second.runners.slice(0,1)}]),/PARTIAL_ROUND/);
});
