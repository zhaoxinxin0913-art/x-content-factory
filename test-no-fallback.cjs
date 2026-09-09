const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const drafts = require('./translation-drafts');

function loadCore(sandbox) {
  const server = fs.readFileSync(path.join(__dirname, 'translation-server.js'), 'utf8');
  const core = server.slice(server.indexOf('const CONCURRENCY ='), server.indexOf('// 启动服务'));
  vm.createContext(sandbox);
  vm.runInContext(core, sandbox);
}

function baseSandbox(extra) {
  const models = Object.fromEntries(['A', 'B', 'C'].map(s => [s, { model: s, prompt: 'x', protocol: 'anthropic', apiKey: 'k', baseUrl: 'u' }]));
  const sb = {
    console: { log() {}, error() {} }, process: { env: {} },
    SETTINGS: { models }, ...drafts,
    draftCache: new drafts.DraftCache(), modelConfigured: () => true,
    buildGlossary: () => ({ map: {}, dntList: [] }), langName: x => x,
    glossaryToPrompt: () => '', fillPrompt: (s) => s, saveDB() {}, buildRefs: () => '',
    callLLM: async () => { throw new Error('fail'); },
    fallbackTranslate: async () => ({ translation: 'FREE', engine: 'mymemory' }),
    validDraft: () => false,
    normalizeCVerdict: (r, tA, m) => ({ final: tA, consistency: 5, chosen: 'A', divergence: '', detail: {}, model: m }),
    ruleArbitrate: (tA, tB) => ({ final: tA || tB, consistency: 10, chosen: 'A', divergence: '', model: 'rule-based-arbiter' }),
    modelC_arbitrate: async (s, tA) => ({ final: tA, consistency: 5, chosen: 'A', divergence: '', detail: {}, model: 'C' }),
    ...extra,
  };
  return sb;
}

// NO_FALLBACK 开启 + 整窗模型跳过 → 任务熔断为 aborted，且不产生免费引擎结果
test('NO_FALLBACK: mass model-skip aborts the task instead of free-engine fallback', async () => {
  const data = [['a'], ['b'], ['c']];
  const DB = { tasks: [{ id: 't', data, headers: ['s'], columnIndex: 0, targetLangs: ['ja'], status: 'translating' }], results: [] };
  const sb = baseSandbox({
    process: { env: { NO_FALLBACK: '1' } }, DB,
    // 模拟 NO_FALLBACK 下 A/B 失败被标记为 no-engine-skip（不走免费引擎）
    modelA_generate: async (s) => ({ translation: s, confidence: 0, model: 'no-engine-skip-A' }),
    modelB_generate: async (s) => ({ translation: s, confidence: 0, model: 'no-engine-skip-B' }),
  });
  loadCore(sb);
  await sb.processTranslationPipeline('t', 0, ['ja']);
  assert.ok(DB.results.every(r => /no-engine-skip/.test(r.modelA) || /no-engine-skip/.test(r.modelB)), '失败条目标 no-engine-skip');
  assert.ok(DB.results.every(r => sb.needsRetranslate(r)), '跳过条目计入 needsRetranslate（明天可补）');
  assert.equal(DB.tasks[0].status, 'aborted', '整窗跳过应熔断任务');
});

// 少量跳过（<80%）不触发熔断
test('NO_FALLBACK: partial skip below threshold does NOT abort', async () => {
  const data = Array.from({ length: 10 }, (_, i) => [`r${i}`]);
  const DB = { tasks: [{ id: 't', data, headers: ['s'], columnIndex: 0, targetLangs: ['ja'], status: 'translating' }], results: [] };
  let n = 0;
  const sb = baseSandbox({
    process: { env: { NO_FALLBACK: '1' } }, DB,
    // 仅前2条跳过，其余正常
    modelA_generate: async (s) => (n++ < 2 ? { translation: s, confidence: 0, model: 'no-engine-skip-A' } : { translation: 'OK', confidence: 90, model: 'A' }),
    modelB_generate: async () => ({ translation: 'OK', confidence: 90, model: 'B' }),
  });
  loadCore(sb);
  await sb.processTranslationPipeline('t', 0, ['ja']);
  assert.equal(DB.tasks[0].status, 'completed', '少量跳过不熔断，正常完成');
});
