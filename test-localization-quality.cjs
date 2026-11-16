const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const server = require('./translation-server');
const context = require('./translation-context');

test('source term boundaries, longest phrase and case-insensitive matching', () => {
  assert.equal(server.programChecks('Following', '팔로잉 중', { Follow: '팔로우', Following: '팔로잉 중' }).pass, true);
  assert.equal(server.programChecks('Privacy Policy', '개인정보 처리방침', { Privacy: '개인정보 보호', 'Privacy Policy': '개인정보 처리방침' }).pass, true);
  assert.equal(server.programChecks('follow', 'wrong', { Follow: '팔로우' }).pass, false);
  assert.deepEqual(server.matchSourceTerms('CLAIMED aimeless', ['AIME']), []);
  assert.deepEqual(server.matchSourceTerms('Follow Following', ['Follow', 'Following']).map(m=>m.term), ['Follow','Following']);
});
test('DNT preserves source casing and count without substring false positives', () => {
  const dnt = ['POPUP','VIP','SVIP','PK','AI Me'];
  assert.equal(server.programChecks('PopUp VIP', 'PopUp VIP', {}, dnt).pass, true);
  assert.equal(server.programChecks('PopUp VIP', 'POPUP VIP', {}, dnt).pass, false);
  assert.equal(server.programChecks('VIP VIP', 'VIP', {}, dnt).pass, false);
  assert.equal(server.programChecks('SVIP', 'SVIP', {}, dnt).pass, true);
  assert.equal(server.programChecks('CLAIMED', '已領取', {}, ['AIME']).pass, true);
  assert.equal(server.programChecks('VIP', 'VIP에게', {}, dnt).pass, true);
});
test('Taiwanese glossary never falls back to Chinese reference or Hong Kong', () => {
  assert.equal(server.termTranslationForLang({en:'Report',zh:'举报','zh-HK':'舉報'},'zh-TW'), '');
  assert.equal(server.termTranslationForLang({en:'Report',zh:'举报','ZH-TW':'檢舉'},'zh-TW'), '檢舉');
});
test('placeholder reordering does not create numeric differences; brace changes fail',()=>{
  assert.equal(server.programChecks('%s from %s','%1$s（%2$sから）').pass,true);
  assert.equal(server.programChecks('Hello {{name}}','你好 {name}').pass,false);
  assert.equal(server.programChecks('Pay 10 to %s','支付 11 給 %1$s').pass,false);
});
test('candidate references remain separate from hard requirements and use whole phrases', () => {
  const candidates=[{en:'Host','zh-TW':'主持人',zh:'主持人/主播'}, {en:'Room Owner','zh-TW':'房主'}];
  const make=(src, locked={})=>context.candidatePrompt(src,'zh-TW',candidates,server.termTranslationForLang,server.matchSourceTerms,locked);
  assert.match(make('Host'), /仅供参考/);
  assert.equal(make('Ghost'), '');
  assert.equal(make('Host',{Host:'房主'}), '');
  assert.equal(server.programChecks('Host','房主',{}).pass,true);
});
test('key context is included without selected reference columns, source is excluded', () => {
  const task={headers:['key','en','模块','用途','场景说明','长度限制'],columnIndex:1,refColumns:[]};
  const row=['room.host','Host','语音房','身份标签','主持发言的人',12];
  const refs=server.buildRefs(task,row,'zh-TW','Host');
  assert.match(refs,/room.host/); assert.match(refs,/主持发言的人/); assert.match(refs,/待确认候选术语/);
  assert.deepEqual(context.rowContext({headers:['key','模块'],columnIndex:0},['text','房间']),{module:'房间'});
});
function fixture() {
  const task={id:'old',headers:['key','en','模块','用途'],columnIndex:1,data:[['follow.button','Follow','个人资料','按钮']]};
  const result={id:'r',taskId:'old',rowIndex:0,sourceText:'Follow',targetLang:'zh-TW',translation:'追蹤'};
  const review={resultId:'r',taskId:'old',decision:'accept',reviewer:'human'};
  const db={tasks:[task],results:[result],reviews:[review]};
  const query=()=>context.approvedMemory({db,task,row:task.data[0],source:'Follow',lang:'zh-TW',canonical:server.canonicalLang,
    validate:(src,out)=>server.programChecks(src,out,{Follow:'追蹤'})});
  return {task,result,review,db,query};
}
test('only approved human translations are eligible, including legacy human records', () => {
  const f=fixture(); assert.equal(f.query()[0].translation,'追蹤');
  f.db.reviews=[{...f.review,reviewer:'ai-opus'}]; assert.equal(f.query().length,0);
  f.db.reviews=[{...f.review,reviewer:undefined}]; assert.equal(f.query().length,1);
  f.db.reviews=[{...f.review,decision:'reject'}]; assert.equal(f.query().length,0);
});
test('memory rejects different locale, missing scene and invalid current terminology', () => {
  const f=fixture(); f.result.targetLang='zh-CN'; assert.equal(f.query().length,0);
  f.result.targetLang='zh-TW'; f.task.data=[['other.key','Follow','其他模块','按钮']];
  const other={...f.task,id:'new',data:[['new.key','Follow','钱包','标题']]};
  assert.equal(context.approvedMemory({db:f.db,task:other,row:other.data[0],source:'Follow',lang:'zh-TW',canonical:server.canonicalLang,validate:()=>({pass:true})}).length,0);
  f.result.translation='错误'; assert.equal(f.query().length,0);
});
test('memory rejects conflicting approvals and respects a later rejection', () => {
  const f=fixture(); f.db.results.push({...f.result,id:'r2',translation:'追蹤帳號'});
  f.db.reviews.push({...f.review,resultId:'r2'}); assert.equal(f.query().length,0);
  f.db.reviews.push({...f.review,resultId:'r2',decision:'reject'}); assert.equal(f.query().length,1);
});
test('AI review prompt receives actual target glossary and DNT', () => {
  const prompt=server.buildAiReviewPrompt({sourceText:'Follow POPUP',targetLang:'zh-TW'},'台湾繁中','');
  assert.match(prompt,/Follow → 追蹤/); assert.match(prompt,/不可翻译词/); assert.match(prompt,/AI Me/);
});

// Run the actual review worker against an isolated DB and fake model, no API cost.
async function reviewWith(final, source='Follow %s') {
  const code=fs.readFileSync(require.resolve('./translation-server'),'utf8');
  const worker=code.slice(code.indexOf('async function runAiReview('),code.indexOf('// 启动 AI 复核'));
  const result={id:'r',taskId:'t',rowIndex:0,sourceText:source,targetLang:'zh-TW',needsReview:true,route:'human'};
  const db={reviews:[]}; const job={done:0,failed:0,fixed:0,jsonFixed:0};
  const sandbox={DB:db,callLLM:async()=>({final}),buildAiReviewPrompt:()=>'',buildRefs:()=>'',langName:x=>x,
    buildGlossary:()=>({map:{Follow:'追蹤'},dntList:['POPUP']}), programChecks:server.programChecks,tryParseJson:server.tryParseJson,saveDB(){}};
  vm.createContext(sandbox); vm.runInContext(worker,sandbox);
  await sandbox.runAiReview({id:'t',data:[[source]]},[result],{},job);
  return {db,job,result};
}
test('AI review rejects missing placeholders, wrong terms and damaged JSON structure',async()=>{
  for(const [final,source] of [['追蹤','Follow %s'],['錯誤 %s','Follow %s'],['{"other":"追蹤"}','{"label":"Follow"}'],['追蹤 改名','Follow POPUP']]){
    const r=await reviewWith(final,source);
    assert.equal(r.db.reviews.length,0); assert.equal(r.job.failed,1); assert.ok(r.result.aiReviewIssues.length);
  }
});
test('AI review saves valid results with an AI provenance marker',async()=>{
  const r=await reviewWith('追蹤 %s'); assert.equal(r.db.reviews.length,1);
  assert.equal(r.job.fixed,1); assert.equal(r.db.reviews[0].reviewer,'ai-opus');
});

test('manual review validates ownership, hard checks, and replaces old decisions',()=>{
  const code=fs.readFileSync(require.resolve('./translation-server'),'utf8');
  const route=code.slice(code.indexOf("app.post('/api/review'"),code.indexOf('// ---- AI 批量复核'));
  const DB={results:[{id:'r',taskId:'t',sourceText:'Follow %s',targetLang:'zh-TW',translation:'追蹤 %s'}],reviews:[],trainingSamples:[]};
  let handler; const sandbox={DB,app:{post:(_,fn)=>handler=fn},buildGlossary:()=>({map:{Follow:'追蹤'},dntList:[]}),programChecks:server.programChecks,saveDB(){}};
  vm.createContext(sandbox);vm.runInContext(route,sandbox);
  const invoke=body=>{let status=200;let payload;handler({body},{status(s){status=s;return this;},json(p){payload=p;}});return{status,payload};};
  assert.equal(invoke({taskId:'wrong',resultId:'r',decision:'accept'}).status,404);
  assert.equal(invoke({taskId:'t',resultId:'r',decision:'fix',finalText:'追蹤'}).status,422);
  assert.equal(DB.reviews.length,0);
  assert.equal(invoke({taskId:'t',resultId:'r',decision:'accept'}).status,200);
  assert.equal(DB.reviews[0].reviewer,'human');
  assert.equal(invoke({taskId:'t',resultId:'r',decision:'fix',finalText:'追蹤帳號 %s'}).status,200);
  assert.equal(DB.reviews.length,1);assert.equal(DB.reviews[0].finalText,'追蹤帳號 %s');
});
