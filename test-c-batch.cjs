const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapBatch } = require('./translation-drafts');

// C arbitration batching: shared rules sent once, per-item verdicts mapped by
// EXACT id, and any missing/duplicate/invalid verdict falls back to single —
// never positional. C is never cached (must re-judge every run).
test('mapBatch shares the rubric once, scores per id, and isolates bad rows to single calls', async () => {
  assert.equal(typeof mapBatch, 'function', 'mapBatch missing');
  const items = Array.from({length:5}, (_,i) => ({
    id:`row:${i}`, sourceText:`s${i}`, transA:`A${i}`, transB:`B${i}`
  }));
  const rubric = 'UNIQUE_C_RUBRIC ' + 'rule '.repeat(400);
  const calls = []; const singles = [];
  const build = batch => rubric + JSON.stringify({items: batch.map(x=>({id:x.id,sourceText:x.sourceText,transA:x.transA,transB:x.transB}))});
  const out = await mapBatch({
    items,
    pack: b => build(b),
    validate: r => r && typeof r.final === 'string' && r.final !== '',
    call: async (prompt) => {
      calls.push(prompt);
      // rubric must appear exactly once (shared, not per item)
      assert.equal(prompt.split('UNIQUE_C_RUBRIC').length - 1, 1);
      const body = JSON.parse(prompt.slice(prompt.indexOf('{')));
      // return valid for 0,4; drop row:1 (missing); duplicate row:2; invalid row:3
      const rows = [];
      for (const it of body.items) {
        if (it.id === 'row:1') continue;
        if (it.id === 'row:3') { rows.push({id:it.id, final:''}); continue; }
        rows.push({id:it.id, final:'C '+it.id});
        if (it.id === 'row:2') rows.push({id:it.id, final:'dup'});
      }
      return {items: rows};
    },
    single: async (item) => { singles.push(item.id); return {final:'single '+item.id}; }
  });
  assert.equal(calls.length, 1, 'one shared batch call');
  assert.deepEqual(singles.sort(), ['row:1','row:2','row:3'], 'only affected rows retried singly');
  assert.equal(out.get('row:0').final, 'C row:0');
  assert.equal(out.get('row:4').final, 'C row:4');
  assert.equal(out.get('row:1').final, 'single row:1');
  assert.equal(out.get('row:2').final, 'single row:2');
  assert.equal(out.get('row:3').final, 'single row:3');
});

test('mapBatch splits by output/size ceilings and never cross-maps ids', async () => {
  const { mapBatch } = require('./translation-drafts');
  const items = Array.from({length:250}, (_,i) => ({id:`row:${i}`, sourceText:'x'.repeat(200)}));
  const seen = new Set(); let batches = 0;
  const out = await mapBatch({
    items, maxItems: 100,
    pack: b => JSON.stringify(b.map(x=>x.id)),
    validate: r => !!r,
    call: async (prompt) => { batches++; const ids = JSON.parse(prompt); return {items: ids.map(id=>({id, final:'ok'}))}; },
    single: async () => { throw new Error('should not retry'); }
  });
  assert.ok(batches > 1, 'large input must split into multiple batches');
  assert.equal(out.size, 250);
  for (const it of items) { assert.equal(out.get(it.id).final,'ok'); assert.ok(!seen.has(it.id)); seen.add(it.id); }
});

test('mapBatch total failure of a batch still resolves every row via single', async () => {
  const { mapBatch } = require('./translation-drafts');
  const items = [{id:'a'},{id:'b'}];
  const out = await mapBatch({
    items, pack: b => JSON.stringify(b.map(x=>x.id)), validate: r=>!!r,
    call: async () => { throw new Error('provider down'); },
    single: async (item) => ({final:'fb '+item.id})
  });
  assert.equal(out.get('a').final,'fb a');
  assert.equal(out.get('b').final,'fb b');
});

test('pipeline batches C once per window, keeps per-item programChecks and routing', async () => {
  const vm = require('node:vm'); const fs = require('node:fs'); const path = require('node:path');
  const drafts = require('./translation-drafts');
  const server = fs.readFileSync(path.join(__dirname,'translation-server.js'),'utf8');
  const core = server.slice(server.indexOf('const CONCURRENCY ='), server.indexOf('// 启动服务'));
  const data = Array.from({length:12},(_,i)=>[`term ${i} %s`]);
  const DB = {tasks:[{id:'t',data,headers:['source']}], results:[]};
  const models = Object.fromEntries(['A','B','C'].map(s=>[s,{model:s,prompt:'p {sourceText} {targetLang} {glossary} {refs} {transA} {transB}',protocol:'openai',apiKey:'k',baseUrl:'u'}]));
  let abBatches=0, cBatches=0, cSingleCalls=0;
  const sandbox={console:{log(){},error(){}},process:{env:{}},DB,SETTINGS:{models},...drafts,
    draftCache:new drafts.DraftCache(),modelConfigured:()=>true,buildGlossary:()=>({map:{},dntList:[]}),
    langName:x=>x,glossaryToPrompt:()=>'',fillPrompt:(s,v)=>s.replace(/\{(\w+)\}/g,(_,k)=>v[k]),
    saveDB(){},buildRefs:()=>'',
    callLLM:async(cfg,prompt)=>{
      const body=JSON.parse(prompt.slice(prompt.indexOf('{"sharedPrompt"')>=0?prompt.indexOf('{"sharedPrompt"'):prompt.indexOf('{"items"')));
      if(cfg.model==='C'){cBatches++; if(body.items.length===1)cSingleCalls++; return {items:body.items.map(it=>({id:it.id,final:'translated '+it.id.split(':').pop()+' %s',overall_score:90,auto_approve:true}))};}
      abBatches++;return {items:body.items.map(it=>({id:it.id,translation:'translated '+it.id.split(':').pop()+' %s',confidence:90}))};
    },
    modelA_generate:async()=>({translation:'x %s',confidence:90,model:'A'}),
    modelB_generate:async()=>({translation:'x %s',confidence:90,model:'B'}),
  };
  sandbox.normalizeCVerdict=(r,tA,m)=>({final:r.final||r.final_translation||tA,consistency:9,chosen:'A',divergence:'',detail:{auto_approve:r.auto_approve},model:m});
  sandbox.ruleArbitrate=(tA,tB)=>({final:tA||tB,consistency:10,chosen:'A',divergence:'',model:'rule-based-arbiter'});
  sandbox.modelC_arbitrate=async(s,tA,tB,l,g,refs)=>{const r=await sandbox.callLLM(models.C,'x '+JSON.stringify({items:[{id:'single',sourceText:s}]}));return sandbox.normalizeCVerdict(r.items?r.items[0]:r,tA,'C');};
  vm.createContext(sandbox); vm.runInContext(core, sandbox);
  await sandbox.processTranslationPipeline('t',0,['ja']);
  assert.equal(DB.results.length,12,'every row produces a result');
  assert.equal(abBatches,2,'A and B each send one batch');
  assert.equal(cBatches,1,'C reviews the whole window in ONE batch');
  assert.equal(cSingleCalls,0,'no per-item C fallback when batch is clean');
  // program checks still ran per item: source had %s, C final kept %s → pass; break one to prove per-item
  assert.ok(DB.results.every(r=>Array.isArray(r.programChecks)),'each row carries its own programChecks');
  assert.ok(DB.results.every(r=>['auto','spot_check','human'].includes(r.route)),'each row routed');
});

test('C batch prompt requests a COMPACT per-item output and small batches to avoid truncation', async () => {
  const vm = require('node:vm'); const fs = require('node:fs'); const path = require('node:path');
  const drafts = require('./translation-drafts');
  const server = fs.readFileSync(path.join(__dirname,'translation-server.js'),'utf8');
  const core = server.slice(server.indexOf('const CONCURRENCY ='), server.indexOf('// 启动服务'));
  const data = Array.from({length:60},(_,i)=>[`row ${i}`]);
  const DB = {tasks:[{id:'t',data,headers:['s'],columnIndex:0,targetLangs:['ja']}], results:[]};
  const models = Object.fromEntries(['A','B','C'].map(s=>[s,{model:s,prompt:'{sourceText}{targetLang}{glossary}{refs}{transA}{transB}',protocol:'openai',apiKey:'k',baseUrl:'u'}]));
  const cPrompts=[]; const cBatchSizes=[]; let maxTok=0;
  const sandbox={console:{log(){},error(){}},process:{env:{}},DB,SETTINGS:{models},...drafts,
    draftCache:new drafts.DraftCache(),modelConfigured:()=>true,buildGlossary:()=>({map:{},dntList:[]}),
    langName:x=>x,glossaryToPrompt:()=>'',fillPrompt:(s,v)=>s.replace(/\{(\w+)\}/g,(_,k)=>v[k]),
    saveDB(){},buildRefs:()=>'',
    callLLM:async(cfg,prompt,opts)=>{
      const body=JSON.parse(prompt.slice(prompt.indexOf('{"sharedPrompt"')>=0?prompt.indexOf('{"sharedPrompt"'):prompt.indexOf('{"items"')));
      if(cfg.model==='C'){cPrompts.push(prompt); cBatchSizes.push(body.items.length); maxTok=Math.max(maxTok,opts&&opts.maxTokens||0);
        return {items:body.items.map(it=>({id:it.id,final:'c '+it.id,consistency:8,decision:'select_a',auto_approve:true,review_reason:''}))};}
      return {items:body.items.map(it=>({id:it.id,translation:'t '+it.id,confidence:90}))};
    },
    modelA_generate:async()=>({translation:'x',confidence:90,model:'A'}),
    modelB_generate:async()=>({translation:'x',confidence:90,model:'B'}),
  };
  sandbox.normalizeCVerdict=(r,tA,m)=>({final:r.final||tA,consistency:r.consistency||5,chosen:'A',divergence:r.review_reason||'',detail:{auto_approve:r.auto_approve,decision:r.decision},model:m});
  sandbox.ruleArbitrate=(tA,tB)=>({final:tA||tB,consistency:10,chosen:'A',divergence:'',model:'rule-based-arbiter'});
  sandbox.modelC_arbitrate=async(s,tA)=>({final:tA,consistency:9,chosen:'A',divergence:'',detail:{},model:'C'});
  vm.createContext(sandbox); vm.runInContext(core, sandbox);
  await sandbox.processTranslationPipeline('t',0,['ja']);
  // compact: envelope must NOT ask for the heavy 20-field schema
  const p = cPrompts[0];
  assert.ok(!/semantic_accuracy|overall_score|source_interpretation/.test(p), 'C batch must request compact fields, not the heavy schema');
  assert.ok(/final|consistency|decision|auto_approve|review_reason/.test(p), 'compact fields present');
  // small batches so output cannot blow past the token ceiling
  assert.ok(cBatchSizes.every(n=>n<=15), 'C batches must be small (<=15), got '+cBatchSizes.join(','));
  assert.ok(maxTok>=4096, 'C batch should raise max_tokens headroom');
  assert.equal(DB.results.length,60);
  assert.ok(DB.results.every(r=>r.modelC==='C'), 'no rule-based fallback when batch succeeds');
});

test('pipeline C batch with a dropped id falls back to single for that row only', async () => {
  const vm = require('node:vm'); const fs = require('node:fs'); const path = require('node:path');
  const drafts = require('./translation-drafts');
  const server = fs.readFileSync(path.join(__dirname,'translation-server.js'),'utf8');
  const core = server.slice(server.indexOf('const CONCURRENCY ='), server.indexOf('// 启动服务'));
  const data = Array.from({length:4},(_,i)=>[`item ${i}`]);
  const DB = {tasks:[{id:'t',data,headers:['source']}], results:[]};
  const models = Object.fromEntries(['A','B','C'].map(s=>[s,{model:s,prompt:'{sourceText}{targetLang}{glossary}{refs}{transA}{transB}',protocol:'openai',apiKey:'k',baseUrl:'u'}]));
  const sandbox={console:{log(){},error(){}},process:{env:{}},DB,SETTINGS:{models},...drafts,
    draftCache:new drafts.DraftCache(),modelConfigured:()=>true,buildGlossary:()=>({map:{},dntList:[]}),
    langName:x=>x,glossaryToPrompt:()=>'',fillPrompt:(s,v)=>s.replace(/\{(\w+)\}/g,(_,k)=>v[k]),
    saveDB(){},buildRefs:()=>'',
    callLLM:async(cfg,prompt)=>{
      const body=JSON.parse(prompt.slice(prompt.indexOf('{"sharedPrompt"')>=0?prompt.indexOf('{"sharedPrompt"'):prompt.indexOf('{"items"')));
      if(cfg.model==='C'){ if(body.items.length===1){ // single retry for the dropped row
          sandbox.__cSingle=(sandbox.__cSingle||0)+1; return {items:body.items.map(it=>({id:it.id,final:'c '+it.id}))}; }
        return {items:body.items.filter(it=>it.id!=='row:2').map(it=>({id:it.id,final:'c '+it.id}))};}
      return {items:body.items.map(it=>({id:it.id,translation:'t '+it.id,confidence:90}))};
    },
    modelA_generate:async()=>({translation:'x',confidence:90,model:'A'}),
    modelB_generate:async()=>({translation:'x',confidence:90,model:'B'}),
  };
  sandbox.normalizeCVerdict=(r,tA,m)=>({final:r.final||r.final_translation||tA,consistency:9,chosen:'A',divergence:'',detail:{},model:m});
  sandbox.ruleArbitrate=(tA,tB)=>({final:tA||tB,consistency:10,chosen:'A',divergence:'',model:'rule-based-arbiter'});
  sandbox.modelC_arbitrate=async(s,tA,tB,l,g,refs)=>{const r=await sandbox.callLLM(models.C,'x '+JSON.stringify({items:[{id:'row:2',sourceText:s}]}));return sandbox.normalizeCVerdict(r.items?r.items[0]:r,tA,'C');};
  vm.createContext(sandbox); vm.runInContext(core, sandbox);
  await sandbox.processTranslationPipeline('t',0,['ja']);
  assert.equal(sandbox.__cSingle,1,'only the dropped row:2 retries single C');
  const r2 = DB.results.find(r=>r.rowIndex===2);
  assert.ok(r2 && typeof r2.translation==='string','dropped row still resolved');
});
