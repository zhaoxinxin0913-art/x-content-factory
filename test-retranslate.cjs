const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const drafts = require('./translation-drafts');

// Load the server's core (module-scope funcs) into a sandbox with stubbed LLM/DB,
// so we can drive retranslateFailed against a task that has bad rows.
function loadCore(sandbox) {
  const server = fs.readFileSync(path.join(__dirname, 'translation-server.js'), 'utf8');
  const core = server.slice(server.indexOf('const CONCURRENCY ='), server.indexOf('// 启动服务'));
  vm.createContext(sandbox);
  vm.runInContext(core, sandbox);
}

test('needsRetranslate flags no-engine, fallback, rule-based and error rows only', () => {
  const sandbox = baseSandbox({});
  loadCore(sandbox);
  const bad = [
    {modelA:'no-engine-fallback',modelB:'x',modelC:'y'},
    {modelA:'x',modelB:'google-translate-fallback-b',modelC:'y'},
    {modelA:'x',modelB:'y',modelC:'rule-based-arbiter'},
    {modelA:'error',modelB:'y',modelC:'z'},
  ];
  const good = [{modelA:'claude',modelB:'gpt',modelC:'claude'}];
  for (const r of bad) assert.equal(sandbox.needsRetranslate(r), true, JSON.stringify(r));
  for (const r of good) assert.equal(sandbox.needsRetranslate(r), false, JSON.stringify(r));
});

function baseSandbox(overrides) {
  const models = Object.fromEntries(['A','B','C'].map(s=>[s,{model:s,prompt:'{sourceText}{targetLang}{glossary}{refs}{transA}{transB}',protocol:'openai',apiKey:'k',baseUrl:'u'}]));
  return {
    console:{log(){},error(){}}, process:{env:{}},
    SETTINGS:{models}, ...drafts,
    draftCache:new drafts.DraftCache(), modelConfigured:()=>true,
    buildGlossary:()=>({map:{},dntList:[]}), langName:x=>x, glossaryToPrompt:()=>'',
    fillPrompt:(s,v)=>s.replace(/\{(\w+)\}/g,(_,k)=>v[k]), saveDB(){}, buildRefs:()=>'',
    ...overrides,
  };
}

test('retranslateFailed replaces ONLY bad rows, keeps good ones, no duplicates, fills missing', async () => {
  const data = Array.from({length:4},(_,i)=>[`row ${i}`]);
  // existing results: es all good; pt: row0 good, row1 no-engine(bad), row2 missing, row3 rule-based(bad)
  const results = [
    {id:'g1',taskId:'t',rowIndex:0,targetLang:'es',translation:'ES0',modelA:'claude',modelB:'gpt',modelC:'claude',route:'auto'},
    {id:'g2',taskId:'t',rowIndex:0,targetLang:'pt',translation:'PT0',modelA:'claude',modelB:'gpt',modelC:'claude',route:'auto'},
    {id:'b1',taskId:'t',rowIndex:1,targetLang:'pt',translation:'row 1',modelA:'no-engine-fallback',modelB:'x',modelC:'y',route:'human'},
    {id:'b2',taskId:'t',rowIndex:3,targetLang:'pt',translation:'PT3',modelA:'claude',modelB:'gpt',modelC:'rule-based-arbiter',route:'spot_check'},
  ];
  const DB = {tasks:[{id:'t',data,headers:['s'],columnIndex:0,targetLangs:['es','pt']}], results};
  const sandbox = baseSandbox({DB,
    callLLM:async(cfg,prompt)=>{
      const body=JSON.parse(prompt.slice(prompt.indexOf('{"sharedPrompt"')>=0?prompt.indexOf('{"sharedPrompt"'):prompt.indexOf('{"items"')));
      if(cfg.model==='C') return {items:body.items.map(it=>({id:it.id,final:'GOOD '+it.id,overall_score:95,auto_approve:true}))};
      return {items:body.items.map(it=>({id:it.id,translation:'GOOD '+it.id,confidence:95}))};
    },
    modelA_generate:async()=>({translation:'GOOD',confidence:95,model:'A'}),
    modelB_generate:async()=>({translation:'GOOD',confidence:95,model:'B'}),
  });
  sandbox.normalizeCVerdict=(r,tA,m)=>({final:r.final||tA,consistency:9,chosen:'A',divergence:'',detail:{auto_approve:r.auto_approve},model:m});
  sandbox.ruleArbitrate=(tA,tB)=>({final:tA||tB,consistency:10,chosen:'A',divergence:'',model:'rule-based-arbiter'});
  sandbox.modelC_arbitrate=async(s,tA)=>({final:'GOOD',consistency:9,chosen:'A',divergence:'',detail:{},model:'C'});
  loadCore(sandbox);
  const summary = await sandbox.retranslateFailed('t');
  // good rows untouched (same object identity by id)
  assert.ok(DB.results.find(r=>r.id==='g1'), 'es row0 kept');
  assert.ok(DB.results.find(r=>r.id==='g2'), 'pt row0 kept');
  // no duplicates: exactly one result per (rowIndex,lang) that should exist
  const seen = new Set();
  for (const r of DB.results) { const k=r.rowIndex+'|'+r.targetLang; assert.ok(!seen.has(k),'dup '+k); seen.add(k); }
  // pt now complete for all 4 rows, all good
  const pt = DB.results.filter(r=>r.targetLang==='pt');
  assert.equal(pt.length,4,'pt filled to 4 rows');
  assert.ok(pt.every(r=>!sandbox.needsRetranslate(r)),'no bad pt rows remain');
  assert.ok(summary.retranslated>=3, 'summary counts retranslated');
});

test('retranslateFailed refuses to run twice concurrently for the same task', async () => {
  const data = Array.from({length:6},(_,i)=>[`row ${i}`]);
  const results = data.map((_,i)=>({id:'b'+i,taskId:'t',rowIndex:i,targetLang:'pt',translation:'x',modelA:'no-engine-fallback',modelB:'x',modelC:'y',route:'human'}));
  const DB = {tasks:[{id:'t',data,headers:['s'],columnIndex:0,targetLangs:['pt']}], results};
  let cCalls=0;
  const sandbox = baseSandbox({DB,
    callLLM:async(cfg,prompt)=>{ await new Promise(r=>setTimeout(r,20));
      const body=JSON.parse(prompt.slice(prompt.indexOf('{"sharedPrompt"')>=0?prompt.indexOf('{"sharedPrompt"'):prompt.indexOf('{"items"')));
      if(cfg.model==='C'){cCalls++;return {items:body.items.map(it=>({id:it.id,final:'G '+it.id,consistency:9,decision:'select_a',auto_approve:true,review_reason:''}))};}
      return {items:body.items.map(it=>({id:it.id,translation:'G '+it.id,confidence:95}))};
    },
    modelA_generate:async()=>({translation:'G',confidence:95,model:'A'}),
    modelB_generate:async()=>({translation:'G',confidence:95,model:'B'}),
  });
  sandbox.normalizeCVerdict=(r,tA,m)=>({final:r.final||tA,consistency:9,chosen:'A',divergence:'',detail:{},model:m});
  sandbox.ruleArbitrate=(tA,tB)=>({final:tA||tB,consistency:10,chosen:'A',divergence:'',model:'rule-based-arbiter'});
  sandbox.modelC_arbitrate=async(s,tA)=>({final:'G',consistency:9,chosen:'A',divergence:'',detail:{},model:'C'});
  loadCore(sandbox);
  const [a,b] = await Promise.all([sandbox.retranslateFailed('t'), sandbox.retranslateFailed('t')]);
  // exactly one ran; the other was refused (returns a skipped marker)
  const ran = [a,b].filter(x=>x && !x.skipped);
  const skipped = [a,b].filter(x=>x && x.skipped);
  assert.equal(ran.length,1,'only one retranslate runs');
  assert.equal(skipped.length,1,'the concurrent duplicate is refused');
  assert.equal(DB.results.filter(r=>r.targetLang==='pt').length,6,'no duplicate rows');
});
