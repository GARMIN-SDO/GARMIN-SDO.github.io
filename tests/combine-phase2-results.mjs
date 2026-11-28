// Offline only: combine completed Phase 2 performance batches, never issue HTTP.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { report } from './demo-performance-test.mjs';
import { SCENARIOS } from './demo-traffic.mjs';

export function combineStates(states) {
  if(!states.length||states.some(s=>s.phase!=='phase2'||!['post-single','flow-single','sync10'].includes(s.scenario)||
    !s.preflight?.startsWith('PASS:')||s.apiUrl!==states[0].apiUrl)) throw new Error('INVALID_PHASE2_BATCHES');
  const runners=states.flatMap(s=>s.runners);
  if(new Set(runners.map(r=>r.requestId)).size!==runners.length) throw new Error('DUPLICATE_REQUEST_IDS');
  const sync=runners.filter(r=>r.workflow==='post'&&r.concurrency===10);
  const completedSync=[1,2,3].every(round=>sync.filter(r=>r.round===round).length===10)&&
    sync.every(r=>r.finalState==='allocated'||r.finalState==='RECOVERED_ALLOCATED');
  const historicalStops=states.filter(s=>states.some(b=>b.continueSync10)&&completedSync&&s.scenario==='sync10'&&
    ['ABNORMAL_LATENCY_25S','TIMEOUT'].includes(s.stopped));
  const planned=new Set();
  for(const s of states){
    const workflows=s.workflows||[...new Set(s.runners.map(r=>r.workflow).filter(Boolean))];
    for(const workflow of workflows)for(let round=s.startRound||1;round<=SCENARIOS[s.scenario].rounds;round++)
      for(let i=0;i<SCENARIOS[s.scenario].count;i++)planned.add(`${s.scenario}/${workflow}/${round}/${i}`);
  }
  return {batchId:`perf-phase2-${new Date().toISOString().replace(/[-:.]/g,'')}-${randomUUID().slice(0,8)}`,
    phase:'phase2',scenario:'phase2-http-summary',createdAt:new Date().toISOString(),apiUrl:states[0].apiUrl,
    seed:states[0].seed,rounds:'單人10、十人同步3',plannedPosts:planned.size,
    continueSync10:states.some(s=>s.continueSync10),historicalStops:historicalStops.map(s=>({batchId:s.batchId,reason:s.stopped})),
    recordAuditDeferred:states.some(s=>s.recordAuditDeferred),preflight:'PASS: 來源批次已通過，本次僅合併本機資料',
    runners,http:states.flatMap(s=>s.http),events:states.flatMap(s=>s.events),schedule:states.flatMap(s=>s.schedule),
    cancelled:states.reduce((n,s)=>n+s.cancelled,0),peakHttpInFlight:Math.max(...states.map(s=>s.peakHttpInFlight)),
    stopped:states.find(s=>s.stopped&&!historicalStops.includes(s))?.stopped||null,
    sourceBatches:states.map(s=>({batchId:s.batchId,scenario:s.scenario,samples:s.runners.length,stopped:s.stopped}))};
}

export async function main(names=process.argv.slice(2)) {
  if(!names.length||names.some(n=>!/^perf-[A-Za-z0-9-]+$/.test(n))) throw new Error('Provide perf-* directory names');
  const root=fileURLToPath(new URL('../test-results/',import.meta.url));
  const states=await Promise.all(names.map(n=>readFile(resolve(root,n,'run.json'),'utf8').then(JSON.parse)));
  const merged=combineStates(states),folder=resolve(root,merged.batchId);
  await report(merged,folder,{before:resolve(root,'combined-20261127T015730562Z')});
  console.log(folder);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
