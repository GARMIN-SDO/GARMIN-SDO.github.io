import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { inlineShareImages, renderResultSharePng } from '../js/shareCard.js';
import { isConfirmedAllocation } from '../js/allocationConfirmation.js';

class Picture extends EventTarget {
  constructor(src='',key='runner'){super();this.src=src;this.key=key;this.hidden=false;this.complete=true;this.naturalWidth=100;}
  get currentSrc(){return this.src;}
  getAttribute(name){return name==='src'?this.src:null;}
  removeAttribute(){}
  closest(){for(let item=this;item;item=item.parentElement)if(item.hidden)return item;return null;}
  remove(){this.parentElement.images=this.parentElement.images.filter(i=>i!==this);}
  async decode(){this.decoded=true;}
}
class Card {
  constructor(images){this.images=images;images.forEach(i=>{i.parentElement=this;});}
  querySelector(){return this.images.find(i=>i.key==='runner')||null;}
  querySelectorAll(selector){return selector==='img'?this.images:[];}
  removeAttribute(){}
  cloneNode(){return new Card(this.images.map(i=>Object.assign(new Picture(i.src,i.key),{hidden:i.hidden})));}
  getBoundingClientRect(){return {width:this.parentElement?.hidden?0:390,height:800};}
}
function root(){return {style:{},replaceChildren(card){this.firstElementChild=card;},
  querySelector(s){return this.firstElementChild?.querySelector(s);},querySelectorAll(s){return this.firstElementChild?.querySelectorAll(s)||[];}};}
function globals(t,fetchImpl){
  const previous=new Map();
  for(const [key,value] of Object.entries({fetch:fetchImpl,Image:Picture,document:{fonts:{ready:Promise.resolve()}},
    requestAnimationFrame:callback=>queueMicrotask(callback),
    FileReader:class {readAsDataURL(blob){blob.arrayBuffer().then(bytes=>{this.result=`data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`;this.onload();},()=>this.onerror());}}})){
    previous.set(key,globalThis[key]);globalThis[key]=value;
  }
  previous.set('htmlToImage',globalThis.htmlToImage);
  t.after(()=>{for(const [key,value] of previous)if(value===undefined)delete globalThis[key];else globalThis[key]=value;});
}
const imageResponse=()=>new Response('image-bytes',{headers:{'content-type':'image/webp'}});

test('all three referenced runner WebP assets exist with valid WebP containers',()=>{
  for(const name of ['賽事收藏家','自在巡航員','配速計算機']){
    const bytes=readFileSync(new URL(`../assets/result/${name}.webp`,import.meta.url));
    assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.toString('ascii',8,12),'WEBP');
  }
});

test('transient fetch is retried and runner pixels are embedded before export',async t=>{
  let calls=0;globals(t,async()=>++calls===1?new Response('',{status:503}):imageResponse());
  const card=new Card([new Picture('https://fixture.invalid/transient.webp')]);
  await inlineShareImages(card);
  assert.equal(calls,2);assert.match(card.images[0].src,/^data:image\/webp;base64,/);assert.equal(card.images[0].decoded,true);
});

test('failed or missing images cannot be accepted as a PNG; failure cache does not poison retry',async t=>{
  let offline=true,calls=0,exports=0;
  globals(t,async()=>{calls++;return offline?new Response('',{status:503}):imageResponse();});
  globalThis.htmlToImage={toBlob:async()=>{exports++;return new Blob(['png'],{type:'image/png'});}};
  const sharedRoot=root(),args={card:new Card([new Picture('https://fixture.invalid/retry.webp')]),root:sharedRoot,stage:{},context:{style:{}}};
  await assert.rejects(renderResultSharePng(args),/Unable to fetch/);
  assert.equal(calls,2);assert.equal(exports,0);
  offline=false;
  assert.equal((await renderResultSharePng(args)).type,'image/png');assert.equal(exports,1);assert.equal(calls,3);
  await assert.rejects(inlineShareImages(new Card([])),/runner illustration is missing/);
});

test('shared export stage is serialized with frozen snapshots and hidden-source measurement restored',async t=>{
  const fetched=[];
  globals(t,async url=>{fetched.push(url);return imageResponse();});
  let release,firstReady;const ready=new Promise(resolve=>{firstReady=resolve;}),seen=[];
  const sharedRoot=root(),context={style:{}},stage={};
  globalThis.htmlToImage={toBlob:async(_stage,options)=>{
    assert.equal(options.width,1080);assert.equal(options.height,1920);
    const image=sharedRoot.firstElementChild.images[0];assert.match(image.src,/^data:/);assert.equal(image.decoded,true);
    seen.push(image.key);
    if(seen.length===1){firstReady();await new Promise(resolve=>{release=resolve;});assert.equal(sharedRoot.firstElementChild.images[0],image);}
    return new Blob(['png'],{type:'image/png'});
  }};
  const a=new Card([new Picture('https://fixture.invalid/first.webp')]);
  a.parentElement={hidden:true,parentElement:null};
  const first=renderResultSharePng({card:a,root:sharedRoot,context,stage});
  a.images[0].src='https://fixture.invalid/mutated.webp';
  const b=new Card([new Picture('https://fixture.invalid/second.webp')]);
  const second=renderResultSharePng({card:b,root:sharedRoot,context,stage});
  await ready;assert.equal(a.parentElement.hidden,true);assert.equal(seen.length,1);
  release();await Promise.all([first,second]);assert.equal(seen.length,2);
  assert.deepEqual(fetched,['https://fixture.invalid/first.webp','https://fixture.invalid/second.webp']);
  assert.match(context.style.width,/390px/);
});

const app=readFileSync(new URL('../js/appV2.js',import.meta.url),'utf8');
test('restored allocation rebuilds the runner card before entering redemption',async()=>{
  const pending={requestId:'request',sessionId:'session',environment:'demo',payload:{answers:{q1:'q1_experience'},hydrationCommitment:'joined'}};
  const allocation={ok:true,demoMode:true,requestId:'request',sessionId:'session',participantId:'participant',allocationStatus:'allocated'};
  let prepared=0,rendered=0,cleared=0;
  const state={submitInProgress:false};
  const ctx=vm.createContext({state,content:{quizData:{questions:[]},runnerTypes:[]},classificationRules:{},MOCK_MODE:false,APPS_SCRIPT_DEMO_MODE:true,
    readPendingRequest:()=>pending,getExistingAllocation:async()=>({ok:true,found:true,demoMode:true,allocation}),isConfirmedAllocation,
    classifyAnswers:({answers})=>{assert.equal(answers.q1,'q1_experience');return {runnerType:'experience'};},
    renderResult:()=>{assert.equal(state.result.runnerType,'experience');prepared++;},
    clearPendingRequest:()=>{cleared++;},renderRedemption:()=>{assert.equal(prepared,1);rendered++;}});
  vm.runInContext(app.slice(app.indexOf('async function restorePendingSubmission()'),app.indexOf('loadContent().then(')),ctx);
  await ctx.restorePendingSubmission();assert.equal(prepared,1);assert.equal(rendered,1);assert.equal(cleared,1);
});

test('failed download can regenerate the image without starting another draw',async()=>{
  let attempts=0,saved=0,disabled=true;
  const state={result:{runnerType:'experience'},requestId:'original-request',sessionId:'original-session',shareCardUrl:null};
  const elements={sharePreview:{removeAttribute(){}},shareStatus:{},shareStage:{},shareContext:{},shareRoot:{}};
  const ctx=vm.createContext({state,elements,console:{error(){}},$:()=>({}),copy:key=>key,
    URL:{createObjectURL:()=> 'blob:result',revokeObjectURL(){}},
    setDownloadButtonsDisabled:value=>{disabled=value;},buildResultViewModel:()=>({title:'runner'}),
    renderResultSharePng:async()=>{if(++attempts===1)throw new Error('IMAGE_FETCH_FAILED');return new Blob(['png'],{type:'image/png'});},
    document:{body:{append(){}},createElement:()=>({download:'',click(){saved++;},remove(){}})},
    sendAnonymousResult:()=>{throw new Error('DRAW_FORBIDDEN');}});
  vm.runInContext('let shareRenderGeneration=0;'+app.slice(app.indexOf('function prepareShareCard('),app.indexOf('function renderResult()'))+
    app.slice(app.indexOf('function downloadResultCard()'),app.indexOf('function renderMockTools()')),ctx);
  ctx.prepareShareCard({title:'runner'});await state.shareCardPromise;
  assert.equal(state.shareCardPromise,null);assert.equal(disabled,false);
  ctx.downloadResultCard();await state.shareCardPromise;await Promise.resolve();
  assert.equal(attempts,2);assert.equal(saved,1);assert.equal(state.requestId,'original-request');assert.equal(state.sessionId,'original-session');
});
