const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const server = require('./translation-server');
const drafts = require('./translation-drafts');

test('pure links and resource filenames skip, including queries and fragments', () => {
  for (const source of [
    'https://example.com/help', 'https://example.com', 'http://localhost:5051/',
    'https://cdn.example.com/image.PNG?token=abc%2F123&v=2#preview',
    'www.example.com/help?q=2', '//cdn.example.com/image.webp?v=1',
    'banner_2026.jpg', '/static/logo.svg', '../assets/video.mp4#t=1',
    'mailto:help@example.com', '  https://example.com/help\n',
  ]) {
    assert.equal(server.isPureMediaLink(source), true, source);
    const result = server.assembleResult('t', 0, source, 'ko-KR', null, null, null, {});
    assert.equal(result.translation, source);
    assert.equal(result.route, 'auto');
    assert.equal(result.skippedTranslation, true);
    assert.equal(server.programChecks(source, source, {help:'도움말'}).pass, true);
    assert.equal(server.programChecks(source, source + 'changed').pass, false);
  }
});

test('mixed copy, Markdown labels, malformed URL and JSON never skip translation', () => {
  for (const source of [
    'See https://example.com/help', 'https://example.com/help 查看',
    'https://example.com/help，点击查看', '点击https://example.com/a.png',
    'https://x.test/a https://x.test/b', '[Help](https://x.test/a)',
    '{"url":"https://x.test/a.png","text":"Hello"}', '<a href="https://x.test">Help</a>',
    'Photo.png is ready', 'https://', '', null, '   ', 'Find %s people',
  ]) assert.equal(server.isPureMediaLink(source), false, source);
});

test('mixed-copy links preserve query/fragment and support translated punctuation', () => {
  const source = 'See https://x.test/help?v=2#faq.';
  assert.equal(server.programChecks(source, '請見 https://x.test/help?v=2#faq。').pass, true);
  assert.equal(server.programChecks(source, '請見 https://x.test/help?v=3#faq。').pass, false);
  assert.equal(server.programChecks('See www.example.com/help', '請見 www.example.com/changed').pass, false);
  assert.deepEqual(server.extractContentLinks('[Help](https://x.test/a_(b))'), ['https://x.test/a_(b)']);
  assert.equal(server.programChecks('Visit https://x.test/Follow', '請見 https://x.test/Follow', {Follow:'追蹤'}).pass,true);
});

function coreFixture(data, overrides={}) {
  const code=fs.readFileSync(require.resolve('./translation-server'), 'utf8');
  const core=code.slice(code.indexOf('const CONCURRENCY ='), code.indexOf('// 启动服务'));
  const DB={tasks:[{id:'t',data,headers:['en'],columnIndex:0,targetLangs:['ko-KR']}],results:[]};
  let calls=0;
  const cfg={model:'fake',prompt:'{sourceText}{refs}',apiKey:'fake'};
  const fail=async()=>{calls++;throw Error('Unexpected model call');};
  const sandbox={DB,console:{log(){},error(){}},process:{env:{}},...drafts,
    SETTINGS:{models:{A:cfg,B:cfg,C:cfg}},draftCache:new drafts.DraftCache(),
    modelConfigured:()=>true,buildGlossary:()=>({map:{},dntList:[]}),glossaryToPrompt:()=>'',
    fillPrompt:(s,v)=>s.replace(/\{(\w+)\}/g,(_,k)=>v[k]||''),langName:x=>x,saveDB(){},
    callLLM:fail,modelA_generate:fail,modelB_generate:fail,modelC_arbitrate:fail,...overrides};
  vm.createContext(sandbox);vm.runInContext(core,sandbox);
  return {sandbox,DB,calls:()=>calls};
}

test('actual initial pipeline and failed-row retry skip links without A/B/C requests', async()=>{
  const data=[['https://x.test/help'],['https://x.test/a.png?v='+ 'a'.repeat(900)],['www.example.com'],['   ']];
  const f=coreFixture(data);
  await f.sandbox.processTranslationPipeline('t',0,['ko-KR']);
  assert.equal(f.calls(),0);assert.equal(f.DB.results.length,3);
  assert.ok(f.DB.results.every(r=>r.skippedTranslation && !r.needsReview));
  f.DB.results=[];
  await f.sandbox.retranslateFailed('t');
  assert.equal(f.calls(),0);assert.equal(f.DB.results.length,3);
});

test('intentional link skips cannot mask failed-model circuit breaker',()=>{
  const f=coreFixture([]);
  const jobs=Array.from({length:10},(_,i)=>({rowIndex:i,sourceText:i<9?'https://x.test/a':'Translate this'}));
  f.DB.results=jobs.map(j=>({taskId:'t',targetLang:'ko-KR',rowIndex:j.rowIndex,modelA:j.rowIndex<9?'skip-media-link':'no-engine-skip'}));
  assert.equal(f.sandbox.abortIfMassSkip('t',jobs,'ko-KR'),true);
  assert.equal(f.sandbox.abortIfMassSkip('t',jobs.slice(0,9),'ko-KR'),false);
});

test('historical links in AI review are repaired by rule without model calls',async()=>{
  const code=fs.readFileSync(require.resolve('./translation-server'),'utf8');
  const worker=code.slice(code.indexOf('async function runAiReview('),code.indexOf('// 启动 AI 复核'));
  const source='https://x.test/help?token=123';
  const result={id:'r',taskId:'t',rowIndex:0,sourceText:source,targetLang:'ko-KR'};
  const DB={reviews:[]};const job={done:0,failed:0,fixed:0,jsonFixed:0};let calls=0;
  const sandbox={DB,callLLM:async()=>{calls++;throw Error('Unexpected')},isPureMediaLink:server.isPureMediaLink,
    buildGlossary:()=>({map:{},dntList:[]}),programChecks:server.programChecks,tryParseJson:server.tryParseJson,saveDB(){}};
  vm.createContext(sandbox);vm.runInContext(worker,sandbox);
  await sandbox.runAiReview({id:'t',data:[[source]]},[result],{},job);
  assert.equal(calls,0);assert.equal(DB.reviews[0].finalText,source);
  assert.equal(DB.reviews[0].reviewer,'rule-link-skip');assert.equal(job.skippedLinks,1);
  assert.equal(job.jsonFixed,0);
});
