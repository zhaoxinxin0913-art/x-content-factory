const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const server = require('./translation-server');
const {buildClassifiedWorkbook}=require('./translation-classified-export');
const X=require('xlsx-js-style');

test('C explicit veto and rewrites are not bypassed by A/B agreement',()=>{
  const route=(detail={},final='안녕')=>server.classifyRoute({final,consistency:10,detail},{pass:true},'안녕','안녕','Hello');
  assert.equal(route({decision:'human_review'}),'human');
  assert.equal(route({needs_human_review:true}),'human');
  assert.equal(route({overall_score:50}),'human');
  assert.equal(route({risk_level:'medium'}),'spot_check');
  assert.equal(route({decision:'rewrite'},'다른말'),'spot_check');
  assert.equal(route({auto_approve:true,risk_level:'low',overall_score:95}),'auto');
});

test('JSON preserves booleans/null/numbers at each path, but translates strings',()=>{
  for(const [a,b] of [
    ['{"enabled":true}','{"enabled":false}'],
    ['{"value":null}','{"value":"null"}'],
    ['{"min":1,"max":2}','{"min":2,"max":1}'],
  ]) assert.notEqual(server.jsonStructCheck(a,b),null);
  assert.equal(server.jsonStructCheck('{"text":"Hello","n":1,"b":true,"v":null}',
    '{"text":"你好","n":1,"b":true,"v":null}'),null);
});

test('rejected translations stay in manual export, never in approved export',()=>{
  const task={headers:['en'],data:[['Hello']],columnIndex:0,targetLangs:['ko-KR']};
  const results=[{id:'r',rowIndex:0,targetLang:'ko-KR',translation:'bad',route:'auto'}];
  const reviews=[{resultId:'r',decision:'reject'}];
  const approved=buildClassifiedWorkbook(task,results,reviews,'approved');
  assert.equal(X.utils.sheet_to_json(approved.Sheets['翻译结果'],{header:1}).length,1);
  const human=buildClassifiedWorkbook(task,results,reviews,'human');
  const rows=X.utils.sheet_to_json(human.Sheets['翻译结果'],{header:1});
  assert.equal(rows.length,2);assert.match(rows[1][4],/人工已拒绝/);
});

// Real HTTP routing, ephemeral loopback port; private paths are HEAD only.
test('static allowlist serves UI but does not expose repository secrets/data',async()=>{
  const listener=server.app.listen(0,'127.0.0.1');
  await new Promise((resolve,reject)=>{listener.once('listening',resolve);listener.once('error',reject)});
  try {
    const base='http://127.0.0.1:'+listener.address().port;
    for(const path of ['/translation-settings.json','/translation-db.json','/translation-server.js',
      '/package.json','/.git/config','/translation-output/any.xlsx','/translation-upload/any.xlsx']) {
      const r=await fetch(base+path,{method:'HEAD'});assert.equal(r.status,404,path);
    }
    for(const path of ['/','/translation-ui.html','/translation-reference-audit.html','/translation-reference-audit.json']) {
      const r=await fetch(base+path,{method:'HEAD'});assert.equal(r.status,200,path);
    }
  } finally {await new Promise(resolve=>listener.close(resolve));}
});

test('translate endpoint rejects invalid inputs and duplicate runs without changing stored results',async()=>{
  const code=fs.readFileSync(require.resolve('./translation-server'),'utf8');
  const route=code.slice(code.indexOf("app.post('/api/translate'"),code.indexOf('// 获取任务状态'));
  let handler,started=0;
  const task={id:'t',headers:['en'],status:'completed'};
  const db={tasks:[task],results:[]};
  vm.runInNewContext(route,{app:{post:(_,fn)=>{handler=fn}},DB:db,LANGS:{'ko-KR':{}},
    saveDB(){},processTranslationPipeline:async()=>{started++},console});
  async function request(body){let status=200,payload;const res={status(n){status=n;return this},json(v){payload=v;return this}};
    await handler({body},res);return {status,payload};}
  assert.equal((await request({taskId:'t',columnIndex:0,targetLangs:[]})).status,400);
  assert.equal((await request({taskId:'t',columnIndex:0,targetLangs:['ko-KR','ko-KR']})).status,400);
  db.results.push({id:'existing',taskId:'t'});
  assert.equal((await request({taskId:'t',columnIndex:0,targetLangs:['ko-KR']})).status,409);
  assert.equal(started,0);assert.equal(db.results.length,1);
});
