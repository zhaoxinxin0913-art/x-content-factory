const assert=require('node:assert/strict');
const fs=require('fs');
assert.ok(fs.existsSync(__dirname+'/translation-classified-export.js'),'缺少分类导出模块');
const {buildClassifiedWorkbook,KINDS}=require('./translation-classified-export');
const X=require('xlsx-js-style');
const task={headers:['id','id','en'],data:[[1,'a','=Hello'],[2,'b','Hi'],[3,'c','']],columnIndex:2,targetLangs:['es','ja']};
const results=[
  {id:'a',rowIndex:0,targetLang:'es',translation:'Hola',translationA:'Hola',translationB:'Hola',route:'auto'},
  {id:'b',rowIndex:0,targetLang:'ja',translation:'こんにちは',translationA:'こんにちは',translationB:'やあ',route:'human',reviewReason:'检查语气',cDetail:{risk_level:'medium',error_types:['tone']},programChecks:['占位符不一致']},
  {id:'c',rowIndex:1,targetLang:'es',translation:'Hola',translationA:'Hola',translationB:'Hola',route:'spot_check',reviewReason:'抽查'},
  {id:'d',rowIndex:1,targetLang:'ja',translation:['やあ','こんにちは'],route:'auto'}];
const make=(kind,reviews=[])=>buildClassifiedWorkbook(task,results,reviews,kind,l=>l);

// 四种 KINDS
assert.deepEqual(Object.keys(KINDS),['approved','approved_spot','human','spot_check']);

// 人工复审：每语种7列
const wb=make('human');const s=wb.Sheets['翻译结果'];
const hdr=X.utils.sheet_to_json(s,{header:1,defval:''})[0];
assert.deepEqual(hdr,['id','id','en',
  'es译文','es_A版','es_B版','es_原因','es_风险等级','es_问题类型','es_程序检查',
  'ja译文','ja_A版','ja_B版','ja_原因','ja_风险等级','ja_问题类型','ja_程序检查']);
// 公式文本原样、非高亮
assert.equal(s.C2.v,'=Hello');assert.equal(s.C2.f,undefined);
// ja译文列(第11列=索引10=K)命中human,应高亮
assert.equal(s.K2.s.fill.fgColor.rgb,'FFF2CC');
// es列(第4列=D)未命中human,不高亮
assert.equal(s.D2.s,undefined);
// ja的原因/风险/问题类型/程序检查填对
const row2=X.utils.sheet_to_json(s,{header:1,defval:''})[1];
assert.ok(row2[13].includes('检查语气'),'ja原因'); // ja_原因
assert.equal(row2[14],'medium'); // ja_风险等级
assert.equal(row2[15],'tone'); // ja_问题类型
assert.equal(row2[16],'占位符不一致'); // ja_程序检查
// 只有1行含human
assert.equal(X.utils.sheet_to_json(s,{header:1}).length,2);

// 无需复审(仅auto)：原列+2语种译文列
const ap=make('approved').Sheets['翻译结果'];
assert.deepEqual(X.utils.sheet_to_json(ap,{header:1,defval:''})[0],['id','id','en','es','ja']);

// 含运营抽查
const aps=make('approved_spot').Sheets['翻译结果'];
assert.ok(X.utils.sheet_to_json(aps,{header:1}).length>=1);

// 运营抽查表7列
const sp=make('spot_check').Sheets['翻译结果'];
assert.equal(X.utils.sheet_to_json(sp,{header:1,defval:''})[0].length,3+2*7);
assert.equal(X.utils.sheet_to_json(sp,{header:1}).length,2);

// 人工复核fix覆盖 → 进approved
const fixed=make('approved',[{resultId:'b',decision:'fix',finalText:'修正訳'}]).Sheets['翻译结果'];
// row0现在es=auto,ja=fix→auto，两语种都通过，ja译文列(第5列E)=修正訳
assert.equal(fixed.E2.v,'修正訳');

// xlsx样式回读
const buffer=X.write(wb,{type:'buffer',bookType:'xlsx'});const read=X.read(buffer,{type:'buffer',cellStyles:true});
assert.equal(read.Sheets['翻译结果'].K2.s.fgColor.rgb,'FFF2CC');
// 重复防护
assert.throws(()=>buildClassifiedWorkbook(task,[...results,results[0]],[],'human'),/重复/);
console.log('PASS: 四档、每语种7列、公式文本、单格高亮、原因/风险/问题/程序检查、人工覆盖、xlsx样式回读、重复防护');
