// Deployment-gated Phase 2/3 tool. Default is an offline plan, not a POST.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { configuredUrl, assertDemo, makePayload, http, runner, validStatus, validAllocation, actionUrl,
  publicRecord, stopReason, summarize, quantile, recover, save } from './demo-concurrency-test.mjs';
import { SCENARIOS, schedule, dispatch, perSecond } from './demo-traffic.mjs';
import { auditSnapshots, parseMetrics } from './demo-data-audit.mjs';
import { parseCsv } from './combine-demo-results.mjs';

const ROOT=fileURLToPath(new URL('../test-results/',import.meta.url));
const csv=rows=>{
  if(!rows.length) return '"status"\n"未量測"\n';
  const keys=[...new Set(rows.flatMap(Object.keys))];
  const cell=v=>`"${String(v??'').replaceAll('"','""')}"`;
  return [keys,...rows.map(r=>keys.map(k=>r[k]))].map(r=>r.map(cell).join(',')).join('\n')+'\n';
};

export function options(argv) {
  const bools=['--execute','--preflight','--deployment-confirmed','--off-peak-confirmed','--functional-accepted',
    '--baseline-accepted','--phase2-accepted','--jitter-accepted','--approve-extreme','--defer-record-audit','--continue-sync10','--http-only-approved','--continue-jitter','--retain-unknown','--collect-timing'];
  const values=['scenario','workflow','start-round','seed','analyze','before','backend-log','snapshot-before','snapshot-after'];
  const out={};
  for(const arg of argv){
    if(bools.includes(arg)) {if(out[arg.slice(2)]) throw new Error('DUPLICATE_OPTION');out[arg.slice(2)]=true;continue;}
    const key=values.find(k=>arg.startsWith(`--${k}=`));
    if(!key||Object.hasOwn(out,key)) throw new Error('UNKNOWN_OR_DUPLICATE_OPTION');
    out[key]=arg.slice(key.length+3);
  }
  out.scenario ||= 'post-single'; out.seed=Number(out.seed??20261127);
  if(!SCENARIOS[out.scenario]||!Number.isInteger(out.seed)||out.seed<0||out.seed>0xffffffff) throw new Error('INVALID_SCENARIO_OR_SEED');
  if(out.workflow&&(!['post','flow'].includes(out.workflow)||!(SCENARIOS[out.scenario].workflows||['post','flow']).includes(out.workflow))) throw new Error('INVALID_WORKFLOW');
  if(out['defer-record-audit']&&SCENARIOS[out.scenario].phase!==2) throw new Error('AUDIT_DEFERRAL_PHASE2_ONLY');
  out.startRound=Number(out['start-round']??1);
  if(!Number.isInteger(out.startRound)||out.startRound<1||out.startRound>SCENARIOS[out.scenario].rounds) throw new Error('INVALID_START_ROUND');
  if(out['continue-sync10']&&(out.scenario!=='sync10'||out.workflow!=='post')) throw new Error('CONTINUATION_SYNC10_POST_ONLY');
  if(out.startRound!==1&&!(out.scenario==='sync10'&&out.workflow==='post')&&
    !(SCENARIOS[out.scenario].phase===3&&!SCENARIOS[out.scenario].extreme&&out.workflow&&out['continue-jitter'])) throw new Error('INVALID_RESUME_SCOPE');
  if((out['http-only-approved']||out['continue-jitter'])&&(SCENARIOS[out.scenario].phase!==3||SCENARIOS[out.scenario].extreme)) throw new Error('JITTER_HTTP_ONLY_SCOPE');
  if(out['retain-unknown']&&!(SCENARIOS[out.scenario].phase===3&&!SCENARIOS[out.scenario].extreme&&out['continue-jitter']&&out['http-only-approved'])) throw new Error('UNKNOWN_RETENTION_REQUIRES_JITTER_APPROVAL');
  if(out.analyze&&(out.execute||out.preflight)) throw new Error('ANALYZE_IS_OFFLINE_ONLY');
  if(out.execute){
    const s=SCENARIOS[out.scenario];
    if(!out['deployment-confirmed']||!out['off-peak-confirmed']) throw new Error('DEPLOYMENT_AND_OFF_PEAK_CONFIRMATION_REQUIRED');
    if(s.phase===2&&s.shape!=='functional'&&!out['functional-accepted']) throw new Error('FUNCTIONAL_ACCEPTANCE_REQUIRED');
    if(out.scenario==='sync10'&&!out['baseline-accepted']) throw new Error('BASELINE_ACCEPTANCE_REQUIRED');
    if(s.phase===3&&!out['phase2-accepted']&&!out['http-only-approved']) throw new Error('PHASE2_ACCEPTANCE_REQUIRED');
    if(s.extreme&&!out['jitter-accepted']) throw new Error('JITTER_ACCEPTANCE_REQUIRED');
    if(s.count>=30&&s.extreme&&!out['approve-extreme']) throw new Error('EXPLICIT_30_40_APPROVAL_REQUIRED');
    if(s.highLoad&&!out['approve-extreme']) throw new Error('EXPLICIT_40_50_APPROVAL_REQUIRED');
  }
  return out;
}

export function dispatchStopReason(record, continueSync10=false) {
  if(continueSync10&&(((record.posted||record.finalState==='NOT_SUBMITTED')&&record.timeout&&record.errorCode==='TIMEOUT')||
    (record.ok&&record.allocationStatus==='allocated'&&!record.idempotentReplay))) return null;
  return stopReason([record]);
}

function resultFolder(name){
  if(!/^perf-[A-Za-z0-9-]+$/.test(name)) throw new Error('Provide a perf-* batch directory name');
  return resolve(ROOT,name);
}

export async function functional(apiUrl,state,payload,transport=http){
  const meta={requestId:payload.requestId,batchId:state.batchId,concurrency:1,round:1,workflow:'post'};
  const first=await runner(apiUrl,payload,meta,'post',state.http,transport);
  state.runners.push(first); state.stopped=stopReason([first]);
  state.functional=[{check:'正常分配',passed:first.ok&&first.allocationStatus==='allocated'}];
  if(state.stopped){await recover(apiUrl,[[first,payload]],state);return;}
  const check=async(name,body,predicate,action)=>{
    const r=await transport(action?actionUrl(apiUrl,action,payload):apiUrl,action?{}:{payload:body,timeoutMs:30000});
    state.http.push(publicRecord(r,{...meta,requestId:body?.requestId||payload.requestId},name));
    const passed=predicate(r); state.functional.push({check:name,passed,errorCode:r.errorCode});
    if(!passed) state.stopped='FUNCTIONAL_CHECK_FAILED';
    return r;
  };
  await check('同 ID 重播',payload,r=>r.ok&&validAllocation(r.body,payload)&&r.body.idempotentReplay===true&&r.body.participantId===first.participantId&&r.body.prize.prizeId===first.prizeId);
  if(state.stopped)return;
  const changed=makePayload(state.batchId,0); changed.requestId=payload.requestId;changed.sessionId=payload.sessionId;
  await check('同 ID 不同 payload',changed,r=>r.body?.code==='REQUEST_ID_CONFLICT');
  if(state.stopped)return;
  await check('同 ID 不同 session',{...payload,sessionId:`session-${randomUUID()}`},r=>r.body?.code==='REQUEST_ID_CONFLICT');
  if(state.stopped)return;
  const invalid=makePayload(state.batchId,1); invalid.answers.q1='invalid';
  await check('無效答案拒絕',invalid,r=>r.body?.code==='INVALID_ANSWER');
  if(state.stopped)return;
  await check('原 ID GET 恢復',null,r=>r.ok&&r.body.demoMode===true&&r.body.found===true&&validAllocation(r.body.allocation,payload),'getExistingAllocation');
}

function compare(rows,beforeRows,backend){
  const stats=(g)=>{
    const t=g.map(r=>r.durationMs),ok=g.filter(r=>r.ok&&r.allocationStatus==='allocated');
    return {n:g.length,meanMs:t.reduce((a,b)=>a+b,0)/t.length,p50Ms:quantile(t,.5),p95Ms:quantile(t,.95),
      maximumMs:Math.max(...t),successRate:ok.length/g.length,timeoutRate:g.filter(r=>r.timeout).length/g.length,
      finalConfirmationRate:g.filter(r=>['allocated','RECOVERED_ALLOCATED'].includes(r.finalState)).length/g.length,
      unknown:g.filter(r=>r.finalState==='UNKNOWN').length};
  };
  return [...Map.groupBy(rows,r=>`${r.workflow}/${r.concurrency}`).entries()].flatMap(([group,g])=>{
    const old=beforeRows.filter(r=>`${r.workflow}/${r.concurrency}`===group);
    const ms=backend.filter(m=>g.some(r=>r.requestId===m.requestId));
    const avg=key=>ms.length?ms.reduce((a,b)=>a+b[key],0)/ms.length:'未量測';
    return [...(old.length?[{group,version:'Before',...stats(old),backendSamples:0,lockWaitMs:'未量測',lockHeldMs:'未量測',sheetReadMs:'未量測',sheetWriteMs:'未量測'}]:[]),
      {group,version:'After',...stats(g),backendSamples:ms.length,lockWaitMs:avg('lockWaitMs'),lockHeldMs:avg('lockHeldMs'),sheetReadMs:avg('sheetReadMs'),sheetWriteMs:avg('sheetWriteMs')}];
  });
}

export async function report(state,folder,opts){
  if(opts.before&&state.phase!=='phase2'){
    const baseline=JSON.parse(await readFile(resolve(opts.before,'run.json'),'utf8'));
    if(baseline.scenario!==state.scenario||baseline.seed!==state.seed)throw new Error('BEFORE_SCENARIO_OR_SEED_MISMATCH');
  }
  await mkdir(folder,{recursive:true});
  // Only synthetic IDs, measured HTTP fields and scheduler metadata; never raw API responses.
  await writeFile(resolve(folder,'run.json'),JSON.stringify(state,null,2));
  await save(state,folder);
  const metrics=opts['backend-log']?parseMetrics(await readFile(resolve(opts['backend-log']),'utf8'),state.runners.map(r=>r.requestId)):
    state.http.filter(r=>Number.isFinite(r.backend_totalMs)).map(r=>({requestId:r.requestId,attemptId:r.backend_attemptId,
      ...Object.fromEntries(['lockWaitMs','lockHeldMs','totalMs','requestLookupMs','sheetReadMs','sheetWriteMs','sheetFlushMs'].map(k=>[k,r[`backend_${k}`]]))}));
  const audit=opts['snapshot-before']&&opts['snapshot-after']?auditSnapshots(
    JSON.parse(await readFile(resolve(opts['snapshot-before']),'utf8')),JSON.parse(await readFile(resolve(opts['snapshot-after']),'utf8')),state.runners):
    {status:'未驗證',issues:[],note:'未提供完整去敏 Demo 前後快照；不能由 HTTP 成功推導 Sheets 一致性。'};
  if(audit.status==='FAIL') {state.stopped ||= 'INVENTORY_AUDIT_FAILED';process.exitCode=1;}
  await writeFile(resolve(folder,'run.json'),JSON.stringify(state,null,2));
  const before=opts.before?parseCsv(await readFile(resolve(opts.before,'runners.csv'),'utf8')):[];
  const comparison=compare(state.runners,before,metrics);
  const sums=summarize(state.runners,state.http).map(s=>{
    const ids=new Set(state.runners.filter(r=>r.workflow===s.workflow&&r.concurrency===s.concurrency&&r.round===s.round).map(r=>r.requestId));
    const m=metrics.filter(r=>ids.has(r.requestId));
    const flush=m.filter(r=>Number.isFinite(r.sheetFlushMs));
    const rows=state.runners.filter(r=>ids.has(r.requestId));
    const confirmed=rows.filter(r=>['allocated','RECOVERED_ALLOCATED'].includes(r.finalState)).length;
    return {...s,originalSuccessRate:rows.length?rows.filter(r=>r.ok&&r.allocationStatus==='allocated').length/rows.length:0,
      finalConfirmedCount:confirmed,finalConfirmationRate:rows.length?confirmed/rows.length:0,
      unknownCount:rows.filter(r=>r.finalState==='UNKNOWN').length,
      backendSamples:m.length,backendAverageLockWait:m.length?m.reduce((a,b)=>a+b.lockWaitMs,0)/m.length:'未量測',
      backendAverageLockHeld:m.length?m.reduce((a,b)=>a+b.lockHeldMs,0)/m.length:'未量測',
      backendAverageSheetRead:m.length?m.reduce((a,b)=>a+b.sheetReadMs,0)/m.length:'未量測',
      backendAverageSheetWrite:m.length?m.reduce((a,b)=>a+b.sheetWriteMs,0)/m.length:'未量測',
      backendFlushSamples:flush.length,backendAverageSheetFlush:flush.length?flush.reduce((a,b)=>a+b.sheetFlushMs,0)/flush.length:'未量測',
      finalInventoryConsistency:audit.status};
  });
  await writeFile(resolve(folder,'summary.csv'),csv(sums));
  await writeFile(resolve(folder,'before-after.csv'),csv(comparison));
  const rates=[...Map.groupBy(state.events,e=>`${e.workflow}/${e.round}`).values()].flatMap(g=>perSecond(g).map(r=>({workflow:g[0].workflow,round:g[0].round,...r})));
  await writeFile(resolve(folder,'per-second.csv'),csv(rates));
  await writeFile(resolve(folder,'schedule.csv'),csv(state.schedule));
  await writeFile(resolve(folder,'backend.csv'),csv(metrics));
  if(metrics.length){
    const max=Math.max(1,...metrics.map(m=>m.lockWaitMs+m.lockHeldMs));
    const bars=metrics.map((m,i)=>`<rect x="80" y="${35+i*12}" width="${m.lockWaitMs/max*600}" height="9" fill="#176b91"/><rect x="${80+m.lockWaitMs/max*600}" y="${35+i*12}" width="${m.lockHeldMs/max*600}" height="9" fill="#b45a00"/>`).join('');
    await writeFile(resolve(folder,'lock.svg'),`<svg xmlns="http://www.w3.org/2000/svg" width="760" height="${60+metrics.length*12}"><rect width="100%" height="100%" fill="white"/><text x="20" y="20">Lock wait (blue) + held (orange); scale 0-${max} ms</text>${bars}</svg>`);
  }
  const text=['# POST 優化後／Jitter 測試報告','',`批次：${state.batchId}；情境：${state.scenario}；seed：${state.seed}；UTC：${state.createdAt}`,
    `停止原因：${state.stopped||'無'}；未送出的排程：${state.cancelled}；邏輯 HTTP 峰值：${state.peakHttpInFlight}。`,
    ...(state.continueSync10?['本批依使用者指示接續完成十人同步組：延遲不單獨中止；逾時先使用原 ID 確認成功再繼續。配額／契約／無法確認結果等硬性停止條件仍保留。']:[]),
    ...(state.httpOnlyApproved?['本批依使用者新指示執行 Jitter HTTP 測試，暫緩後端日誌及 Sheets 核對；不是宣稱第二階段資料一致性已驗收。']:[]),
    ...(state.retainUnknown?['使用者明確授權保留 UNKNOWN 並繼續：查不到結果不當成成功或失敗，不換 ID 重抽；配額、契約、庫存等硬性停止條件仍保留。']:[]),
    ...(state.historicalStops||[]).map(s=>`先前批次 ${s.batchId} 曾因 ${s.reason} 中斷；原資料保留，後由使用者指示續測補齊三輪，不能將歷史停止原因誤當目前未完成。`),
    '此工具只讀現有設定中的 Demo URL。GET 15 秒／POST 30 秒；逾時不等於後端失敗。', '',
    '## 實測與比較','',
    '| 流程/人數 | 版本 | N | Mean ms | P50 ms | P95 ms | Max ms | 原請求成功率 | 逾時率 | 最終確認率 | UNKNOWN |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...comparison.map(r=>`| ${r.group} | ${r.version} | ${r.n} | ${r.meanMs.toFixed(0)} | ${r.p50Ms.toFixed(0)} | ${r.p95Ms.toFixed(0)} | ${r.maximumMs.toFixed(0)} | ${(r.successRate*100).toFixed(1)}% | ${(r.timeoutRate*100).toFixed(1)}% | ${(r.finalConfirmationRate*100).toFixed(1)}% | ${r.unknown} |`),
    '', 'P95/最大等待若含 30 秒 timeout，為截尾觀察，不是真正後端尾端完成時間。Before/After 輪數、Sheet 歷史資料量、冷啟動與 Google 服務波動不同，不能把所有差異都歸因於程式。',
    'Uniform、Clustered、Field 為不同到達模型；同步 20/30/40 為極端情境，不能直接推估現場失敗率。field50 的 50 是總跑者，不是允許 50 筆同時 HTTP；仍硬性限制最多 40 個 in-flight runner。', '',
    ...(state.runners.length?['![P50/P95](latency.svg)','![正常分配成功率](success.svg)','![等待分布](distribution.svg)']:['沒有 POST 實測樣本，不生成模擬圖表。']), '',
    `後端可關聯樣本：${metrics.length}；${metrics.length?'已取得後端診斷，見 backend.csv；未匹配的請求仍未量測。':'Lock Wait/Held、Sheets 讀寫：未量測，沒有用 HTTP 耗時冒充後端時間。'}`,
    ...(metrics.length?['![Lock wait/held](lock.svg)']:[]), '',
    '## 功能與資料一致性','',...(state.functional||[]).map(c=>`- ${c.check}：${c.passed?'PASS':'FAIL'}`),
    `- Google Sheets 核對：${audit.status}；${audit.note||''}`,...audit.issues.map(i=>`- ${i}`),
    '- 遠端庫存不足、管理員補貨與抽獎並行：不會主動調整共用正式管理員庫存；若未提供對應證據，仍未驗證。',
    '- 本機 fault-injection/互斥替身測試不等於真實 Google 並行驗收。正式資料是否未變，須由授權維護者前後比對；工具沒有正式表讀取權限。', '',
    '## 到達、處理量與排隊','',
    'schedule.csv 記錄規劃與實際開始、queueDelayMs；http.csv 記錄每筆真正 HTTP 開始。per-second.csv 為逐秒 POST 到達數、成功完成數及邏輯 HTTP in-flight；runners.csv 保留全流程等待與 recovery 最終結果。',
    '請用不同密度情境的 P50/P95/timeout 及實際 POST 到達分布判斷排隊起點，不由排程人數單獨下結論。',
    state.retainUnknown?'本輪依使用者明確授權保留 UNKNOWN 後續測；未知不代表未寫入或成功，配額／契約／庫存不足仍停止。未完成後端／Sheets 驗收，不授權極端同步尖峰。':
      state.continueJitter?'本輪依使用者指示完成 Jitter 情境，延遲或已恢復成功的 timeout 不單獨中止；配額、契約錯誤、庫存不足及 UNKNOWN 仍停止。後端／Sheets 核對未完成，不授權極端同步尖峰。':
      state.continueSync10?'本輪依使用者新指示，已恢復成功的 timeout 與延遲不單獨阻止完成十人組；配額、契約錯誤及無法確認的最終狀態仍停止。工作表核對仍延後，不構成第二階段整體驗收或第三階段授權。':
      state.recordAuditDeferred?'本輪依使用者明確指示延後工作表／執行日誌核對，只執行第二階段 HTTP 效能測試；不代表資料一致性或第二階段整體驗收通過，也不授權第三階段。逾時／配額／異常延遲的停止條件仍保留。':
      '當資料一致性未驗證、功能失敗或存在 timeout／配額／異常延遲時，不得自動升載或進入下一階段。', ''].join('\n');
  await writeFile(resolve(folder,'performance.md'),text);
}

export async function main(argv=process.argv.slice(2)){
  const opts=options(argv);
  if(opts.analyze){const folder=resultFolder(opts.analyze);const state=JSON.parse(await readFile(resolve(folder,'run.json'),'utf8'));await report(state,folder,opts);console.log(folder);return;}
  const s=SCENARIOS[opts.scenario],workflows=opts.workflow?[opts.workflow]:s.workflows||['post','flow'];
  const apiUrl=assertDemo(await configuredUrl(),await configuredUrl());
  const plannedPosts=s.shape==='functional'?5:s.count*(s.rounds-opts.startRound+1)*workflows.length;
  console.log(JSON.stringify({scenario:opts.scenario,apiUrl,seed:opts.seed,startRound:opts.startRound,rounds:s.rounds,workflows,continueSync10:opts['continue-sync10']===true,
    plannedPosts:opts.execute?plannedPosts:0,potentialPosts:plannedPosts,maxHttpInFlight:40,
    firstRoundSchedule:schedule(opts.scenario,opts.seed).map(p=>p.offsetMs)},null,2));
  if(!opts.execute&&!opts.preflight)return;
  const batchId=`perf-${new Date().toISOString().replace(/[-:.]/g,'')}-${randomUUID().slice(0,8)}`;
  const folder=resultFolder(batchId),state={batchId,phase:`phase${s.phase}`,scenario:opts.scenario,seed:opts.seed,startRound:opts.startRound,rounds:s.rounds,workflows,plannedPosts,continueSync10:opts['continue-sync10']===true,
    apiUrl,recordAuditDeferred:opts['defer-record-audit']===true||opts['http-only-approved']===true,httpOnlyApproved:opts['http-only-approved']===true,continueJitter:opts['continue-jitter']===true,retainUnknown:opts['retain-unknown']===true,createdAt:new Date().toISOString(),runners:[],http:[],events:[],schedule:[],cancelled:0,peakHttpInFlight:0,stopped:null,preflight:''};
  try{
    const preflight=await http(actionUrl(apiUrl,'getPublicCampaignStatus'));
    state.http.push(publicRecord(preflight,{batchId},'preflight'));
    state.preflight=validStatus(preflight)?'PASS: Demo/schema verified':'FAIL';
    if(!validStatus(preflight)){state.stopped='DEMO_PREFLIGHT_FAILED';throw Object.assign(new Error('Demo preflight failed'),{code:'DEMO_PREFLIGHT_FAILED'});}
    if(!opts.execute)return;
    if(s.shape==='functional'){await functional(apiUrl,state,makePayload(`load-${batchId}`,2));return;}
    for(const workflow of workflows)for(let round=opts.startRound;round<=s.rounds;round++){
      if(state.stopped)break;
      let activeHttp=0;
      const plan=schedule(opts.scenario,opts.seed,round);
      const heartbeat=setInterval(()=>console.log(`${opts.scenario}/${workflow} 第 ${round} 輪進度：${state.runners.filter(r=>r.workflow===workflow&&r.round===round).length}/${plan.length}，HTTP in-flight=${activeHttp}`),30000);
      let dispatched;
      try { dispatched=await dispatch(plan,async(item,timing)=>{
        const p=makePayload(`load-${batchId}`,item.index+round),meta={requestId:p.requestId,batchId,concurrency:s.count,round,workflow};
        await mkdir(folder,{recursive:true});
        // Durable write-ahead ID record, before any HTTP (no full payload).
        const { appendFile }=await import('node:fs/promises');
        await appendFile(resolve(folder,'attempts.jsonl'),JSON.stringify({...meta,sessionId:p.sessionId,at:new Date().toISOString()})+'\n');
        const traced=async(url,options={})=>{
          const operation=new URL(url).searchParams.get('action')||'submit';
          activeHttp++;state.peakHttpInFlight=Math.max(state.peakHttpInFlight,activeHttp);
          state.events.push({at:new Date().toISOString(),type:'start',operation,requestId:p.requestId,round,workflow});
          try{return await http(url,options);}
          finally{activeHttp--;state.events.push({at:new Date().toISOString(),type:'end',operation,requestId:p.requestId,round,workflow});}
        };
        const r=await runner(apiUrl,p,meta,workflow,state.http,traced);
        Object.assign(r,timing);state.runners.push(r);
        state.schedule.push({...meta,...timing});
        state.events.push({at:new Date().toISOString(),type:'complete',requestId:p.requestId,round,workflow,ok:r.ok,allocationStatus:r.allocationStatus});
        return {record:r,payload:p};
      },{shouldStop:item=>dispatchStopReason(item.record,state.continueSync10||state.continueJitter)}); }
      finally {clearInterval(heartbeat);}
      state.stopped ||= dispatched.stopped;state.cancelled+=dispatched.cancelled.length;
      for(const index of dispatched.cancelled)state.schedule.push({batchId,workflow,round,index,cancelled:true,scheduledOffsetMs:plan[index].offsetMs});
      await report(state,folder,{});
      await recover(apiUrl,dispatched.records.map(p=>[p.record,p.payload]),state);
      if(opts['collect-timing'])for(const {record,payload} of dispatched.records){
        if(!record.posted||Number.isFinite(record.backend_totalMs))continue;
        const timing=await http(actionUrl(apiUrl,'getDemoRequestTiming',payload));
        state.http.push(publicRecord(timing,{requestId:payload.requestId,batchId,workflow,round,concurrency:s.count},'diagnostics'));
      }
      if(state.runners.some(r=>r.finalState==='UNKNOWN')&&!state.retainUnknown)state.stopped ||= 'BACKEND_FINAL_STATE_UNKNOWN';
      const pids=state.runners.filter(r=>r.participantId).map(r=>r.participantId);
      if(new Set(pids).size!==pids.length)state.stopped ||= 'DUPLICATE_PARTICIPANT_RESPONSE';
      if(!state.stopped){
        const health=await http(actionUrl(apiUrl,'getPublicCampaignStatus'));
        state.http.push(publicRecord(health,{batchId,workflow,round},'health'));
        if(!validStatus(health))state.stopped='HEALTH_CHECK_FAILED';
      }
      await report(state,folder,{});
      console.log(`${opts.scenario}/${workflow} 第 ${round} 輪：${state.stopped||'完成'}`);
      if(!state.stopped)await delay(10000);
    }
  }catch(e){state.stopped ||= e.code||'LOCAL_TEST_ERROR';}
  finally{await report(state,folder,opts);console.log(folder);if(state.stopped)process.exitCode=1;}
  return {state,folder};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
