const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalLang,
  langName,
  localeRulesToPrompt,
  productKnowledgeToPrompt,
  termTranslationForLang
} = require('./translation-server.js');

test('新增语种使用精确地区代码和名称', () => {
  assert.equal(canonicalLang('ko'), 'ko-KR');
  assert.equal(canonicalLang('ms'), 'ms-MY');
  assert.equal(langName('ko-KR'), '韩语（韩国）');
  assert.equal(langName('zh-TW'), '繁体中文（台湾）');
  assert.equal(langName('ms-MY'), '马来语（马来西亚）');
});

test('每个新增地区都会自动追加专项规则', () => {
  assert.match(localeRulesToPrompt('ko-KR'), /收音|이용 정지/);
  assert.match(localeRulesToPrompt('zh-TW'), /台湾繁体中文|儲值|檢舉/);
  assert.match(localeRulesToPrompt('ms-MY'), /马来西亚马来语|印度尼西亚语|di-/);
});

test('术语表精确地区列优先于基础语种列', () => {
  const term = {
    en: 'Report',
    ko: '旧韩语',
    'ko-KR': '신고',
    zh: '举报',
    'zh-TW': '檢舉',
    ms: 'Lapor',
    'ms-MY': 'Laporkan'
  };
  assert.equal(termTranslationForLang(term, 'ko-KR'), '신고');
  assert.equal(termTranslationForLang(term, 'zh-TW'), '檢舉');
  assert.equal(termTranslationForLang(term, 'ms-MY'), 'Laporkan');
});

test('旧基础语种代码仍兼容并映射到精确地区列', () => {
  assert.equal(termTranslationForLang({ en: 'Block', ko: '旧译', 'ko-KR': '차단' }, 'ko'), '차단');
  assert.equal(termTranslationForLang({ en: 'Block', ms: '旧译', 'ms-MY': 'Sekat' }, 'ms'), 'Sekat');
});

test('A/B/C 与 AI 复核共用的产品知识包含关键概念和精确 DNT 规则', () => {
  const prompt = productKnowledgeToPrompt('zh-TW');
  assert.match(prompt, /年轻用户的娱乐、直播社交、语音房/);
  assert.match(prompt, /Follow\/Following\/Followers/);
  assert.match(prompt, /Block 是用户关系层面的封锁/);
  assert.match(prompt, /完整词精确匹配/);
  assert.match(prompt, /台湾繁体中文/);
});
