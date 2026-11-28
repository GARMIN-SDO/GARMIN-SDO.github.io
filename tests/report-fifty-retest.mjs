// Local-only report update. Never imports or calls the network transport.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../test-results/',import.meta.url));
const reportFolder=resolve(root,'regression-20261128T085636');
const begin='<!-- FIFTY_RETEST_BEGIN -->',end='<!-- FIFTY_RETEST_END -->';
const quantile=(values,p)=>{const a=[...values].sort((a,b)=>a-b);return a.length?a[Math.ceil(a.length*p)-1]:null;};
const average=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
const csv=rows=>{const keys=[...new Set(rows.flatMap(Object.keys))],cell=v=>`"${String(v??'').replaceAll('"','""')}"`;
  return [keys,...rows.map(r=>keys.map(k=>r[k]))].map(r=>r.map(cell).join(',')).join('\n')+'\n';};
const seconds=value=>Number.isFinite(value)?(value/1000).toFixed(2):'未量測';

export function summarizeRetest(state, round=null){
  if(state.scenario!=='uniform50-10'||state.seed!==20261127||state.workflows?.join(',')!=='flow')throw new Error('RETEST_SCOPE_MISMATCH');
  const runners=state.runners.filter(r=>round===null||r.round===round),ids=new Set(runners.map(r=>r.requestId));
  if(ids.size!==runners.length)throw new Error('DUPLICATE_RUNNER_ID');
  if(state.peakHttpInFlight>40)throw new Error('CLIENT_CAP_EXCEEDED');
  const http=state.http.filter(r=>ids.has(r.requestId)),posts=http.filter(r=>r.operation==='submit');
  if(new Set(posts.map(r=>r.requestId)).size!==posts.length)throw new Error('REPEATED_POST');
  const timing=http.filter(r=>Number.isFinite(r.backend_totalMs)),held=timing.filter(r=>r.backend_lockHeldMs>0);
  const codes=new Map(timing.map(r=>[r.requestId,r.backend_code]));
  const times=runners.map(r=>r.durationMs),scheduled=runners.map(r=>r.durationMs+(r.queueDelayMs||0));
  const spreads=[1,2,3].map(n=>posts.filter(r=>r.round===n).map(r=>Date.parse(r.startedAt)).filter(Number.isFinite))
    .filter(times=>times.length).map(times=>Math.max(...times)-Math.min(...times));
  const healthyRounds=new Set(state.http.filter(r=>r.operation==='health'&&r.ok&&(round===null||r.round===round)).map(r=>r.round));
  const health=healthyRounds.size;
  const roundsComplete=(round===null?[1,2,3]:[round]).every(r=>healthyRounds.has(r)&&runners.filter(x=>x.round===r).length===50);
  return {batchId:state.batchId,round:round??'all',samples:runners.length,planned:round===null?150:50,
    originalAllocated:runners.filter(r=>r.ok&&r.allocationStatus==='allocated').length,
    recoveredAllocated:runners.filter(r=>r.finalState==='RECOVERED_ALLOCATED').length,
    finalAllocated:runners.filter(r=>['allocated','RECOVERED_ALLOCATED'].includes(r.finalState)).length,
    originalPaused:runners.filter(r=>r.ok&&r.allocationStatus==='paused').length,
    finalPaused:runners.filter(r=>['paused','RECOVERED_PAUSED'].includes(r.finalState)).length,
    timeout:runners.filter(r=>r.timeout).length,unknown:runners.filter(r=>r.finalState==='UNKNOWN').length,
    notSubmitted:runners.filter(r=>r.finalState==='NOT_SUBMITTED').length,
    unknownLockBusy:runners.filter(r=>r.finalState==='UNKNOWN'&&codes.get(r.requestId)==='LOCK_BUSY').length,
    backendLockBusy:timing.filter(r=>r.backend_code==='LOCK_BUSY').length,
    httpLockBusy:http.filter(r=>r.errorCode==='LOCK_BUSY').length,
    quota:http.filter(r=>r.errorCode==='QUOTA_OR_EXECUTION_LIMIT').length,
    postCount:posts.length,recoveryGetCount:http.filter(r=>r.operation==='recovery').length,
    timingSamples:timing.length,meanMs:average(times),p50Ms:quantile(times,.5),p95Ms:quantile(times,.95),
    p95WithClientQueueMs:quantile(scheduled,.95),maxClientQueueMs:Math.max(0,...runners.map(r=>r.queueDelayMs||0)),
    lastFlowStartOffsetMs:Math.max(0,...runners.map(r=>r.actualOffsetMs||0)),
    maxRoundPostStartSpreadMs:spreads.length?Math.max(...spreads):null,
    meanLockWaitMs:average(timing.map(r=>r.backend_lockWaitMs)),meanLockHeldWhenAcquiredMs:average(held.map(r=>r.backend_lockHeldMs)),
    meanRequestLookupMs:average(timing.map(r=>r.backend_requestLookupMs)),meanReadMs:average(timing.map(r=>r.backend_sheetReadMs)),
    meanWriteMs:average(timing.map(r=>r.backend_sheetWriteMs)),
    meanFlushMs:average(timing.filter(r=>Number.isFinite(r.backend_sheetFlushMs)).map(r=>r.backend_sheetFlushMs)),
    clientPeak:state.peakHttpInFlight,healthCompleted:health,stop:state.stopped||'',
    complete:runners.length===(round===null?150:50)&&roundsComplete&&!state.stopped};
}

export async function main(args=process.argv.slice(2)){
  const batch=args.find(v=>!v.startsWith('--')),final=args.includes('--final');
  if(!/^perf-[A-Za-z0-9-]+$/.test(batch||'')||args.some(v=>v.startsWith('--')&&v!=='--final'))throw new Error('PROVIDE_RETEST_BATCH');
  const state=JSON.parse(await readFile(resolve(root,batch,'run.json'),'utf8'));
  const summary=summarizeRetest(state),rounds=[1,2,3].map(r=>summarizeRetest(state,r));
  if(final&&!summary.complete&&!summary.stop)throw new Error('RETEST_NOT_COMPLETE');
  await writeFile(resolve(reportFolder,'fifty-retest-summary.csv'),csv([summary]));
  await writeFile(resolve(reportFolder,'fifty-retest-rounds.csv'),csv(rounds));
  const rate=(a,n)=>n?`${a}/${n}（${(100*a/n).toFixed(1)}%）`:'尚未執行';
  const line=r=>`| ${r.round} | ${r.samples}/${r.planned} | ${rate(r.originalAllocated,r.samples)} | ${rate(r.finalAllocated,r.samples)} | ${r.originalPaused}/${r.finalPaused} | ${r.timeout} | ${r.unknown} | ${seconds(r.p50Ms)}／${seconds(r.p95Ms)} |`;
  const block=[begin,'## 更新庫存後：50 人／10 秒獨立重測','',
    `批次：${batch}；執行起點UTC：${state.createdAt}。使用者表示已手動更新Demo庫存；本代理沒有重設/補庫存，也沒有讀取正式表。`,
    `狀態：${summary.complete?'三輪完成':summary.stop?'因 '+summary.stop+' 中止':'測試及有限確認進行中'}。${final?'本次執行與查詢已結束，沒有本批背景測試繼續執行。':''}`,
    '舊50人缺獎批次43筆保留於下方歷史報告，不與本批合併成193筆或當成同一三輪。新批沿用seed20261127、Flow GET15秒→POST30秒、50人分散排定10秒內、客戶端同時上限40。','',
    '| 輪次 | 已啟動/計畫 | 原請求取得獎品 | 復原後確認allocated | 原/最終paused | Timeout | UNKNOWN | P50／P95秒 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',...rounds.map(line),line(summary),'',
    `可關聯後端計時 ${summary.timingSamples}/${summary.samples}；平均等鎖 ${seconds(summary.meanLockWaitMs)} 秒，取得鎖者平均Held ${seconds(summary.meanLockHeldWhenAcquiredMs)} 秒；HTTP直接LOCK_BUSY ${summary.httpLockBusy}，診斷LOCK_BUSY ${summary.backendLockBusy}，UNKNOWN中診斷確認LOCK_BUSY ${summary.unknownLockBusy}。診斷不回填原HTTP成功。`,
    `客戶端實測in-flight峰值 ${summary.clientPeak}（上限40）；最長測試端排隊 ${seconds(summary.maxClientQueueMs)} 秒，最後Flow啟動偏移 ${seconds(summary.lastFlowStartOffsetMs)} 秒，單輪POST實際開始時間最大離散 ${seconds(summary.maxRoundPostStartSpreadMs)} 秒，含測試端排隊P95 ${seconds(summary.p95WithClientQueueMs)} 秒。50人排程不保證所有POST在10秒內到達，實際POST/逐秒到達見原批次CSV。`,
    `POST次數 ${summary.postCount}，正常跑者同一ID最多一次POST（產報時已檢查）；後續GET查回共 ${summary.recoveryGetCount} 次，不重新分配。原請求成功率與結果復原分開，UNKNOWN定義及LOCK_BUSY取證邏輯沿用下方說明。`,
    ...(summary.complete?[`本批結論：原請求成功 ${rate(summary.originalAllocated,summary.samples)}，復原新增 ${summary.recoveredAllocated} 筆，缺獎結果 ${summary.finalPaused} 筆；UNKNOWN ${summary.unknown} 筆，其中 ${summary.unknownLockBusy} 筆有LOCK_BUSY診斷。未出現缺獎不等於並行瓶頸已改善，應依平均等鎖與持鎖時間繼續分析。`]:[]),
    '庫存前後五表快照未提供；不能由HTTP或使用者補庫存訊息證明庫存一致性通過。原20人／10秒結果仍為43/60（71.7%），85%／90%目標未達；50人重測不替代20人驗收。','',
    `[本批明細](../${batch}/performance.md) · [本批統計](fifty-retest-summary.csv) · [逐輪統計](fifty-retest-rounds.csv) · [實際到達/完成](../${batch}/per-second.csv) · [測試端排隊](../${batch}/schedule.csv)`,'',end,''];
  const file=resolve(reportFolder,'REPORT.md');let report=await readFile(file,'utf8');
  if(report.includes(begin))report=report.slice(0,report.indexOf(begin))+block.join('\n')+report.slice(report.indexOf(end)+end.length);
  else {const pos=report.indexOf('\n')+1;report=report.slice(0,pos)+'\n'+block.join('\n')+'\n## 更新庫存前的歷史報告（以下資料保留，未合併新批）\n\n'+report.slice(pos);}
  await writeFile(file,report);console.log(JSON.stringify(summary));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
