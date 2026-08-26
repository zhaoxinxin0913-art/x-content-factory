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
// A 可用: {targetLang} {sourceText} {glossary}
// B 可用: {sourceText} {translatedText} {targetLang}
// C 可用: {reports}
const DEFAULT_PROMPTS = {
  A: `你是一个专业的翻译专家。
任务：将以下内容翻译成{targetLang}。

要求：
1. 保持专业术语准确性
2. 符合目标语言表达习惯
3. 简洁清晰，避免冗余
{glossary}

源内容：{sourceText}

请直接返回翻译结果，不要附加解释。同时评估你的翻译置信度（0-100）。
返回 JSON 格式：
{"translation":"翻译结果","confidence":85}`,
  B: `你是一个严格的翻译质量校验专家。
任务：评估以下翻译的质量。

源内容（原文）：{sourceText}
翻译结果：{translatedText}
目标语言：{targetLang}

评估维度：准确性、术语、通顺度、一致性。
请给出：总分(1-10)、问题类型(术语错误/漏译/歧义/不通顺/过长/不当)、具体问题描述、修改建议。
返回 JSON 格式：
{"score":8,"issues":["术语错误"],"description":"具体问题","suggestion":"修改建议"}`,
  C: `你是一个翻译问题汇总专家。
以下是一批翻译校验报告（JSON 数组）：
{reports}

请提炼出需要人工复核的共性问题与改进建议。
返回 JSON 格式：
{"summary":"共性问题概述","suggestions":["建议1","建议2"]}`
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

// 模型 A - 生成器（翻译）
async function modelA_generate(sourceText, targetLang, glossary = {}) {
  console.log(`[Model A] Translating: ${sourceText.substring(0, 50)}... to ${targetLang}`);

  const cfg = SETTINGS.models.A;
  if (modelConfigured(cfg)) {
    try {
      const glossaryText = Object.keys(glossary).length > 0
        ? `\n术语表（请严格遵守）：\n${Object.entries(glossary).map(([k, v]) => `${k} → ${v}`).join('\n')}`
        : '';
      const prompt = fillPrompt(cfg.prompt, { targetLang: langName(targetLang), sourceText, glossary: glossaryText });
      const result = await callLLM(cfg, prompt);
      return {
        translation: result.translation || sourceText,
        confidence: result.confidence || 50,
        model: cfg.model
      };
    } catch (error) {
      console.error('[Model A] LLM error, fallback to free engine:', error.message);
    }
  }

  // 兜底方案：MyMemory 优先，Google 次之
  const fb = await fallbackTranslate(sourceText, targetLang);
  const translated = fb.translation;
  const unchanged = translated === sourceText;
  return {
    translation: translated || sourceText,
    confidence: unchanged ? 30 : (fb.engine === 'mymemory' ? 72 : 68),
    model: fb.engine === 'none' ? 'no-engine-fallback' : `${fb.engine}-translate-fallback`
  };
}

// 模型 B - 校验器（质检）
async function modelB_validate(sourceText, translatedText, targetLang) {
  console.log(`[Model B] Validating: ${translatedText.substring(0, 50)}...`);

  const cfg = SETTINGS.models.B;
  if (modelConfigured(cfg)) {
    try {
      const prompt = fillPrompt(cfg.prompt, { sourceText, translatedText, targetLang: langName(targetLang) });
      const result = await callLLM(cfg, prompt);
      return {
        score: result.score || 5,
        issues: result.issues || [],
        description: result.description || '',
        suggestion: result.suggestion || '',
        model: cfg.model
      };
    } catch (error) {
      console.error('[Model B] LLM error, fallback to rule validation:', error.message);
    }
  }

  // 兜底方案：简单规则校验
  const validation = simpleQualityScore(sourceText, translatedText, targetLang);
  return {
    ...validation,
    model: 'rule-based-validator-fallback'
  };
}

// 模型 C - 提取器（问题汇总）
async function modelC_extract(validationReports) {
  console.log(`[Model C] Extracting issues from ${validationReports.length} reports`);

  // 规则提取：评分 ≤ 6 或有问题标签的项（决定哪些进人工复核队列）
  const needsReview = validationReports
    .map((r, i) => ({
      index: i + 1,
      report: r,
      severity: r.validationScore <= 5 ? 'high' : r.validationScore <= 6 ? 'medium' : 'low',
      category: (r.validationIssues && r.validationIssues.length > 0) ? r.validationIssues[0] : '低分',
      reason: r.validationDescription || '翻译质量需要改进',
      priority: r.validationScore <= 5 ? 1 : 2
    }))
    .filter(item => item.report.validationScore <= 6 || (item.report.validationIssues && item.report.validationIssues.length > 0))
    .sort((a, b) => a.priority - b.priority);

  const cfg = SETTINGS.models.C;
  let summary = null;
  if (modelConfigured(cfg) && needsReview.length > 0) {
    try {
      const reports = JSON.stringify(needsReview.map(x => ({
        source: x.report.sourceText, translation: x.report.translation,
        score: x.report.validationScore, issues: x.report.validationIssues
      })));
      const prompt = fillPrompt(cfg.prompt, { reports });
      summary = await callLLM(cfg, prompt);
    } catch (error) {
      console.error('[Model C] LLM error, skip summary:', error.message);
    }
  }

  return {
    needsReview,
    summary,
    stats: { total: validationReports.length, issues: needsReview.length, needReview: needsReview.length },
    model: modelConfigured(cfg) ? cfg.model : 'rule-based-extractor'
  };
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
    const origName = (req.file.originalname || '').toLowerCase();
    const isCsv = origName.endsWith('.csv') || /text\/csv|application\/csv/.test(req.file.mimetype || '');

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
      filename: req.file.originalname,
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
  const { taskId, columnIndex, targetLangs } = req.body;

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

  const format = (req.query.format || 'xlsx').toLowerCase();
  if (format === 'csv') {
    const csv = XLSX.utils.sheet_to_csv(ws);
    const outputPath = path.join(OUTPUT_DIR, `${task.id}_export.csv`);
    // 加 BOM 保证 Excel 正确识别 UTF-8 中文
    fs.writeFileSync(outputPath, '\ufeff' + csv, 'utf8');
    return res.download(outputPath, `${task.filename || task.id}_translated.csv`);
  }

  const outputPath = path.join(OUTPUT_DIR, `${task.id}_export.xlsx`);
  XLSX.writeFile(wb, outputPath);
  res.download(outputPath, `${task.filename || task.id}_translated.xlsx`);
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

async function processTranslationPipeline(taskId, columnIndex, targetLangs) {
  const task = DB.tasks.find(t => t.id === taskId);
  if (!task) return;

  const anyLLM = ['A', 'B', 'C'].some(k => modelConfigured(SETTINGS.models[k]));
  console.log(`[Pipeline] Starting task ${taskId} (${anyLLM ? 'LLM' : 'Fallback'} mode)`);

  const batchSize = 5; // 每批处理 5 条
  const totalRows = task.data.length;

  for (let lang of targetLangs) {
    console.log(`[Pipeline] Processing language: ${lang}`);

    for (let i = 0; i < totalRows; i += batchSize) {
      const batch = task.data.slice(i, Math.min(i + batchSize, totalRows));
      const validationReports = [];

      for (let j = 0; j < batch.length; j++) {
        const rowIndex = i + j;
        const raw = batch[j][columnIndex];
        if (raw === undefined || raw === null || raw === '') continue;
        const sourceText = String(raw); // 单元格可能是数字/日期，统一转字符串

        console.log(`[Pipeline] Row ${rowIndex + 1}/${totalRows} - ${sourceText.substring(0, 50)}...`);

        let aResult, bResult;
        try {
          // Step 1: 模型 A 生成翻译
          aResult = await modelA_generate(sourceText, lang, DB.glossary);
          // Step 2: 模型 B 校验
          bResult = await modelB_validate(sourceText, aResult.translation, lang);
        } catch (err) {
          // 单条失败不阻断整个任务
          console.error(`[Pipeline] Row ${rowIndex + 1} 处理失败: ${err.message}`);
          aResult = { translation: sourceText, confidence: 0, model: 'error' };
          bResult = { score: 1, issues: ['处理异常'], description: err.message, suggestion: '需人工复核', model: 'error' };
        }

        // 保存结果
        const result = {
          id: `result_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          taskId,
          rowIndex,
          sourceText,
          targetLang: lang,
          translation: aResult.translation,
          confidence: aResult.confidence,
          validationScore: bResult.score,
          validationIssues: bResult.issues,
          validationDescription: bResult.description,
          validationSuggestion: bResult.suggestion,
          modelA: aResult.model,
          modelB: bResult.model,
          createdAt: new Date().toISOString()
        };

        DB.results.push(result);
        validationReports.push(result);

        // 节流（兜底 MyMemory/Google 免费接口有频率限制，放慢一点更稳）
        // 节流（LLM 慢、免费接口有频率限制）
        await new Promise(resolve => setTimeout(resolve, anyLLM ? 500 : 350));
      }

      // Step 3: 每批次调用模型 C 提取问题
      if (validationReports.length > 0) {
        console.log(`[Pipeline] Model C extracting issues for batch ${Math.floor(i / batchSize) + 1}`);
        const cResult = await modelC_extract(validationReports);

        // 标记需要复核的项
        cResult.needsReview.forEach(item => {
          const result = validationReports[item.index - 1];
          if (result) {
            result.needsReview = true;
            result.reviewSeverity = item.severity;
            result.reviewCategory = item.category;
            result.reviewReason = item.reason;
          }
        });
      }

      saveDB();
      console.log(`[Pipeline] Batch ${Math.floor(i / batchSize) + 1} completed`);
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
