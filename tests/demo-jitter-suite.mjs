// A bounded, sequential HTTP-only suite; no deployments or Sheets access.
import { readFile, writeFile, mkdir, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { main as runScenario } from './demo-performance-test.mjs';
import { SCENARIOS, perSecond, schedule } from './demo-traffic.mjs';
import { quantile } from './demo-concurrency-test.mjs';

// Lower submission density first; extreme synchronized scenarios are never included.
export const JITTER_SCENARIOS=Object.freeze(['uniform10-10','uniform20-30','uniform20-20','field50-240','clustered20','uniform20-10']);
const ROOT=fileURLToPath(new URL('../test-results/',import.meta.url));
const csv=rows=>{
  if(!rows.length)return '"status"\n"尚無資料"\n';
  const keys=[...new Set(rows.flatMap(Object.keys))],cell=v=>`"${String(v??'').replaceAll('"','""')}"`;
  return [keys,...rows.map(r=>keys.map(k=>r[k]))].map(r=>r.map(cell).join(',')).join('\n')+'\n';
};

export function summary(states){
  const groups=[...Map.groupBy(states.flatMap(s=>s.runners.map(r=>({...r,scenario:s.scenario}))),r=>`${r.scenario}/${r.workflow}`).values()];
  return groups.map(rows=>{
    const scenario=rows[0].scenario,workflow=rows[0].workflow,sources=states.filter(s=>s.scenario===scenario);
    const ok=rows.filter(r=>r.ok&&r.allocationStatus==='allocated'),ts=rows.map(r=>r.durationMs);
    const ids=new Set(rows.map(r=>r.requestId)),http=sources.flatMap(s=>s.http).filter(r=>ids.has(r.requestId));
    const rates=[...Map.groupBy(sources.flatMap(s=>s.events||[]).filter(e=>e.workflow===workflow),e=>e.round).values()].flatMap(perSecond);
    return {scenario,workflow,runnersPerRound:SCENARIOS[scenario].count,
      roundsCompleted:[...new Set(rows.map(r=>r.round))].filter(n=>rows.filter(r=>r.round===n).length===SCENARIOS[scenario].count).length,
      samples:rows.length,success:ok.length,successRate:ok.length/rows.length,timeouts:rows.filter(r=>r.timeout).length,
      timeoutRate:rows.filter(r=>r.timeout).length/rows.length,recovered:rows.filter(r=>r.finalState==='RECOVERED_ALLOCATED').length,
      unknown:rows.filter(r=>r.finalState==='UNKNOWN').length,meanMs:ts.reduce((a,b)=>a+b,0)/ts.length,
      p50Ms:quantile(ts,.5),p90Ms:quantile(ts,.9),p95Ms:quantile(ts,.95),p99Ms:quantile(ts,.99),maxMs:Math.max(...ts),
      lockBusy:http.filter(r=>r.errorCode==='LOCK_BUSY').length,quotaErrors:http.filter(r=>r.errorCode==='QUOTA_OR_EXECUTION_LIMIT').length,
      peakPostArrivalsPerSecond:Math.max(0,...rates.map(r=>r.arrivals)),peakSuccessfulCompletionsPerSecond:Math.max(0,...rates.map(r=>r.completions)),
      peakLogicalHttpInFlight:Math.max(0,...rates.map(r=>r.peakHttpInFlight)),
      lockWait:'未量測',lockHeld:'未量測',inventoryConsistency:'未驗證',batchStopHistory:[...new Set(sources.map(s=>s.stopped).filter(Boolean))].join(';')};
  });
}

export function pendingJobs(states){
  const jobs=[];
  for(const scenario of JITTER_SCENARIOS)for(const workflow of ['post','flow']){
    const n=SCENARIOS[scenario].count,rows=states.filter(s=>s.scenario===scenario).flatMap(s=>s.runners).filter(r=>r.workflow===workflow);
    const counts=[1,2,3].map(round=>rows.filter(r=>r.round===round).length);
    if(counts.some(c=>c!==0&&c!==n))throw new Error('PARTIAL_ROUND_REQUIRES_MANUAL_PLAN');
    const first=counts.indexOf(0);
    if(first<0)continue;
    if(counts.slice(first).some(c=>c!==0))throw new Error('NONCONTIGUOUS_ROUNDS');
    jobs.push({scenario,workflow,startRound:first+1,posts:n*(3-first)});
  }
  return jobs;
}

export async function saveSuite(suite,folder){
  const states=await Promise.all(suite.batches.map(b=>readFile(resolve(b.folder,'run.json'),'utf8').then(JSON.parse)));
  const sums=summary(states),runners=states.flatMap(s=>s.runners.map(r=>({scenario:s.scenario,...r}))),
    http=states.flatMap(s=>s.http.map(r=>({scenario:s.scenario,...r})));
  if(new Set(runners.map(r=>r.requestId)).size!==runners.length)throw new Error('DUPLICATE_RUNNER_ID');
  await mkdir(folder,{recursive:true});
  await writeFile(resolve(folder,'suite.json'),JSON.stringify(suite,null,2));
  await writeFile(resolve(folder,'summary.csv'),csv(sums));
  await writeFile(resolve(folder,'runners.csv'),csv(runners));
  await writeFile(resolve(folder,'http.csv'),csv(http));
  const rates=states.flatMap(s=>[...Map.groupBy(s.events,e=>`${e.workflow}/${e.round}`).values()].flatMap(g=>perSecond(g).map(r=>({scenario:s.scenario,workflow:g[0].workflow,round:g[0].round,...r}))));
  await writeFile(resolve(folder,'per-second.csv'),csv(rates));
  if(rates.length){
    const panels=[...Map.groupBy(rates,r=>`${r.scenario}/${r.workflow}/${r.round}`).entries()];
    const plots=panels.map(([name,g],i)=>{
      const ox=(i%3)*400,oy=Math.floor(i/3)*185,max=Math.max(1,...g.flatMap(r=>[r.arrivals,r.completions]));
      const path=key=>g.map((r,j)=>`${j?'L':'M'}${ox+35+j/Math.max(1,g.length-1)*335},${oy+145-r[key]/max*105}`).join(' ');
      return `<text x="${ox+15}" y="${oy+20}" font-size="12">${name}</text><path d="M${ox+35} ${oy+40}V${oy+145}H${ox+370}" fill="none" stroke="#666"/><text x="${ox+3}" y="${oy+44}" font-size="11">${max}/s</text><text x="${ox+30}" y="${oy+165}" font-size="11">0</text><text x="${ox+325}" y="${oy+165}" font-size="11">${g.length-1}s</text><path d="${path('arrivals')}" fill="none" stroke="#176b91"/><path d="${path('completions')}" fill="none" stroke="#b45a00"/>`;
    }).join('');
    await writeFile(resolve(folder,'arrival-completion.svg'),`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${35+Math.ceil(panels.length/3)*185}"><rect width="100%" height="100%" fill="white"/><text x="15" y="20" font-size="14">Actual POST arrivals (blue) / immediate successful completions (orange), per second; each panel one round</text><g transform="translate(0,35)">${plots}</g></svg>`);
  }
  const chart=(kind)=>{
    const vals=sums.map(s=>kind==='rate'?s.successRate*100:s.p95Ms/1000),max=kind==='rate'?100:Math.max(1,...vals);
    const height=85+sums.length*42;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1050" height="${height}"><rect width="100%" height="100%" fill="white"/><text x="20" y="23" font-size="16">${kind==='rate'?'Immediate allocation success (%)':'P50 blue / P95 orange (seconds; POST timeout 30s, Flow includes GET)'}</text>${sums.map((s,i)=>{const y=50+i*42;return `<text x="15" y="${y+12}" font-size="13">${s.scenario}/${s.workflow}</text>`+(kind==='rate'?`<rect x="240" y="${y}" width="${s.successRate*650}" height="15" fill="#176b91"/>`:[s.p50Ms,s.p95Ms].map((v,j)=>`<rect x="240" y="${y+j*12}" width="${v/1000/max*650}" height="10" fill="${j?'#b45a00':'#176b91'}"/>`).join(''))+`<text x="900" y="${y+12}" font-size="12">${kind==='rate'?(s.successRate*100).toFixed(1)+'%':(s.p50Ms/1000).toFixed(2)+' / '+(s.p95Ms/1000).toFixed(2)}</text>`;}).join('')}</svg>`;
  };
  if(sums.length){await writeFile(resolve(folder,'latency.svg'),chart('latency'));await writeFile(resolve(folder,'success.svg'),chart('rate'));}
  const completedScenarios=JITTER_SCENARIOS.filter(name=>['post','flow'].every(workflow=>sums.some(s=>s.scenario===name&&s.workflow===workflow&&s.roundsCompleted===3)));
  const complete=completedScenarios.length===JITTER_SCENARIOS.length&&!suite.stopped;
  const lines=['# Garmin Run｜完整 Jitter HTTP 測試彙整','',`Suite：${suite.suiteId}；UTC：${suite.createdAt}；seed：${suite.seed}`,
    `狀態：${complete?'六情境全部完成':suite.stopped?'安全條件停止':'執行中'}；停止原因：${suite.stopped||'無'}。`,
    `已執行情境 ${new Set(suite.batches.map(b=>b.scenario)).size}/6；完整執行六輪的情境 ${completedScenarios.length}/6；已觀察跑者 ${runners.length}；計畫最多 840 POST。`,
    ...(suite.retainUnknown?['使用者明確授權將 UNKNOWN 原樣保留並繼續；不是把未知改成成功／失敗。原中斷批次及停止原因保留，不重跑已完成輪次。']:[]),
    '只使用既有 Demo API；POST 30 秒、GET 15 秒。兩種流程分開，各三輪；各情境依序執行，不相互搶鎖。', '',
    '| 情境 | 流程 | 執行輪數 | N | 成功率 | 逾時率 | Mean 秒 | P50 秒 | P95 秒 | 恢復成功 | 未知 |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...sums.map(s=>`| ${s.scenario} | ${s.workflow} | ${s.roundsCompleted}/3 | ${s.samples} | ${(s.successRate*100).toFixed(1)}% | ${(s.timeoutRate*100).toFixed(1)}% | ${(s.meanMs/1000).toFixed(2)} | ${(s.p50Ms/1000).toFixed(2)} | ${(s.p95Ms/1000).toFixed(2)} | ${s.recovered} | ${s.unknown} |`), '',
    ...(sums.length?['![P50/P95](latency.svg)','![正常分配成功率](success.svg)']:[]),
    ...(rates.length?['[所有輪次每秒實際到達／完成量圖](arrival-completion.svg)']:[]), '',
    '## 判讀與限制','',
    '- POST timeout 的等待為約 30 秒截尾值；Flow 合計另含 GET，可能超過 30 秒。這不是後端真正完成時間；recovery 成功不回填原請求即時成功。',
    '- 後端時間及庫存一致性依使用者要求暫緩，未量測／未驗證；不把 HTTP 成功當作跨表交易完整。',
    suite.retainUnknown?'- 依最新授權保留 UNKNOWN 後續測；配額、非 Demo、契約異常、庫存 paused 等仍停止。沒有重送 UNKNOWN 的 POST，未執行情境不填模擬值。':
      '- 已恢復成功的逾時／單純延遲記錄後續測；配額、非 Demo、契約異常、庫存 paused 或最終 UNKNOWN 會停止，未執行情境不填模擬值。',
    '- field50-240 是 50 位跑者於四分鐘陸續提交，包含中段尖峰，不是 50 個同時 HTTP；上限固定 40。',
    '- sync20／sync30／sync40 不在此套件內，不用極端同步數字推估現場失敗率。',
    '- P99 小樣本參考價值有限；各密度測量受執行時段、歷史表長度、庫存及 Google 服務波動影響，不能視為嚴格隨機對照。', '',
    '## 原始資料與情境報告','',
    '[每筆 HTTP](http.csv)、[每位跑者與最終狀態](runners.csv)、[完整統計](summary.csv)、[逐秒到達／完成／HTTP in-flight](per-second.csv)。',
    ...suite.batches.map(b=>`- ${b.scenario}：[情境報告](../${b.batchId}/performance.md)、[每位跑者等待分布圖](../${b.batchId}/distribution.svg)`),''];
  await writeFile(resolve(folder,'report.md'),lines.join('\n'));
  return {states,sums};
}

export async function main(argv=process.argv.slice(2)){
  const flags=new Set(argv);
  if(argv.some(a=>!['--execute','--deployment-confirmed','--off-peak-confirmed','--http-only-approved','--retain-unknown'].includes(a)&&!a.startsWith('--resume=')))throw new Error('UNKNOWN_SUITE_OPTION');
  const resume=argv.find(a=>a.startsWith('--resume='))?.slice(9);
  if(resume&&!/^jitter-suite-[A-Za-z0-9-]+$/.test(resume))throw new Error('INVALID_SUITE_NAME');
  const execute=flags.has('--execute');
  if(execute&&!['--deployment-confirmed','--off-peak-confirmed','--http-only-approved'].every(f=>flags.has(f)))throw new Error('SUITE_CONFIRMATIONS_REQUIRED');
  for(const name of JITTER_SCENARIOS)schedule(name,20261127);
  console.log(JSON.stringify({scenarios:JITTER_SCENARIOS,rounds:3,workflows:['post','flow'],seed:20261127,
    potentialPosts:840,plannedPosts:execute?(resume?'remaining rounds only; count below':840):0,maxHttpInFlight:40,extremeSyncIncluded:false},null,2));
  if(!execute)return;
  const suite=resume?JSON.parse(await readFile(resolve(ROOT,resume,'suite.json'),'utf8')):
    {suiteId:`jitter-suite-${new Date().toISOString().replace(/[-:.]/g,'')}-${randomUUID().slice(0,8)}`,createdAt:new Date().toISOString(),seed:20261127,batches:[],stopped:null};
  if(resume&&(suite.suiteId!==resume||suite.seed!==20261127||suite.batches.some(b=>!/^perf-[A-Za-z0-9-]+$/.test(b.batchId)||resolve(b.folder)!==resolve(ROOT,b.batchId))))throw new Error('INVALID_SUITE_MANIFEST');
  if(resume&&suite.stopped&&suite.stopped!=='BACKEND_FINAL_STATE_UNKNOWN')throw new Error('RESUME_BLOCKED_NON_UNKNOWN_ERROR');
  if(resume&&suite.stopped&&!flags.has('--retain-unknown'))throw new Error('UNKNOWN_RETENTION_APPROVAL_REQUIRED');
  const folder=resolve(ROOT,suite.suiteId);await mkdir(folder,{recursive:true});
  const lockPath=resolve(folder,'.runner.lock'),lock=await open(lockPath,'wx');
  try{
    const states=await Promise.all(suite.batches.map(b=>readFile(resolve(b.folder,'run.json'),'utf8').then(JSON.parse)));
    const jobs=resume?pendingJobs(states):JITTER_SCENARIOS.map(scenario=>({scenario}));
    if(suite.stopped){(suite.historicalStops||=[]).push({at:new Date().toISOString(),reason:suite.stopped});suite.stopped=null;}
    suite.retainUnknown=flags.has('--retain-unknown');
    console.log(`Remaining planned POSTs: ${resume?jobs.reduce((n,j)=>n+j.posts,0):840}`);
    await saveSuite(suite,folder);console.log(`Suite report: ${folder}`);
    for(const job of jobs){
      console.log(`開始情境 ${job.scenario}${job.workflow?'/'+job.workflow+' round '+job.startRound:''}`);
      const args=[`--scenario=${job.scenario}`,'--execute','--deployment-confirmed','--off-peak-confirmed','--http-only-approved','--continue-jitter'];
      if(job.workflow)args.push(`--workflow=${job.workflow}`,`--start-round=${job.startRound}`);
      if(suite.retainUnknown)args.push('--retain-unknown');
      const result=await runScenario(args);
      if(!result){suite.stopped='SCENARIO_DID_NOT_RETURN';await saveSuite(suite,folder);break;}
      suite.batches.push({scenario:job.scenario,batchId:result.state.batchId,folder:result.folder});
      suite.stopped=result.state.stopped;await saveSuite(suite,folder);
      if(suite.stopped)break;
    }
  }finally{await lock.close();await unlink(lockPath);}
  console.log(`Suite finished: ${folder}`);
  if(suite.stopped)process.exitCode=1;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
