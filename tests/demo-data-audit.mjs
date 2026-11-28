const TABLES = ['requests','participants','allocations','inventoryLog'];

// Sanitized snapshots only; input is never copied into reports.
export function auditSnapshots(before, after, runners) {
  const issues=[];
  for(const s of [before,after]) {
    if(s?.demoMode!==true || s.scope!=='full-demo' || !s.prizes || !TABLES.every(k=>Array.isArray(s[k])) ||
      !['cap','soft_cup','socks','arm_sleeves','shopping_bag'].every(k=>s.prizes[k])) throw new Error('INVALID_DEMO_SNAPSHOT');
    if(/"(?:name|email|phone|address|token|password|resultJson|submissionFingerprint)"\s*:/i.test(JSON.stringify(s))) throw new Error('SENSITIVE_SNAPSHOT_FIELDS_REJECTED');
  }
  const ids=new Set(runners.filter(r=>r.posted).map(r=>r.requestId));
  const known=runners.filter(r=>r.posted&&['allocated','paused','RECOVERED_ALLOCATED','RECOVERED_PAUSED'].includes(r.finalState));
  const find=(table,key,id)=>after[table].filter(r=>r[key]===id);
  if(before.requests.some(r=>ids.has(r.requestId))) issues.push('本批 ID 在 before 已存在，不是新的獨立批次');
  for(const r of known) {
    const req=find('requests','requestId',r.requestId), participants=find('participants','requestId',r.requestId);
    const alloc=find('allocations','requestId',r.requestId), allocated=['allocated','RECOVERED_ALLOCATED'].includes(r.finalState);
    if(req.length!==1||participants.length!==1) {issues.push(`${r.requestId}: Request/Participant 非單筆`);continue;}
    if(req[0].participantId!==r.participantId||req[0].sessionId!==r.sessionId||participants[0].participantId!==r.participantId||req[0].status!==(allocated?'allocated':'paused')||participants[0].allocationStatus!==(allocated?'allocated':'paused')) issues.push(`${r.requestId}: 身份/完成狀態不符`);
    if(allocated) {
      if(alloc.length!==1||alloc[0]?.allocationStatus!=='allocated'||alloc[0]?.prizeId!==r.prizeId||alloc[0]?.participantId!==r.participantId) issues.push(`${r.requestId}: Allocation 不符`);
      const inventory=alloc.flatMap(a=>find('inventoryLog','relatedAllocationId',a.allocationId));
      if(inventory.length!==1||inventory[0]?.action!=='allocation'||inventory[0]?.quantityDelta!==-1||inventory[0]?.beforeStock-inventory[0]?.afterStock!==1||inventory[0]?.prizeId!==r.prizeId||inventory[0]?.afterStock<0) issues.push(`${r.requestId}: InventoryLog 不符`);
    } else if(alloc.length) issues.push(`${r.requestId}: paused 卻有分配`);
    if(participants[0].prizeId!==(allocated?r.prizeId:'')) issues.push(`${r.requestId}: Participant 獎品不符`);
  }
  for(const id of ids) for(const table of ['requests','participants','allocations']) {
    if(find(table,'requestId',id).length>1) issues.push(`${id}: ${table} 重複`);
  }
  const newAlloc=after.allocations.filter(a=>!before.allocations.some(b=>a.allocationId===b.allocationId));
  for(const [prizeId,p] of Object.entries(after.prizes)) {
    const b=before.prizes[prizeId], count=newAlloc.filter(a=>a.prizeId===prizeId).length;
    if(!b||![p.remainingStock,p.allocatedCount,p.initialStock].every(n=>Number.isInteger(n)&&n>=0)||p.initialStock!==p.remainingStock+p.allocatedCount) issues.push(`${prizeId}: 庫存不變量不符`);
    if(b&&(b.remainingStock-p.remainingStock!==count||p.allocatedCount-b.allocatedCount!==count||p.initialStock!==b.initialStock)) issues.push(`${prizeId}: 前後扣減不符（或有外部調整）`);
    if(after.allocations.filter(a=>a.prizeId===prizeId).length!==p.allocatedCount) issues.push(`${prizeId}: 歷史分配總數不符`);
  }
  if(Object.keys(before.prizes).some(id=>!after.prizes[id])) issues.push('品項遺失');
  const delta=Object.fromEntries(TABLES.map(k=>[k,after[k].length-before[k].length]));
  if(newAlloc.some(a=>!ids.has(a.requestId))) issues.push('存在非本批新增分配，請排除其他 Demo 流量');
  const unknown=runners.some(r=>r.posted&&r.finalState==='UNKNOWN');
  if(!unknown&&(delta.requests!==known.length||delta.participants!==known.length||delta.allocations!==known.filter(r=>['allocated','RECOVERED_ALLOCATED'].includes(r.finalState)).length||delta.inventoryLog!==delta.allocations)) issues.push('五表新增筆數不符（或有其他 Demo 流量／部分寫入）');
  if(new Set(after.inventoryLog.map(r=>r.logId)).size!==after.inventoryLog.length) issues.push('InventoryLog ID 重複');
  return { status:issues.length?'FAIL':unknown?'未驗證':'PASS', issues, delta,
    note:'需提供完整 Demo 歷史的去敏快照；不能由 HTTP 成功推導。UNKNOWN 不視為失敗或無寫入。' };
}

export function parseMetrics(text, requestIds) {
  const ids=new Set(requestIds), rows=[];
  const fields=['totalMs','validationMs','lockWaitMs','lockHeldMs','requestLookupMs','prizeReadMs','schemaReadMs','settingsReadMs','sheetReadMs','sheetWriteMs'];
  for(const line of text.split(/\r?\n/).filter(l=>l.trim())) {
    const entry=JSON.parse(line);
    let m=entry.jsonPayload||entry;
    if(entry.textPayload||entry.message) {
      const raw=entry.textPayload||entry.message, start=raw.indexOf('{');
      if(start<0) continue; m=JSON.parse(raw.slice(start));
    }
    if(m.event!=='garmin_run_post_timing'||m.demoMode!==true||!ids.has(m.requestId)) continue;
    if(!fields.every(k=>Number.isFinite(m[k])&&m[k]>=0)) throw new Error('INVALID_BACKEND_METRICS');
    rows.push({requestId:m.requestId,...Object.fromEntries(fields.map(k=>[k,m[k]]))});
  }
  if(new Set(rows.map(r=>r.requestId)).size!==rows.length) throw new Error('DUPLICATE_METRICS_REQUEST_ID');
  return rows;
}
