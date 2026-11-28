import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRetest } from './report-fifty-retest.mjs';

function fixture(){
  const runners=[
    {requestId:'one',round:1,ok:true,allocationStatus:'allocated',finalState:'allocated',durationMs:1000},
    {requestId:'two',round:1,ok:false,timeout:true,finalState:'RECOVERED_ALLOCATED',durationMs:30000},
    {requestId:'three',round:1,ok:false,timeout:true,finalState:'UNKNOWN',durationMs:30000,queueDelayMs:5000},
    {requestId:'four',round:1,ok:true,allocationStatus:'paused',finalState:'paused',durationMs:1500}
  ];
  const timing=(requestId,code,held)=>({requestId,operation:'diagnostics',backend_code:code,
    backend_totalMs:20,backend_lockWaitMs:10,backend_lockHeldMs:held,backend_requestLookupMs:1,backend_sheetReadMs:2,backend_sheetWriteMs:3});
  return {batchId:'fixture',scenario:'uniform50-10',seed:20261127,workflows:['flow'],peakHttpInFlight:40,
    runners,http:[...runners.map(r=>({requestId:r.requestId,operation:'submit'})),timing('two','OK',10),timing('three','LOCK_BUSY',0),
    ...[1,2,3].map(round=>({operation:'health',ok:true,round}))],stopped:null};
}

test('recovery and paused stay separate; unknown keeps diagnosed cause; queue included separately',()=>{
  const result=summarizeRetest(fixture());
  assert.equal(result.originalAllocated,1);assert.equal(result.finalAllocated,2);
  assert.equal(result.originalPaused,1);assert.equal(result.finalPaused,1);
  assert.equal(result.timeout,2);assert.equal(result.unknown,1);assert.equal(result.unknownLockBusy,1);
  assert.equal(result.postCount,4);assert.equal(result.p95Ms,30000);assert.equal(result.p95WithClientQueueMs,35000);
  assert.equal(result.meanLockHeldWhenAcquiredMs,10);assert.equal(result.complete,false);
});

test('cannot combine other scenarios, duplicate IDs, repeat POST or exceed forty clients',()=>{
  const seed=fixture();seed.seed=1;assert.throws(()=>summarizeRetest(seed),/SCOPE_MISMATCH/);
  const scenario=fixture();scenario.scenario='uniform40-10';assert.throws(()=>summarizeRetest(scenario),/SCOPE_MISMATCH/);
  const ids=fixture();ids.runners.push(ids.runners[0]);assert.throws(()=>summarizeRetest(ids),/DUPLICATE_RUNNER_ID/);
  const posts=fixture();posts.http.push(posts.http[0]);assert.throws(()=>summarizeRetest(posts),/REPEATED_POST/);
  const peak=fixture();peak.peakHttpInFlight=41;assert.throws(()=>summarizeRetest(peak),/CLIENT_CAP_EXCEEDED/);
});

test('150 samples alone do not mean recovery is complete; require all three health checks',()=>{
  const state=fixture();state.runners=Array.from({length:150},(_,i)=>({requestId:`r${i}`,round:1+Math.floor(i/50),
    ok:true,allocationStatus:'allocated',finalState:'allocated',durationMs:1000}));
  state.http=state.runners.map(r=>({requestId:r.requestId,operation:'submit'}));
  assert.equal(summarizeRetest(state).complete,false);
  state.http.push(...[1,2,3].map(round=>({operation:'health',round,ok:true})));
  assert.equal(summarizeRetest(state).complete,true);
  assert.equal(summarizeRetest(state,2).samples,50);assert.equal(summarizeRetest(state,2).complete,true);
  const repeatedHealth=structuredClone(state);repeatedHealth.http.filter(r=>r.operation==='health').forEach(r=>{r.round=1;});
  assert.equal(summarizeRetest(repeatedHealth).complete,false);
  const wrongRounds=structuredClone(state);wrongRounds.runners.forEach(r=>{r.round=1;});
  assert.equal(summarizeRetest(wrongRounds).complete,false);
  state.stopped='DEMO_STOCK_UNAVAILABLE';assert.equal(summarizeRetest(state).complete,false);
});
