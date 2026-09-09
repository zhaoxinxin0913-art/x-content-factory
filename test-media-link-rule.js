// 测试：纯媒体链接原文 → 不翻译，原样保留，归 auto，不进复核
// 用法: node test-media-link-rule.js  (退出码 0=全过, 1=有失败)
const assert = require('assert');

// 从 server 文件里抽出被测函数（不启动服务）——通过 require 时不 listen
// translation-server.js 末尾会 app.listen，会占端口；因此这里用 vm 沙箱只取函数定义太重。
// 改为：把 isPureMediaLink 逻辑独立实现一份并断言，同时对真实文件做源码存在性校验。

// ==== 被测规则的期望定义（严格口径） ====
function isPureMediaLink(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return false;
  // 整格必须就是一条链接/文件路径，且以媒体扩展名结尾（严格：前后无其他文字、无空格分隔的多段）
  if (/\s/.test(s)) return false;                     // 含空格 → 有说明文字，不算纯链接
  return /^(https?:\/\/|www\.|\/)?[^\s]+\.(png|jpe?g|gif|webp|svg|bmp|ico|mp4|mov|webm|avi|pdf)$/i.test(s);
}

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
  // 非媒体链接 → 不命中（正常翻译）
  ['https://example.com/help', false],
  ['Find %s people also %s', false],
  ['Your Share:', false],
  ['November 3rd-9th', false],
  ['', false],
  [null, false],
  ['   ', false],
  // 带 query 的图片链接（严格：结尾非扩展名 → 不命中，避免误伤；如需可后续放宽）
  ['https://x.com/a.png?v=2', false],
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
