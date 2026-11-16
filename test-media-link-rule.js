// 测试：纯媒体链接原文 → 不翻译，原样保留，归 auto，不进复核
// 用法: node test-media-link-rule.js  (退出码 0=全过, 1=有失败)
const assert = require('assert');

// Import the actual production implementation; require does not listen.
const { isPureMediaLink } = require('./translation-server');

const cases = [
  // [输入, 期望是否命中]
  ['https://s3.sloegem.com/admin/1726659930843.png', true],
  ['https://s1-cdn.sloegem.com/admin/1704445831439.PNG', true],
  ['http://example.com/a/b/c.jpeg', true],
  ['banner_2026.jpg', true],
  ['/static/img/logo.webp', true],
  ['https://example.com/video.mp4', true],
  // 严格口径：含文字/空格 → 不命中
  ['点击查看 https://x.com/a.png', false],
  ['https://x.com/a.png 是新图', false],
  ['See https://x.com/a.png', false],
  // 普通网页链接同样无需翻译
  ['https://example.com/help', true],
  ['Find %s people also %s', false],
  ['Your Share:', false],
  ['November 3rd-9th', false],
  ['', false],
  [null, false],
  ['   ', false],
  // 带参数的链接也必须原样保留
  ['https://x.com/a.png?v=2', true],
];

let fail = 0;
for (const [input, expect] of cases) {
  const got = isPureMediaLink(input);
  const ok = got === expect;
  if (!ok) { fail++; console.error(`✗ FAIL: isPureMediaLink(${JSON.stringify(input)}) = ${got}, 期望 ${expect}`); }
  else console.log(`✓ ${JSON.stringify(input)} → ${got}`);
}

// ==== 校验真实 server 文件已挂载该规则 ====
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/translation-server.js', 'utf8');
const hasFn = /function isPureMediaLink/.test(src);
const wiredIntoAssemble = /isPureMediaLink\s*\(\s*sourceText\s*\)/.test(src);
if (!hasFn) { fail++; console.error('✗ FAIL: translation-server.js 未定义 isPureMediaLink'); }
else console.log('✓ server 已定义 isPureMediaLink');
if (!wiredIntoAssemble) { fail++; console.error('✗ FAIL: assembleResult 未接入 isPureMediaLink(sourceText) 守卫'); }
else console.log('✓ assembleResult 已接入媒体链接守卫');

console.log(fail === 0 ? '\n全部通过 ✅' : `\n${fail} 项失败 ❌`);
process.exit(fail === 0 ? 0 : 1);
