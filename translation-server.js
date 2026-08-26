const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = 5051;

// 模型配置（运行时可通过 /api/settings 修改，无需重启）
// 三个模型各自独立：地址 + key + 模型名 + 可编辑 prompt。留空则用免费兜底引擎。
const SETTINGS_FILE = path.join(__dirname, 'translation-settings.json');

// 各步默认 prompt（前端可改，占位符会在运行时替换）
// A 可用: {targetLang} {sourceText} {glossary} {refs}   —— 直译派（忠实/术语优先）
// B 可用: {targetLang} {sourceText} {glossary} {refs}   —— 意译派（地道/语境优先），独立运行看不到A
// C 可用: {targetLang} {sourceText} {transA} {transB} {glossary} {refs}  —— 独立审校+仲裁（看到全部上下文）
const DEFAULT_PROMPTS = {
  A: `你是一位【严谨直译派】翻译专家，风格偏向忠实原文、术语精确。
任务：将「源内容」翻译成{targetLang}。

你的判断路径与优先级：
1. 术语、专有名词、数字、占位符必须与原文严格对应，不可改写
2. 宁可保留原文结构，也不要为了通顺而改变含义
3. 有歧义时，选择字面最贴近原文的解释
{glossary}{refs}

源内容：{sourceText}

只翻译「源内容」本身。直接返回结果并评估置信度（0-100）。
返回 JSON：{"translation":"翻译结果","confidence":85}`,
  B: `你是一位【地道意译派】本地化专家，风格偏向自然流畅、贴合母语者习惯。
任务：将「源内容」翻译成{targetLang}。

你的判断路径与优先级（独立完成，不参考任何其他译文）：
1. 优先让译文读起来像母语者写的，符合当地表达与行业惯例
2. 在不改变原意的前提下，可调整语序、用更自然的措辞
3. 有歧义时，结合「应用场景/用途」选择最符合实际语境的译法
{glossary}{refs}

源内容：{sourceText}

只翻译「源内容」本身。直接返回结果并评估置信度（0-100）。
返回 JSON：{"translation":"翻译结果","confidence":85}`,
  C: `你是一位资深【翻译审校与仲裁】专家。两个风格不同的模型独立翻译了同一内容，请你结合全部上下文独立审校，不要盲目相信任何一方。

【完整上下文】
源内容（原文）：{sourceText}
目标语言：{targetLang}{glossary}{refs}

【两份候选译文】
译文A（直译派）：{transA}
译文B（意译派）：{transB}

请你：
1. 先【独立判断】源内容的正确译法（对照原文、其他语言参考、场景说明、术语表），再看 A/B——警惕 A、B 可能犯同一个错误（如都误解了同一个多义词、都漏了术语），此时不要被两者"一致"误导，应以你的独立判断为准
2. 给出最终译文：选 A 或 B 更准确的一版，或融合，或在两者都错时给出你的正确译法
3. 一致性评分（1-10）：A、B 两版语义是否一致；若你判断两者都偏离正确含义，即使彼此一致也应给低分并说明
4. 若有分歧或疑点，简述

返回 JSON：{"final":"最终译文","consistency":8,"chosen":"A或B或merged或C改写","divergence":"分歧/疑点说明(无则留空)"}`
};

function blankModel(step) {
  return { protocol: 'openai', baseUrl: '', apiKey: '', model: '', prompt: DEFAULT_PROMPTS[step], temperature: step === 'B' ? 0.2 : 0.3 };
}
let SETTINGS = { models: { A: blankModel('A'), B: blankModel('B'), C: blankModel('C') } };

// 加载持久化设置（含旧格式迁移）
try {
  if (require('fs').existsSync(SETTINGS_FILE)) {
    const loaded = JSON.parse(require('fs').readFileSync(SETTINGS_FILE, 'utf8'));
    if (loaded.models) {
      ['A', 'B', 'C'].forEach(k => { SETTINGS.models[k] = { ...blankModel(k), ...(loaded.models[k] || {}) }; });
    }
  }
} catch (e) { console.error('settings load failed:', e.message); }
function saveSettings() {
  try { require('fs').writeFileSync(SETTINGS_FILE, JSON.stringify(SETTINGS, null, 2)); } catch (e) {}
}

// 工具：模型是否已配置（三项齐全才算）
function modelConfigured(m) { return !!(m && m.baseUrl && m.apiKey && m.model); }
// 工具：填充 prompt 占位符
function fillPrompt(tpl, vars) { return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`)); }
// 工具：调用某个模型（支持 openai / openai-responses / anthropic 三种协议）
async function callLLM(cfg, prompt) {
  const temp = cfg.temperature != null ? cfg.temperature : 0.3;
  if (cfg.protocol === 'anthropic') return callAnthropic(cfg, prompt, temp);
  if (cfg.protocol === 'openai-responses') return callOpenAIResponses(cfg, prompt, temp);
  return callOpenAI(cfg, prompt, temp);
}

// OpenAI Responses API：POST {baseUrl}/responses, body 用 input, 文本在 output[].content[].text
async function callOpenAIResponses(cfg, prompt, temp) {
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
  const url = /\/v1$/.test(base) ? `${base}/responses` : `${base}/v1/responses`;
  const p = prompt + '\n\n只返回 JSON，不要任何额外解释或 markdown 代码块。';
  const send = async (withTemp) => {
    const payload = withTemp ? { model: cfg.model, input: p, temperature: temp } : { model: cfg.model, input: p };
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(payload)
    });
  };
  let res = await send(temp != null && temp < 1);
  if (res.status === 400) {
    const t = await res.clone().text();
    if (/temperature/i.test(t)) res = await send(false);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  // Responses API: 取 output[] 中 type=message 的 content[] 里 output_text 文本（跳过 reasoning 块）
  let text = '';
  for (const item of (data.output || [])) {
    for (const c of (item.content || [])) {
      if (c.type === 'output_text' && c.text) text += c.text;
    }
  }
  if (!text && data.output_text) text = data.output_text; // 兼容简写字段
  text = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(text);
}

// OpenAI 兼容：POST {baseUrl}/chat/completions
async function callOpenAI(cfg, prompt, temp) {
  const OpenAI = require('openai');
  const openai = new OpenAI({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey });
  const response = await openai.chat.completions.create({
    model: cfg.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: temp,
    response_format: { type: 'json_object' }
  });
  return JSON.parse(response.choices[0].message.content);
}

// Anthropic Messages API：POST {baseUrl}/v1/messages, 认证 x-api-key
async function callAnthropic(cfg, prompt, temp) {
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
  const url = /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
  const body = {
    model: cfg.model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt + '\n\n只返回 JSON，不要任何额外解释或 markdown 代码块。' }]
  };
  // 部分新模型（如 claude-sonnet-5）弃用 temperature，仅在明确 <1 时发送，出错则自动重试不带该参数
  const send = async (withTemp) => {
    const payload = withTemp ? { ...body, temperature: temp } : body;
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(payload)
    });
  };
  let res = await send(temp != null && temp < 1);
  if (res.status === 400) {
    const t = await res.clone().text();
    if (/temperature/i.test(t)) res = await send(false); // temperature 被弃用则重试
  }
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  let text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(text);
}

// 语种映射表（新增语种只需加一行）
const LANGS = {
  'es': { name: '西班牙语', google: 'es', flag: '🇪🇸' },
  'fr': { name: '法语',     google: 'fr', flag: '🇫🇷' },
  'ja': { name: '日语',     google: 'ja', flag: '🇯🇵' },
  'pt': { name: '葡萄牙语', google: 'pt', flag: '🇵🇹' },
  'en': { name: '英语',     google: 'en', flag: '🇬🇧' },
  'th': { name: '泰语',     google: 'th', flag: '🇹🇭' },
  'tl': { name: '菲律宾语', google: 'tl', flag: '🇵🇭' },
  'ko': { name: '韩语',     google: 'ko', flag: '🇰🇷' },
  'de': { name: '德语',     google: 'de', flag: '🇩🇪' },
  'it': { name: '意大利语', google: 'it', flag: '🇮🇹' },
  'ru': { name: '俄语',     google: 'ru', flag: '🇷🇺' },
  'zh-CN': { name: '简体中文', google: 'zh-CN', flag: '🇨🇳' },
  'zh-TW': { name: '繁体中文', google: 'zh-TW', flag: '🇹🇼' }
};
function langName(code) { return (LANGS[code] && LANGS[code].name) || code; }

// 存储目录
const UPLOAD_DIR = path.join(__dirname, 'translation-uploads');
const OUTPUT_DIR = path.join(__dirname, 'translation-output');
const DB_FILE = path.join(__dirname, 'translation-db.json');

[UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// 数据库（简单 JSON 存储）
let DB = { tasks: [], results: [], reviews: [], trainingSamples: [], glossary: {} };
if (fs.existsSync(DB_FILE)) {
  try {
    DB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    console.error('DB load failed:', e);
  }
}
function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(DB, null, 2));
}

// 文件上传配置
const upload = multer({ dest: UPLOAD_DIR });

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// ============================================================
// 翻译工具函数（兜底方案）
// ============================================================

// Google Translate 免费 API
function translateWithGoogle(text, targetLang) {
  return new Promise((resolve) => {
    const tl = (LANGS[targetLang] && LANGS[targetLang].google) || targetLang || 'en';
    const encoded = encodeURIComponent(text.substring(0, 500));
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t&q=${encoded}`;

    https.get(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const translation = json[0].map(x => x[0]).join('');
          resolve(translation || null);
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

// 简单的源语言检测（默认按数据库常见中文/英文）
function detectSourceLang(text) {
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh-CN';
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';
  if (/[\uac00-\ud7af]/.test(text)) return 'ko';
  if (/[\u0e00-\u0e7f]/.test(text)) return 'th';
  return 'en';
}

// MyMemory 免费翻译 API（无需 key，作为主兜底）
function translateWithMyMemory(text, targetLang) {
  return new Promise((resolve) => {
    const tl = (LANGS[targetLang] && LANGS[targetLang].google) || targetLang || 'en';
    if (tl === 'zh-CN' || tl === 'zh-TW') { /* MyMemory 用 zh-CN */ }
    const sl = detectSourceLang(text);
    if (sl === tl) return resolve(text); // 同语言直接返回
    const q = encodeURIComponent(text.substring(0, 480));
    const url = `https://api.mymemory.translated.net/get?q=${q}&langpair=${sl}|${tl}`;
    https.get(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          let t = json.responseData && json.responseData.translatedText;
          // 清理 MyMemory 偶发的 <g id="x"> </g> 占位标签
          if (t) t = t.replace(/<\/?g[^>]*>/g, '').replace(/\s+/g, ' ').trim();
          // MyMemory 失败时会返回警告文本
          if (t && !/MYMEMORY WARNING|INVALID|QUERY LENGTH/i.test(t)) resolve(t);
          else resolve(null);
        } catch (e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// 组合兜底翻译：MyMemory 优先，Google 次之
async function fallbackTranslate(text, targetLang) {
  let t = await translateWithMyMemory(text, targetLang);
  if (t) return { translation: t, engine: 'mymemory' };
  t = await translateWithGoogle(text, targetLang);
  if (t) return { translation: t, engine: 'google' };
  return { translation: text, engine: 'none' };
}

// 简单的质量评分（基于规则）
function simpleQualityScore(sourceText, translatedText, targetLang) {
  let score = 7; // 基础分
  const issues = [];
  
  // 长度检查
  if (translatedText.length < 2) {
    score -= 3;
    issues.push('过短');
  }
  
  // 未翻译检查
  if (translatedText === sourceText) {
    score -= 2;
    issues.push('未翻译');
  }
  
  // 过长检查
  if (translatedText.length > sourceText.length * 3) {
    score -= 1;
    issues.push('过长');
  }
  
  return {
    score: Math.max(1, Math.min(10, score)),
    issues,
    description: issues.length > 0 ? `发现问题: ${issues.join(', ')}` : '翻译质量良好',
    suggestion: issues.length > 0 ? '建议人工复核' : '可直接使用'
  };
}

// ============================================================
// 模型调用封装（支持 CC Switch 和兜底方案）
// ============================================================

// 模型 A - 翻译第一遍
async function modelA_generate(sourceText, targetLang, glossary = {}, refs = '') {
  console.log(`[Model A] 翻译一: ${sourceText.substring(0, 40)}... → ${targetLang}`);
  const cfg = SETTINGS.models.A;
  if (modelConfigured(cfg)) {
    try {
      const glossaryText = Object.keys(glossary).length > 0
        ? `\n术语表（请严格遵守）：\n${Object.entries(glossary).map(([k, v]) => `${k} → ${v}`).join('\n')}`
        : '';
      const prompt = fillPrompt(cfg.prompt, { targetLang: langName(targetLang), sourceText, glossary: glossaryText, refs: refs || '' });
      const result = await callLLM(cfg, prompt);
      return { translation: result.translation || sourceText, confidence: result.confidence || 50, model: cfg.model };
    } catch (error) {
      console.error('[Model A] LLM error, fallback:', error.message);
    }
  }
  const fb = await fallbackTranslate(sourceText, targetLang);
  const unchanged = fb.translation === sourceText;
  return { translation: fb.translation || sourceText, confidence: unchanged ? 30 : (fb.engine === 'mymemory' ? 72 : 68),
    model: fb.engine === 'none' ? 'no-engine-fallback' : `${fb.engine}-translate-fallback` };
}

// 模型 B - 翻译第二遍（独立翻译，不看 A 的结果）
async function modelB_generate(sourceText, targetLang, glossary = {}, refs = '') {
  console.log(`[Model B] 翻译二: ${sourceText.substring(0, 40)}... → ${targetLang}`);
  const cfg = SETTINGS.models.B;
  if (modelConfigured(cfg)) {
    try {
      const glossaryText = Object.keys(glossary).length > 0
        ? `\n术语表（请严格遵守）：\n${Object.entries(glossary).map(([k, v]) => `${k} → ${v}`).join('\n')}`
        : '';
      const prompt = fillPrompt(cfg.prompt, { targetLang: langName(targetLang), sourceText, glossary: glossaryText, refs: refs || '' });
      const result = await callLLM(cfg, prompt);
      return { translation: result.translation || sourceText, confidence: result.confidence || 50, model: cfg.model };
    } catch (error) {
      console.error('[Model B] LLM error, fallback:', error.message);
    }
  }
  const fb = await fallbackTranslate(sourceText, targetLang);
  const unchanged = fb.translation === sourceText;
  return { translation: fb.translation || sourceText, confidence: unchanged ? 30 : (fb.engine === 'mymemory' ? 70 : 66),
    model: fb.engine === 'none' ? 'no-engine-fallback' : `${fb.engine}-translate-fallback-b` };
}

// 模型 C - 独立审校+仲裁：结合全部上下文(原文/其他语言/场景/术语表)审校 A/B 两版
async function modelC_arbitrate(sourceText, transA, transB, targetLang, glossary = {}, refs = '') {
  console.log(`[Model C] 裁决: A="${String(transA).substring(0, 25)}" vs B="${String(transB).substring(0, 25)}"`);
  const cfg = SETTINGS.models.C;
  if (modelConfigured(cfg)) {
    try {
      const glossaryText = Object.keys(glossary).length > 0
        ? `\n术语表（请严格核对）：\n${Object.entries(glossary).map(([k, v]) => `${k} → ${v}`).join('\n')}`
        : '';
      const prompt = fillPrompt(cfg.prompt, { sourceText, transA, transB, targetLang: langName(targetLang), glossary: glossaryText, refs: refs || '' });
      const r = await callLLM(cfg, prompt);
      return {
        final: r.final || transA,
        consistency: typeof r.consistency === 'number' ? r.consistency : 5,
        chosen: r.chosen || 'A',
        divergence: r.divergence || '',
        model: cfg.model
      };
    } catch (error) {
      console.error('[Model C] LLM error, fallback to rule arbitration:', error.message);
    }
  }
  // 兜底裁决：字符串归一化后比对一致性
  const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const same = norm(transA) === norm(transB);
  const consistency = same ? 10 : (norm(transA) && norm(transB) ? 5 : 2);
  return { final: transA || transB, consistency, chosen: 'A', divergence: same ? '' : '两版不一致（规则兜底无法判断优劣）', model: 'rule-based-arbiter' };
}
// ============================================================
// API 路由
// ============================================================

// 首页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'translation-ui.html'));
});

// 支持的语种列表
app.get('/api/langs', (req, res) => {
  const list = Object.entries(LANGS).map(([code, v]) => ({ code, name: v.name, flag: v.flag }));
  res.json({ success: true, langs: list });
});

// 抽象流体渐变背景（可在线用 URL，也可下载到本地）
app.get('/api/background.svg', (req, res) => {
  const dl = req.query.download === '1';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f4fbf8"/><stop offset="0.5" stop-color="#f3f8fc"/><stop offset="1" stop-color="#f6f3fc"/>
    </linearGradient>
    <radialGradient id="g1" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#c7f0e0" stop-opacity="0.9"/><stop offset="1" stop-color="#c7f0e0" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="g2" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#d3e9fb" stop-opacity="0.85"/><stop offset="1" stop-color="#d3e9fb" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="g3" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#e8ddfb" stop-opacity="0.8"/><stop offset="1" stop-color="#e8ddfb" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft"><feGaussianBlur stdDeviation="60"/></filter>
  </defs>
  <rect width="1920" height="1080" fill="url(#bg)"/>
  <g filter="url(#soft)">
    <path d="M-100,300 C300,120 620,360 900,240 C1200,110 1500,340 2050,220 L2050,-120 L-100,-120 Z" fill="url(#g1)" opacity="0.75"/>
    <ellipse cx="330" cy="760" rx="520" ry="420" fill="url(#g2)"/>
    <ellipse cx="1600" cy="880" rx="560" ry="440" fill="url(#g3)"/>
    <ellipse cx="1500" cy="200" rx="420" ry="360" fill="url(#g1)" opacity="0.6"/>
    <path d="M-100,900 C400,760 700,1020 1100,880 C1500,740 1800,980 2050,860 L2050,1200 L-100,1200 Z" fill="url(#g3)" opacity="0.6"/>
  </g>
</svg>`;
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  if (dl) res.setHeader('Content-Disposition', 'attachment; filename="translation-bg.svg"');
  res.send(svg);
});

// 系统状态
app.get('/api/status', (req, res) => {
  const m = SETTINGS.models;
  const active = ['A', 'B', 'C'].filter(k => modelConfigured(m[k]));
  res.json({
    success: true,
    mode: active.length > 0 ? 'llm' : 'fallback',
    models: { A: m.A.model || '', B: m.B.model || '', C: m.C.model || '' },
    configured: { A: modelConfigured(m.A), B: modelConfigured(m.B), C: modelConfigured(m.C) },
    message: active.length > 0
      ? `大模型模式（已配置 ${active.join('/')}）`
      : '兜底模式：MyMemory/Google 翻译 + 规则校验（未配置任何大模型）'
  });
});

// 脱敏输出（apiKey 不回传明文）
function maskedSettings() {
  const out = { models: {} };
  ['A', 'B', 'C'].forEach(k => {
    const m = SETTINGS.models[k];
    out.models[k] = { protocol: m.protocol || 'openai', baseUrl: m.baseUrl || '', apiKey: m.apiKey ? '••••••' : '', model: m.model || '', prompt: m.prompt || '', temperature: m.temperature };
  });
  return out;
}

// 读取默认 prompt（供前端“恢复默认”）
app.get('/api/settings/default-prompts', (req, res) => {
  res.json({ success: true, prompts: DEFAULT_PROMPTS });
});

// 读取/保存模型设置（运行时切换，无需重启）
app.get('/api/settings', (req, res) => {
  res.json({ success: true, settings: maskedSettings() });
});
app.post('/api/settings', (req, res) => {
  const body = req.body || {};
  const models = body.models || {};
  ['A', 'B', 'C'].forEach(k => {
    const inc = models[k];
    if (!inc) return;
    const cur = SETTINGS.models[k];
    if (inc.protocol === 'openai' || inc.protocol === 'openai-responses' || inc.protocol === 'anthropic') cur.protocol = inc.protocol;
    if (typeof inc.baseUrl === 'string') cur.baseUrl = inc.baseUrl.trim();
    if (typeof inc.model === 'string') cur.model = inc.model.trim();
    if (typeof inc.prompt === 'string' && inc.prompt.length) cur.prompt = inc.prompt;
    if (inc.temperature != null && !isNaN(inc.temperature)) cur.temperature = Number(inc.temperature);
    // apiKey：留空或占位符则不改，否则覆盖
    if (typeof inc.apiKey === 'string' && inc.apiKey && inc.apiKey !== '••••••') cur.apiKey = inc.apiKey.trim();
  });
  saveSettings();
  res.json({ success: true, settings: maskedSettings() });
});

// 测试某个模型连通性（body: {step,protocol,baseUrl,apiKey,model}）
app.post('/api/settings/test', async (req, res) => {
  const b = req.body || {};
  const stored = (b.step && SETTINGS.models[b.step]) ? SETTINGS.models[b.step] : {};
  const cfg = {
    protocol: b.protocol || stored.protocol || 'openai',
    baseUrl: b.baseUrl != null ? b.baseUrl : stored.baseUrl,
    model: b.model != null ? b.model : stored.model,
    apiKey: (b.apiKey && b.apiKey !== '••••••') ? b.apiKey : stored.apiKey,
    temperature: 0
  };
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
    return res.json({ success: true, reachable: false, error: '缺少地址/Key/模型名' });
  }
  try {
    const r = await callLLM(cfg, '请回复 JSON：{"ok":true}');
    res.json({ success: true, reachable: true, sample: r });
  } catch (e) {
    res.json({ success: true, reachable: false, error: e.message });
  }
});

// 上传并解析 Excel/CSV
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const filePath = req.file.path;
    // multer 把 originalname 当 latin1 解析，中文名会乱码 → 还原成 UTF-8
    const fixName = s => { try { return Buffer.from(String(s || ''), 'latin1').toString('utf8'); } catch { return String(s || ''); } };
    const origName = fixName(req.file.originalname);
    const isCsv = origName.toLowerCase().endsWith('.csv') || /text\/csv|application\/csv/.test(req.file.mimetype || '');

    let workbook;
    if (isCsv) {
      // CSV：按 UTF-8 读取字符串并去除 BOM，避免中文乱码（temp 文件无扩展名会导致 XLSX 误判编码）
      let raw = fs.readFileSync(filePath, 'utf8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      workbook = XLSX.read(raw, { type: 'string', raw: true });
    } else {
      // Excel：按二进制缓冲读取
      const buf = fs.readFileSync(filePath);
      workbook = XLSX.read(buf, { type: 'buffer' });
    }
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    // 解析表头和数据
    const headers = data[0] || [];
    const rows = data.slice(1).filter(row => row.some(cell => cell)); // 过滤空行

    const taskId = `task_${Date.now()}`;
    const task = {
      id: taskId,
      filename: origName,
      uploadTime: new Date().toISOString(),
      headers,
      rowCount: rows.length,
      status: 'uploaded',
      data: rows
    };

    DB.tasks.push(task);
    saveDB();

    res.json({
      success: true,
      taskId,
      headers,
      rowCount: rows.length,
      preview: rows.slice(0, 5)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 启动翻译流水线
app.post('/api/translate', async (req, res) => {
  const { taskId, columnIndex, targetLangs, refColumns, refTypes } = req.body;

  const task = DB.tasks.find(t => t.id === taskId);
  if (!task) {
    return res.status(404).json({ success: false, error: 'Task not found' });
  }

  // 防止重复启动
  if (task.status === 'translating') {
    return res.json({ success: true, message: 'Translation already in progress' });
  }

  task.status = 'translating';
  task.targetLangs = targetLangs;
  task.columnIndex = columnIndex;
  task.refColumns = Array.isArray(refColumns) ? refColumns.filter(i => i !== columnIndex) : []; // 参考列（排除原文列自身）
  task.refTypes = (refTypes && typeof refTypes === 'object') ? refTypes : {}; // {列索引: 'lang'|'scene'} 用户手选类型
  saveDB();

  // 异步处理翻译流水线
  processTranslationPipeline(taskId, columnIndex, targetLangs).catch(console.error);

  res.json({ success: true, message: 'Translation pipeline started' });
});

// 获取任务状态
app.get('/api/task/:taskId', (req, res) => {
  const task = DB.tasks.find(t => t.id === req.params.taskId);
  if (!task) {
    return res.status(404).json({ success: false, error: 'Task not found' });
  }

  const results = DB.results.filter(r => r.taskId === req.params.taskId);
  const reviews = DB.reviews.filter(r => r.taskId === req.params.taskId);

  // 进度统计
  const expectedTotal = (task.data ? task.data.filter(row => row[task.columnIndex]).length : 0)
    * (task.targetLangs ? task.targetLangs.length : 0);
  const done = results.length;
  const needsReviewCount = results.filter(r => r.needsReview && !reviews.find(rv => rv.resultId === r.id)).length;
  const reviewedCount = reviews.length;

  res.json({
    success: true,
    task,
    results,
    reviews,
    progress: {
      status: task.status,
      done,
      expectedTotal,
      percent: expectedTotal > 0 ? Math.round(done / expectedTotal * 100) : (task.status === 'completed' ? 100 : 0),
      needsReviewCount,
      reviewedCount
    }
  });
});

// 人工复核
app.post('/api/review', (req, res) => {
  const { taskId, resultId, decision, finalText } = req.body;

  const review = {
    id: `review_${Date.now()}`,
    taskId,
    resultId,
    decision, // 'accept' | 'fix' | 'reject'
    finalText,
    reviewTime: new Date().toISOString()
  };

  DB.reviews.push(review);

  // 如果是修正，加入训练样本
  if (decision === 'fix' && finalText) {
    const result = DB.results.find(r => r.id === resultId);
    if (result) {
      DB.trainingSamples.push({
        id: `sample_${Date.now()}`,
        sourceText: result.sourceText,
        targetLang: result.targetLang,
        modelA_text: result.translation,
        human_text: finalText,
        score: result.validationScore,
        createdAt: new Date().toISOString()
      });
    }
  }

  saveDB();
  res.json({ success: true, review });
});

// 导出结果
app.get('/api/export/:taskId', (req, res) => {
  const task = DB.tasks.find(t => t.id === req.params.taskId);
  if (!task) {
    return res.status(404).json({ success: false, error: 'Task not found' });
  }

  const results = DB.results.filter(r => r.taskId === req.params.taskId);
  const reviews = DB.reviews.filter(r => r.taskId === req.params.taskId);

  // 构建导出数据
  const exportData = task.data.map((row, rowIndex) => {
    const sourceText = row[task.columnIndex];
    const rowResults = {};

    task.targetLangs.forEach(lang => {
      const result = results.find(r => r.rowIndex === rowIndex && r.targetLang === lang);
      const review = result ? reviews.find(rv => rv.resultId === result.id) : null;

      if (review && review.decision === 'fix') {
        rowResults[`${lang}_translation`] = review.finalText;
      } else if (result) {
        rowResults[`${lang}_translation`] = result.translation;
      } else {
        rowResults[`${lang}_translation`] = '';
      }
    });

    return { ...Object.fromEntries(row.map((cell, i) => [task.headers[i] || `col_${i}`, cell])), ...rowResults };
  });

  // 创建工作簿
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(exportData);
  XLSX.utils.book_append_sheet(wb, ws, 'Translations');

  // 构造下载文件名：原文件名(去扩展名) + (翻译后) + 扩展名
  const base = String(task.filename || task.id).replace(/\.(xlsx|xls|csv)$/i, '');
  const dlName = ext => `${base}(翻译后).${ext}`;
  // 中文文件名需 RFC5987 编码放进 Content-Disposition，否则浏览器按 latin1 解析成乱码
  const setDownloadName = (name) => {
    const encoded = encodeURIComponent(name);
    res.setHeader('Content-Disposition', `attachment; filename="download.${name.split('.').pop()}"; filename*=UTF-8''${encoded}`);
  };

  const format = (req.query.format || 'xlsx').toLowerCase();
  if (format === 'csv') {
    const csv = XLSX.utils.sheet_to_csv(ws);
    const outputPath = path.join(OUTPUT_DIR, `${task.id}_export.csv`);
    // 加 BOM 保证 Excel 正确识别 UTF-8 中文
    fs.writeFileSync(outputPath, '\ufeff' + csv, 'utf8');
    setDownloadName(dlName('csv'));
    return res.sendFile(outputPath);
  }

  const outputPath = path.join(OUTPUT_DIR, `${task.id}_export.xlsx`);
  XLSX.writeFile(wb, outputPath);
  setDownloadName(dlName('xlsx'));
  res.sendFile(outputPath);
});

// 导出「待复核条目」——只含需人工复核的行，方便发给同事看
app.get('/api/export-review/:taskId', (req, res) => {
  const task = DB.tasks.find(t => t.id === req.params.taskId);
  if (!task) return res.status(404).json({ success: false, error: 'Task not found' });

  const results = DB.results.filter(r => r.taskId === req.params.taskId);
  const reviews = DB.reviews.filter(r => r.taskId === req.params.taskId);
  const sevName = { high: '高分歧', medium: '中分歧', low: '低分歧' };
  const refCols = task.refColumns || [];
  const refTypes = task.refTypes || {};

  // 取某行的参考内容，按类型分成「参考语种译文」「参考场景说明」两串
  const refCells = (rowIndex) => {
    const row = task.data[rowIndex] || [];
    const langs = [], scenes = [];
    for (const ci of refCols) {
      const val = row[ci];
      if (val === undefined || val === null || String(val).trim() === '') continue;
      const header = task.headers[ci] || `列${ci + 1}`;
      const t = refTypes[ci] || refTypes[String(ci)] || (isLangColumn(header) ? 'lang' : 'scene');
      (t === 'lang' ? langs : scenes).push(`${header}: ${String(val).trim()}`);
    }
    return { langs: langs.join(' | '), scenes: scenes.join(' | ') };
  };

  // 只取需复核且尚未处理的条目
  const rows = results
    .filter(r => r.needsReview && !reviews.find(rv => rv.resultId === r.id))
    .map(r => {
      const ref = refCells(r.rowIndex);
      return {
        '原文': r.sourceText,
        '目标语言': langName(r.targetLang),
        '参考语种译文': ref.langs,
        '参考场景说明': ref.scenes,
        '译文A': r.translationA || '',
        '译文B': r.translationB || '',
        'C推荐最终译文': r.translation || '',
        'C选用': r.chosen === 'merged' ? '融合' : (r.chosen || ''),
        '一致性评分': r.consistency,
        '分歧说明': r.divergence || '',
        '风险等级': sevName[r.reviewSeverity] || '需复核',
        '人工修正译文': ''  // 留空列，供同事填写
      };
    });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ '提示': '当前没有需要复核的条目' }]);
  XLSX.utils.book_append_sheet(wb, ws, 'ReviewQueue');

  const base = String(task.filename || task.id).replace(/\.(xlsx|xls|csv)$/i, '');
  const setDownloadName = (name) => {
    res.setHeader('Content-Disposition', `attachment; filename="review.${name.split('.').pop()}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  };
  const format = (req.query.format || 'xlsx').toLowerCase();
  if (format === 'csv') {
    const csv = XLSX.utils.sheet_to_csv(ws);
    const outputPath = path.join(OUTPUT_DIR, `${task.id}_review.csv`);
    fs.writeFileSync(outputPath, '\ufeff' + csv, 'utf8');
    setDownloadName(`${base}(待复核).csv`);
    return res.sendFile(outputPath);
  }
  const outputPath = path.join(OUTPUT_DIR, `${task.id}_review.xlsx`);
  XLSX.writeFile(wb, outputPath);
  setDownloadName(`${base}(待复核).xlsx`);
  res.sendFile(outputPath);
});

// 术语表管理
app.get('/api/glossary', (req, res) => {
  res.json({ success: true, glossary: DB.glossary });
});

app.post('/api/glossary', (req, res) => {
  const { term, translation } = req.body;
  DB.glossary[term] = translation;
  saveDB();
  res.json({ success: true, glossary: DB.glossary });
});

// 训练样本查看
app.get('/api/training-samples', (req, res) => {
  res.json({
    success: true,
    total: DB.trainingSamples.length,
    samples: DB.trainingSamples.slice(-50) // 最近 50 条
  });
});

// ============================================================
// 翻译流水线核心逻辑
// ============================================================

// 并发度：大模型可并行请求，兜底免费接口易被限流故保守
const CONCURRENCY = parseInt(process.env.TRANSLATE_CONCURRENCY || '6', 10);

// 判断列名是否为语言代码 → 语种译文；否则 → 场景/用途说明
function isLangColumn(header) {
  const h = String(header || '').trim().toLowerCase();
  const codes = ['en','en-us','en-gb','id','th','vi','ph','fil','tl','ar','tc','sc','zh','zh-cn','zh-tw','cn','tw','hk','ja','jp','ko','kr','es','fr','pt','de','it','ru','nl','ms','hi'];
  if (codes.includes(h)) return true;
  return /^(text_|val_|value_)?(en|id|th|vi|ph|fil|tl|ar|tc|sc|zh|cn|tw|ja|jp|ko|kr|es|fr|pt|de|it|ru)(_|$|-)/.test(h);
}

// 从参考列构建上下文文本，按「其他语言译文」与「场景/用途说明」分组，帮模型消歧
// 类型优先用用户手选(task.refTypes)，缺省再自动判断
function buildRefs(task, row) {
  const cols = task.refColumns || [];
  if (!cols.length) return '';
  const types = task.refTypes || {};
  const langParts = [], sceneParts = [];
  for (const ci of cols) {
    const val = row[ci];
    if (val === undefined || val === null || String(val).trim() === '') continue;
    const header = task.headers[ci] || `列${ci + 1}`;
    const line = `${header}: ${String(val).trim()}`;
    const t = types[ci] || types[String(ci)] || (isLangColumn(header) ? 'lang' : 'scene');
    (t === 'lang' ? langParts : sceneParts).push(line);
  }
  if (!langParts.length && !sceneParts.length) return '';
  let out = '\n\n参考信息（用来帮你准确理解含义与语境，但你只需翻译上面的「源内容」本身，不要翻译这些参考）：';
  if (sceneParts.length) out += `\n【应用场景/用途说明】\n${sceneParts.join('\n')}`;
  if (langParts.length) out += `\n【该文案的其他语言译文】\n${langParts.join('\n')}`;
  return out;
}

async function processTranslationPipeline(taskId, columnIndex, targetLangs) {
  const task = DB.tasks.find(t => t.id === taskId);
  if (!task) return;

  const anyLLM = ['A', 'B', 'C'].some(k => modelConfigured(SETTINGS.models[k]));
  const conc = anyLLM ? CONCURRENCY : 2; // 免费兜底并发度压低防限流
  console.log(`[Pipeline] Starting task ${taskId} (${anyLLM ? 'LLM' : 'Fallback'} mode, 并发=${conc}, 参考列=${(task.refColumns || []).length})`);

  const totalRows = task.data.length;

  const REVIEW_THRESHOLD = parseInt(process.env.REVIEW_THRESHOLD || '6', 10); // 一致性 ≤ 阈值 → 人工复核

  // 处理单条 (rowIndex, lang) 作业：A/B 双翻译 → C 比对裁决
  async function processOne(rowIndex, lang) {
    const raw = task.data[rowIndex][columnIndex];
    if (raw === undefined || raw === null || String(raw) === '') return null;
    const sourceText = String(raw);
    const refs = buildRefs(task, task.data[rowIndex]);

    let aRes, bRes, cRes;
    try {
      // A、B 两个模型独立翻译（并行）
      [aRes, bRes] = await Promise.all([
        modelA_generate(sourceText, lang, DB.glossary, refs),
        modelB_generate(sourceText, lang, DB.glossary, refs)
      ]);
      // C 比对裁决，择优/融合 + 一致性评分
      cRes = await modelC_arbitrate(sourceText, aRes.translation, bRes.translation, lang, DB.glossary, refs);
    } catch (err) {
      console.error(`[Pipeline] Row ${rowIndex + 1}/${lang} 失败: ${err.message}`);
      aRes = aRes || { translation: sourceText, confidence: 0, model: 'error' };
      bRes = bRes || { translation: sourceText, confidence: 0, model: 'error' };
      cRes = { final: aRes.translation, consistency: 1, chosen: 'A', divergence: err.message, model: 'error' };
    }

    const needsReview = cRes.consistency <= REVIEW_THRESHOLD;
    const result = {
      id: `result_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      taskId, rowIndex, sourceText, targetLang: lang,
      translation: cRes.final,            // 最终译文 = C 裁决结果
      translationA: aRes.translation,     // A 版
      translationB: bRes.translation,     // B 版
      chosen: cRes.chosen,                // C 选了 A/B/merged
      consistency: cRes.consistency,      // 一致性评分 1-10
      divergence: cRes.divergence,        // 分歧说明
      validationScore: cRes.consistency,  // 兼容旧字段：用一致性作为分数
      confidence: Math.round((aRes.confidence + bRes.confidence) / 2),
      needsReview,
      reviewReason: needsReview ? (cRes.divergence || `两版一致性偏低(${cRes.consistency}/10)`) : '',
      reviewSeverity: cRes.consistency <= 3 ? 'high' : cRes.consistency <= 6 ? 'medium' : 'low',
      modelA: aRes.model, modelB: bRes.model, modelC: cRes.model,
      createdAt: new Date().toISOString()
    };
    DB.results.push(result);
    return result;
  }

  for (const lang of targetLangs) {
    console.log(`[Pipeline] Processing language: ${lang}`);
    const rowIdxs = [];
    for (let i = 0; i < totalRows; i++) rowIdxs.push(i);

    for (let i = 0; i < rowIdxs.length; i += conc) {
      const chunk = rowIdxs.slice(i, i + conc);
      await Promise.all(chunk.map(ri => processOne(ri, lang)));
      saveDB();
      console.log(`[Pipeline] ${lang} 进度 ${Math.min(i + conc, rowIdxs.length)}/${totalRows}`);
    }
  }

  task.status = 'completed';
  saveDB();
  console.log(`[Pipeline] Task ${taskId} completed`);
}

// ============================================================
// 启动服务
// ============================================================

app.listen(PORT, () => {
  console.log('');
  console.log('🌍 AI 翻译流水线平台启动成功！');
  console.log('================================');
  console.log(`📍 访问地址: http://localhost:${PORT}`);
  const anyLLM = ['A', 'B', 'C'].some(k => modelConfigured(SETTINGS.models[k]));
  console.log(`🤖 运行模式: ${anyLLM ? '大模型模式' : 'Fallback (MyMemory/Google + 规则校验)'}`);
  ['A', 'B', 'C'].forEach(k => {
    const m = SETTINGS.models[k];
    if (modelConfigured(m)) console.log(`   模型 ${k}: ${m.model} @ ${m.baseUrl}`);
  });
  console.log(`📁 上传目录: ${UPLOAD_DIR}`);
  console.log(`📤 导出目录: ${OUTPUT_DIR}`);
  console.log(`💾 数据库: ${DB_FILE}`);
  console.log('================================');
  console.log('');
  if (!anyLLM) {
    console.log('💡 提示：当前兜底模式。在网站右上角「模型设置」为 A/B/C 各填地址+Key+模型名即可切换大模型。');
    console.log('');
  }
});
