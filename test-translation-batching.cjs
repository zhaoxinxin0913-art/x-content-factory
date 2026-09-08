const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const modulePath = './translation-drafts';

test('default cache retains a multi-language batch and bounded single retries do not serialize', async () => {
  const {DraftCache,generateDrafts,createLimiter}=require(modulePath);
  const cache=new DraftCache();
  for(let i=0;i<16000;i++)cache.set(String(i),{translation:'ok',confidence:90,model:'A'});
  assert(cache.get('0'),'a 2000-row four-language A/B run must fit the default cache');
  const limit=createLimiter(2);let active=0,peak=0;
  const items=Array.from({length:4},(_,i)=>({id:'id'+i,prompt:'p',context:{sourceText:'s'}}));
  await generateDrafts({step:'A',items,cfg:{model:'A'},cache:new DraftCache(),call:async()=>({}),
    single:async()=>limit(async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));active--;return {translation:'retry',confidence:90,model:'A'};})});
  assert.equal(peak,2);
});

test('shared rules appear once per batch and telemetry distinguishes cache from requests', async () => {
  const {generateDrafts,DraftCache}=require(modulePath);
  const rule='UNIQUE_SHARED_RULE_'+'rules '.repeat(1000);
  const sharedPrompt=rule+' __ITEM_SOURCE_TEXT__ __ITEM_REFS__';
  const items=Array.from({length:12},(_,i)=>({id:String(i),sharedPrompt,
    prompt:rule+' source'+i+' scene'+i,context:{sourceText:'source'+i,refs:'scene'+i}}));
  const stats={}; const cache=new DraftCache();let calls=0;
  const options={step:'A',items,cfg:{model:'A'},cache,stats,
    call:async(cfg,prompt)=>{
      calls++;assert.equal(prompt.split('UNIQUE_SHARED_RULE_').length-1,1);
      const body=JSON.parse(prompt.slice(prompt.indexOf('\n')+1));
      assert.equal(body.sharedPrompt,sharedPrompt);assert.equal(body.items[3].refs,'scene3');
      return {items:body.items.map(r=>({id:r.id,translation:'ok',confidence:90}))};
    },single:async()=>{throw new Error('unexpected retry');}};
  const result=await generateDrafts(options);
  assert.equal(result.get('3').translation,'ok');assert.equal(calls,1);
  assert.equal(stats.batchRequests,1);assert(stats.actualInputBytes<stats.baselineInputBytes/2);
  await generateDrafts(options);assert.equal(calls,1);assert.equal(stats.cacheHits,12);
});

test('malformed batches and failed single retries are isolated per row and never cached', async () => {
  const {generateDrafts,DraftCache}=require(modulePath);
  const items=[0,1,2].map(i=>({id:String(i),prompt:'p',context:{sourceText:'source'+i,targetLang:'fr'}}));
  let batch=0; const retries=[];
  const options={step:'A',items,cfg:{model:'A'},cache:new DraftCache(),
    call:async()=>{batch++;return {items:[{id:'0',translation:'bad',confidence:90,error:'provider failed'},{id:'1',translation:[],confidence:90}]};},
    single:async item=>{retries.push(item.id); if(item.id==='0')throw new Error('single failed');return {translation:'fb',confidence:70,model:'mymemory-translate-fallback'};}
  };
  const result=await generateDrafts(options);
  assert.equal(result.size,3); assert.equal(result.get('0').model,'error');
  assert.equal(result.get('0').translation,'source0');
  await generateDrafts(options);assert.equal(batch,2);assert.equal(retries.length,6);
  await assert.rejects(generateDrafts({...options,step:'C'}),/Only A\/B/);
});

test('one shared limiter bounds batch, single retry and C requests across tasks, releases after failure', async () => {
  const { createLimiter } = require(modulePath);
  assert.equal(typeof createLimiter,'function','shared limiter missing');
  const limit = createLimiter(3); let active=0, peak=0;
  await Promise.all(Array.from({length:60},(_,i)=>limit(async()=>{
    active++; peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,2)); active--;
    if(i===4) throw new Error('expected');
  }).catch(()=>{})));
  assert.equal(peak,3); assert.equal(active,0);
});

test('actual pipeline batches A/B, always reruns per-row C/checks and never reclassifies existing exports', async () => {
  const vm = require('node:vm'); const drafts = require(modulePath);
  const server = fs.readFileSync(path.join(__dirname,'translation-server.js'),'utf8');
  const core = server.slice(server.indexOf('const CONCURRENCY ='),server.indexOf('// 启动服务'));
  const data = Array.from({length:20},(_,i)=>[`label ${i} %s`]);
  const stored = {id:'stored',route:'human',needsReview:true,translation:'existing'};
  const DB = {tasks:[{id:'test',data,headers:['source']}],results:[stored]};
  const models=Object.fromEntries(['A','B','C'].map(step=>[step,{model:step,prompt:'translate {sourceText} {targetLang} {glossary} {refs}',protocol:'openai',apiKey:'fake',baseUrl:'https://test',temperature:0.3}]));
  let batchCalls=0,singleCalls=0,cCalls=0;
  const sandbox={console:{log(){},error(){}},process:{env:{}},DB,SETTINGS:{models},...drafts,
    draftCache:new drafts.DraftCache(),modelConfigured:()=>true,buildGlossary:()=>({map:{},dntList:[]}),
    langName:x=>x,glossaryToPrompt:()=>'',fillPrompt:(s,v)=>s.replace(/\{(\w+)\}/g,(_,k)=>v[k]),
    saveDB(){},buildRefs:()=>'',
    callLLM:async(cfg,prompt)=>{
      batchCalls++;
      const inputs=JSON.parse(prompt.slice(prompt.indexOf('\n')+1)).items;
      return {items:inputs.map(({id})=>({id,translation:'translated '+id.split(':').pop()+' %s',confidence:90}))};
    },
    modelA_generate:async()=>{singleCalls++;return {translation:'single',confidence:90,model:'A'};},
    modelB_generate:async()=>{singleCalls++;return {translation:'single',confidence:90,model:'B'};},
    modelC_arbitrate:async()=>{cCalls++;return {final:'broken placeholder',consistency:10,model:'C',detail:{auto_approve:true}};}
  };
  vm.createContext(sandbox);vm.runInContext(core,sandbox);
  await sandbox.processTranslationPipeline('test',0,['ja']);
  assert.equal(batchCalls,2,'A/B should each send one short batch'); assert.equal(singleCalls,0);
  assert.equal(cCalls,20); assert.ok(DB.results.slice(1).every(r=>r.route==='human' && r.programChecks.length));
  await sandbox.processTranslationPipeline('test',0,['ja']);
  assert.equal(batchCalls,2,'second run must reuse drafts'); assert.equal(cCalls,40,'C must never be cached');
  models.A.temperature=0.7;
  await sandbox.processTranslationPipeline('test',0,['ja']);
  assert.equal(batchCalls,4,'mutated runtime configuration must invalidate cache'); assert.equal(cCalls,60);
  assert.deepEqual(stored,{id:'stored',route:'human',needsReview:true,translation:'existing'});
});

test('adaptive A/B batches preserve exact IDs and retry only duplicated, missing or invalid rows', async () => {
  const m = require(modulePath);
  assert.equal(typeof m.generateDrafts, 'function', 'batch runner missing');
  const items = Array.from({length:20}, (_,i) => ({id:`row:${i}`,prompt:`unchanged prompt ${i}`,context:{sourceText:`source${i}`,targetLang:'ja',refs:''}}));
  assert.deepEqual(m.packBatches(items).map(b=>b.length),[20]);
  const long = items.map(x=>({...x,prompt:'x'.repeat(30000)}));
  assert.ok(m.packBatches(long).every(b=>b.length===1));
  const singles=[]; const batches=[]; const cache = new m.DraftCache();
  const run = (step) => m.generateDrafts({step,items,cfg:{model:step},cache,
    call:async (cfg,prompt) => {
      batches.push({step,prompt});
      const rows = items.filter(x=> !['row:2','row:3'].includes(x.id)).map(x=>({id:x.id,translation:`${step}/${x.id}`,confidence:90}));
      rows.push({...rows[1]}); // duplicate row:1 must not be mapped by position
      rows.push({id:'unknown',translation:'wrong',confidence:90});
      rows.reverse();
      return {items:rows};
    },
    single:async (item) => { singles.push(`${step}/${item.id}`); return {translation:`retry/${item.id}`,confidence:80,model:step}; }
  });
  const [a,b]=await Promise.all([run('A'),run('B')]);
  assert.equal(batches.length,2);
  assert.equal(singles.length,6);
  assert.deepEqual(singles.sort(),['A/row:1','A/row:2','A/row:3','B/row:1','B/row:2','B/row:3']);
  assert.equal(a.get('row:0').translation,'A/row:0');
  assert.equal(b.get('row:0').translation,'B/row:0');
  assert.equal(a.get('row:1').translation,'retry/row:1');
  assert.ok(!batches[1].prompt.includes('A/row:'));
  await run('A'); assert.equal(batches.length,2); assert.equal(singles.length,6);
  assert.throws(()=>m.packBatches([items[0],items[0]]),/duplicate/i);
});

test('strict draft cache invalidates every input and stores only bounded successful drafts, no credentials or review status', () => {
  assert.ok(fs.existsSync(path.join(__dirname, modulePath + '.js')), 'draft cache implementation missing');
  const { DraftCache, cacheKey } = require(modulePath);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-cache-test-'));
  try {
    const file = path.join(dir, 'cache.json');
    const cache = new DraftCache({ file, maxEntries: 2 });
    const context = { sourceText: ' exact ', targetLang: 'pt-BR', refs: ' scene ', glossary: { map: {one:'um'}, dntList:['X'] }, models: { A: { apiKey:'secret-test-key', protocol:'anthropic', model:'original', prompt:'unchanged', temperature:0.2, baseUrl:'https://example.test' } }, prompt:'rendered', step:'A' };
    const key = cacheKey(context);
    for (const field of Object.keys(context)) assert.notEqual(cacheKey({...context,[field]: 'changed'}), key, field);
    for (const field of Object.keys(context.models.A)) assert.notEqual(cacheKey({...context,models:{A:{...context.models.A,[field]:'changed'}}}),key,field);
    cache.set(key, {translation:'texto',confidence:90,model:'original',route:'auto',needsReview:false});
    assert.deepEqual(cache.get(key), {translation:'texto',confidence:90,model:'original'});
    for (const bad of [{translation:''}, {translation: {}}, {translation:'x',confidence:101}, {translation:'x',confidence:80,model:'google-translate-fallback'}, {translation:'x',confidence:80,model:'error'}]) cache.set('bad',bad);
    assert.equal(cache.get('bad'),undefined);
    cache.flush();
    assert.ok(!fs.readFileSync(file,'utf8').includes('secret-test-key'));
    assert.deepEqual(new DraftCache({file}).get(key), cache.get(key));
    cache.set('second',{translation:'two',confidence:80,model:'original'});
    cache.set('third',{translation:'three',confidence:80,model:'original'});
    assert.equal(cache.get(key),undefined);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
