const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLLMJSON } = require('./translation-drafts');

test('parseLLMJSON: clean JSON passes through', () => {
  assert.deepEqual(parseLLMJSON('{"final":"hola","consistency":8}'), {final:'hola',consistency:8});
});
test('parseLLMJSON: strips markdown fences', () => {
  assert.deepEqual(parseLLMJSON('```json\n{"a":1}\n```'), {a:1});
});
test('parseLLMJSON: tolerates trailing commas', () => {
  assert.deepEqual(parseLLMJSON('{"a":1,"b":2,}'), {a:1,b:2});
});
test('parseLLMJSON: extracts JSON wrapped in explanatory text', () => {
  assert.deepEqual(parseLLMJSON('好的，结果是：{"final":"x"} 完成'), {final:'x'});
});
test('parseLLMJSON: recovers items from a TRUNCATED batch response', () => {
  // batch got cut off mid-3rd item — first two must survive
  const truncated = '{"items":[{"id":"row:0","final":"a"},{"id":"row:1","final":"b"},{"id":"row:2","fin';
  const r = parseLLMJSON(truncated);
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items.map(x=>x.id), ['row:0','row:1']);
});
test('parseLLMJSON: throws only when truly unrecoverable', () => {
  assert.throws(() => parseLLMJSON('this is not json at all'));
});
