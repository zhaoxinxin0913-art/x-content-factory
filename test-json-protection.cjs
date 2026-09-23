const { test } = require('node:test');
const assert = require('node:assert');
const { programChecks, jsonStructCheck } = require('./translation-server.js');

test('JSON被拆成纯文本 → 拦截', () => {
  const src = '[{"id":0,"content":"post deleted"},{"id":1,"content":"comment deleted"}]';
  const out = 'publicación eliminada\ncomentario eliminado';  // 结构丢失
  const r = programChecks(src, out);
  assert.ok(!r.pass, '应不通过');
  assert.ok(r.issues.some(i => i.includes('JSON')), '应报JSON问题: ' + r.issues.join('|'));
});

test('JSON保留结构只译value → 通过', () => {
  const src = '[{"id":0,"content":"post deleted"}]';
  const out = '[{"id":0,"content":"publicación eliminada"}]';
  const r = programChecks(src, out);
  assert.ok(r.pass, '应通过, 实际: ' + r.issues.join('|'));
});

test('JSON对象 {"1":"Voice Match"} 结构保留 → 通过', () => {
  const src = '{"1":"Voice Match"}';
  const out = '{"1":"Coincidencia de Voz"}';
  assert.strictEqual(jsonStructCheck(src, out), null);
});

test('JSON键名被改 → 拦截', () => {
  const src = '{"1":"Voice Match"}';
  const out = '{"2":"Coincidencia de Voz"}';  // 键改了
  assert.ok(jsonStructCheck(src, out), '键名变动应报错');
});

test('JSON数组长度变化 → 拦截', () => {
  const src = '["a","b","c"]';
  const out = '["x","y"]';  // 少一个
  assert.ok(jsonStructCheck(src, out), '数组长度变动应报错');
});

test('非JSON原文不触发JSON检查', () => {
  assert.strictEqual(jsonStructCheck('Hello world', 'Hola mundo'), null);
  assert.strictEqual(jsonStructCheck('[Photo]', '[Foto]'), null); // 假JSON方括号标签
});

test('位置占位符 %s→%1$s 语序调整 → 不误报', () => {
  const r = programChecks('%s from %s', '%1$s（%2$sから）');
  assert.ok(!r.issues.some(i => i.includes('占位符')), '位置占位符不应误报: ' + r.issues.join('|'));
});

test('占位符真丢失 → 仍拦截', () => {
  const r = programChecks('you have %s diamonds', 'tienes diamantes');
  assert.ok(r.issues.some(i => i.includes('占位符')), '丢占位符应报错');
});
