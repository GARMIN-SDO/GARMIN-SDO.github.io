import { setTimeout as delay } from 'node:timers/promises';

export const SCENARIOS = Object.freeze({
  functional: { phase: 2, count: 1, rounds: 1, shape: 'functional', workflows: ['post'] },
  'post-single': { phase: 2, count: 1, rounds: 10, shape: 'sync', workflows: ['post'] },
  'flow-single': { phase: 2, count: 1, rounds: 10, shape: 'sync', workflows: ['flow'] },
  sync10: { phase: 2, count: 10, rounds: 3, shape: 'sync' },
  'uniform10-10': { phase: 3, count: 10, rounds: 3, shape: 'uniform', windowMs: 10000 },
  'uniform20-10': { phase: 3, count: 20, rounds: 3, shape: 'uniform', windowMs: 10000 },
  'uniform20-20': { phase: 3, count: 20, rounds: 3, shape: 'uniform', windowMs: 20000 },
  'uniform20-30': { phase: 3, count: 20, rounds: 3, shape: 'uniform', windowMs: 30000 },
  clustered20: { phase: 3, count: 20, rounds: 3, shape: 'clustered' },
  'field50-240': { phase: 3, count: 50, rounds: 3, shape: 'field', windowMs: 240000 },
  sync20: { phase: 3, count: 20, rounds: 3, shape: 'sync', extreme: true },
  sync30: { phase: 3, count: 30, rounds: 3, shape: 'sync', extreme: true },
  sync40: { phase: 3, count: 40, rounds: 3, shape: 'sync', extreme: true }
});

export function schedule(name, seed, round = 1) {
  const s = SCENARIOS[name];
  if (!s || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('INVALID_SCENARIO_OR_SEED');
  let x = (seed + round * 0x9e3779b9) >>> 0;
  const random = () => { x = (x + 0x6d2b79f5) >>> 0; let t = Math.imul(x ^ x >>> 15, x | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const burst = () => [ [8,0,1000], [7,3000,5000], [5,7000,10000] ].flatMap(([n,a,b]) => Array.from({length:n},()=>Math.round(a+random()*(b-a))));
  let offsets;
  if (s.shape === 'uniform') offsets = Array.from({length:s.count},()=>Math.round(random()*s.windowMs));
  else if (s.shape === 'clustered') offsets = burst();
  else if (s.shape === 'field') offsets = [0,240000,...Array.from({length:28},()=>Math.round(random()*240000)),...burst().map(t=>t+120000)];
  else offsets = Array(s.count).fill(0);
  return offsets.sort((a,b)=>a-b).map((offsetMs,index)=>({index,offsetMs}));
}

// Abort scheduled arrivals after a failure, but never abort requests already sent.
export async function dispatch(plan, run, { maxInFlight = 40, shouldStop = () => null,
  now = () => performance.now(), wait = (ms,signal) => delay(ms,undefined,{signal}) } = {}) {
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 40) throw new Error('MAX_IN_FLIGHT_EXCEEDED');
  const start = now(), arrivals = new AbortController(), waiting = [];
  let active = 0, peak = 0, stopped = null;
  const records = [], cancelled = [];
  await Promise.allSettled(plan.map(async item => {
    try { await wait(Math.max(0,start+item.offsetMs-now()),arrivals.signal); }
    catch (e) { if (!arrivals.signal.aborted) { stopped ||= 'LOCAL_TIMER_ERROR'; arrivals.abort(); } }
    while (!stopped && active >= maxInFlight) await new Promise(resolve=>waiting.push(resolve));
    if (stopped) { cancelled.push(item.index); return; }
    active++; peak=Math.max(peak,active);
    try {
      const actualOffsetMs=now()-start;
      const record=await run(item, { scheduledOffsetMs:item.offsetMs, actualOffsetMs,
        queueDelayMs:Math.max(0,actualOffsetMs-item.offsetMs), runnersInFlightAtStart:active });
      records.push(record);
      const reason=shouldStop(record);
      if(reason && !stopped) {stopped=reason;arrivals.abort();}
    } catch (e) {
      stopped ||= 'LOCAL_RUNNER_ERROR'; arrivals.abort();
      cancelled.push(item.index);
    } finally { active--; waiting.splice(0).forEach(resolve=>resolve()); }
  }));
  return { records, cancelled, peakInFlight:peak, stopped };
}

// Logical HTTP in-flight and POST arrivals/completions, per UTC second.
export function perSecond(events) {
  if (!events.length) return [];
  const first=Math.floor(Math.min(...events.map(e=>Date.parse(e.at)))/1000);
  const last=Math.floor(Math.max(...events.map(e=>Date.parse(e.at)))/1000);
  let active=0;
  return Array.from({length:last-first+1},(_,i)=>{
    const group=events.filter(e=>Math.floor(Date.parse(e.at)/1000)===first+i).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
    let peak=active;
    for(const e of group){ active+=e.type==='start'?1:e.type==='end'?-1:0; peak=Math.max(peak,active); }
    return { secondUtc:new Date((first+i)*1000).toISOString(),
      arrivals:group.filter(e=>e.type==='start'&&e.operation==='submit').length,
      completions:group.filter(e=>e.type==='complete'&&e.ok&&e.allocationStatus==='allocated').length,
      peakHttpInFlight:peak, httpInFlightAtEnd:active };
  });
}
