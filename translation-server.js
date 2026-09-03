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
// A 可用: {targetLang} {sourceText} {glossary} {refs}   —— 翻译（主）
// B 可用: {targetLang} {sourceText} {glossary} {refs}   —— 翻译（独立复核，同一套标准，不看A）
// C 可用: {targetLang} {sourceText} {transA} {transB} {glossary} {refs}  —— 独立审校+仲裁（看到全部上下文）
const DEFAULT_PROMPTS = {
  A: `你是一位专业翻译专家。任务：将「源内容」严格准确地翻译成{targetLang}。

翻译要求：
1. 忠实原意，术语、专有名词、数字、占位符必须与原文严格对应，不可增删或改写
2. 译文自然、简洁，符合目标语言的产品/UI表达习惯
3. 严格遵守术语表；有歧义时结合参考信息（其他语言译文、应用场景）判断
{glossary}{refs}

源内容：{sourceText}

只翻译「源内容」本身，不要附加解释。评估置信度（0-100）。
返回 JSON：{"translation":"翻译结果","confidence":85}`,
  B: `你是一位专业翻译专家。任务：将「源内容」严格准确地翻译成{targetLang}。（请独立完成，不要参考任何其他模型的译文。）

翻译要求：
1. 忠实原意，术语、专有名词、数字、占位符必须与原文严格对应，不可增删或改写
2. 译文自然、简洁，符合目标语言的产品/UI表达习惯
3. 严格遵守术语表；有歧义时结合参考信息（其他语言译文、应用场景）判断
{glossary}{refs}

源内容：{sourceText}

只翻译「源内容」本身，不要附加解释。评估置信度（0-100）。
返回 JSON：{"translation":"翻译结果","confidence":85}`,
  C: `你是一位资深【翻译审校与仲裁】专家。两个模型独立翻译了同一内容，请你结合全部上下文独立审校，不要盲目相信任何一方。

【完整上下文】
源内容（原文）：{sourceText}
目标语言：{targetLang}{glossary}{refs}

【两份候选译文】
候选A：{transA}
候选B：{transB}

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

// 带超时的 fetch：防止某个模型卡死拖垮整个翻译任务（默认60秒）
const LLM_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '60000', 10);
async function fetchWithTimeout(url, opts = {}, ms = LLM_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`LLM请求超时(${ms / 1000}s)`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// OpenAI Responses API：POST {baseUrl}/responses, body 用 input, 文本在 output[].content[].text
async function callOpenAIResponses(cfg, prompt, temp) {
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
  const url = /\/v1$/.test(base) ? `${base}/responses` : `${base}/v1/responses`;
  const p = prompt + '\n\n只返回 JSON，不要任何额外解释或 markdown 代码块。';
  const send = async (withTemp) => {
    const payload = withTemp ? { model: cfg.model, input: p, temperature: temp } : { model: cfg.model, input: p };
    return fetchWithTimeout(url, {
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
    return fetchWithTimeout(url, {
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
  'tr': { name: '土耳其语', google: 'tr', flag: '🇹🇷' },
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
let DB = { tasks: [], results: [], reviews: [], trainingSamples: [], glossary: {}, glossaryML: [], dnt: [] };
if (fs.existsSync(DB_FILE)) {
  try {
    DB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    // 兼容旧DB：补齐新增字段
    if (!DB.glossaryML) DB.glossaryML = [];
    if (!DB.dnt) DB.dnt = [];
  } catch (e) {
    console.error('DB load failed:', e);
  }
}
function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(DB, null, 2));
}

// 按目标语言构建生效术语表：合并单语言 glossary + 多语言 glossaryML(取对应语列) + DNT 保留源文规则
// 返回 { map: {原文:译法}, dntList: [...] }
function buildGlossary(lang) {
  const map = { ...(DB.glossary || {}) };  // 单语言表(向后兼容)
  const base = String(lang || '').toLowerCase().split('-')[0];  // ja-JP → ja
  for (const t of (DB.glossaryML || [])) {
    if (!t || !t.en) continue;
    const tr = t[base] || t[lang];
    if (tr && String(tr).trim()) map[t.en] = String(tr).trim();
  }
  return { map, dntList: DB.dnt || [] };
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

// 把术语表(map)+DNT列表 组装成注入 prompt 的文本；兼容传入 {map,dntList} 或裸 map
function glossaryToPrompt(glossary, verb = '请严格遵守') {
  let map = glossary, dntList = [];
  if (glossary && glossary.map) { map = glossary.map; dntList = glossary.dntList || []; }
  const parts = [];
  const entries = Object.entries(map || {});
  if (entries.length) {
    parts.push(`\n术语表（${verb}，锁定产品概念，允许目标语必要的语法变形）：\n${entries.map(([k, v]) => `${k} → ${v}`).join('\n')}`);
  }
  if (dntList && dntList.length) {
    parts.push(`\n不可翻译词（DNT，命中时原样保留源文，不翻译/不音译，只匹配完整词）：\n${dntList.join('、')}`);
  }
  return parts.join('\n');
}

// 模型 A - 翻译第一遍
async function modelA_generate(sourceText, targetLang, glossary = {}, refs = '') {
  console.log(`[Model A] 翻译一: ${sourceText.substring(0, 40)}... → ${targetLang}`);
  const cfg = SETTINGS.models.A;
  if (modelConfigured(cfg)) {
    try {
      const glossaryText = glossaryToPrompt(glossary, '请严格遵守');
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
      const glossaryText = glossaryToPrompt(glossary, '请严格遵守');
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
      const glossaryText = glossaryToPrompt(glossary, '请严格核对');
      const prompt = fillPrompt(cfg.prompt, { sourceText, transA, transB, targetLang: langName(targetLang), glossary: glossaryText, refs: refs || '' });
      const r = await callLLM(cfg, prompt);

      // 兼容两种输出：简版{final,consistency,chosen,divergence} 或 终审版{final_translation,decision,overall_score,auto_approve,...}
      const final = r.final || r.final_translation || transA;
      const decision = r.decision || '';
      // chosen 归一化：模型可能填 'A'/'select_a'/'select_a→A'/'rewrite'/'融合' 等，统一成 A/B/C改写/merged
      const rawChosen = String(r.chosen || decision || '').toLowerCase().trim();
      let chosen;
      if (/rewrite|改写/.test(rawChosen)) chosen = 'C改写';
      else if (/merged|融合/.test(rawChosen)) chosen = 'merged';
      else if (/select_b|→\s*b|\bb\b|译文b/.test(rawChosen)) chosen = 'B';
      else if (/select_a|→\s*a|\ba\b|译文a/.test(rawChosen)) chosen = 'A';
      else chosen = ({ select_a: 'A', select_b: 'B', rewrite: 'C改写', human_review: 'A' })[decision] || 'A';
      // consistency：优先用给定值；否则由 overall_score(0-100) 折算为 1-10
      let consistency;
      if (typeof r.consistency === 'number') consistency = r.consistency;
      else if (typeof r.overall_score === 'number') consistency = Math.round(r.overall_score / 10);
      else consistency = 5;
      // 强制送人工的信号：任一为真则压低一致性到阈值内，确保进复核队列
      const forceReview = r.auto_approve === false || r.needs_human_review === true || decision === 'human_review';
      if (forceReview) consistency = Math.min(consistency, 6);
      // divergence / review_reason 合并为分歧说明
      const divergence = r.divergence || r.review_reason || (Array.isArray(r.error_types) && r.error_types.length ? r.error_types.join('; ') : '');

      return {
        final,
        consistency,
        chosen,
        divergence,
        // 透传终审详细信息（供导出/复核参考，平台不强依赖）
        detail: {
          decision, overall_score: r.overall_score, risk_level: r.risk_level,
          scene_category: r.scene_category, auto_approve: r.auto_approve,
          semantic_accuracy: r.semantic_accuracy, completeness: r.completeness,
          locale_naturalness: r.locale_naturalness, terminology_consistency: r.terminology_consistency,
          ui_usability: r.ui_usability, format_integrity: r.format_integrity,
          error_types: r.error_types, review_reason: r.review_reason, context_needed: r.context_needed
        },
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
  // 禁止浏览器缓存页面，确保改动后用户总是拿到最新版（避免旧JS残留导致的报错）
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
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
  // 三档分流统计
  const autoCount = results.filter(r => r.route === 'auto').length;
  const spotCount = results.filter(r => r.route === 'spot_check').length;
  const humanCount = results.filter(r => r.route === 'human').length;

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
      reviewedCount,
      autoCount,        // 自动通过
      spotCount,        // 运营抽查
      humanCount        // 人工复审
    }
  });
});

// 轻量进度接口：只返回统计数字，不返回全量 results（大批量轮询时前端不卡）
app.get('/api/progress/:taskId', (req, res) => {
  const task = DB.tasks.find(t => t.id === req.params.taskId);
  if (!task) return res.status(404).json({ success: false, error: 'Task not found' });
  const results = DB.results.filter(r => r.taskId === req.params.taskId);
  const reviews = DB.reviews.filter(r => r.taskId === req.params.taskId);
  const expectedTotal = (task.data ? task.data.filter(row => row[task.columnIndex]).length : 0)
    * (task.targetLangs ? task.targetLangs.length : 0);
  const done = results.length;
  res.json({
    success: true,
    status: task.status,
    progress: {
      status: task.status,
      done,
      expectedTotal,
      percent: expectedTotal > 0 ? Math.round(done / expectedTotal * 100) : (task.status === 'completed' ? 100 : 0),
      needsReviewCount: results.filter(r => r.needsReview && !reviews.find(rv => rv.resultId === r.id)).length,
      reviewedCount: reviews.length,
      autoCount: results.filter(r => r.route === 'auto').length,
      spotCount: results.filter(r => r.route === 'spot_check').length,
      humanCount: results.filter(r => r.route === 'human').length
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

    // 防御稀疏数组/缺列/整行undefined：按索引遍历补齐，避免 Object.fromEntries 遇到空洞报错
    const safeRow = Array.isArray(row) ? row : [];
    const colCount = Math.max(safeRow.length, (task.headers || []).length);
    const baseEntries = {};
    for (let i = 0; i < colCount; i++) {
      const key = (task.headers && task.headers[i]) || `col_${i}`;
      baseEntries[key] = safeRow[i] != null ? safeRow[i] : '';
    }
    return { ...baseEntries, ...rowResults };
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
      const d = r.cDetail || {};
      const routeName = { human: '人工复审', spot_check: '运营抽查', auto: '自动通过' };
      return {
        '原文': r.sourceText,
        '目标语言': langName(r.targetLang),
        '分流': routeName[r.route] || (r.needsReview ? '需复核' : '通过'),
        '参考语种译文': ref.langs,
        '参考场景说明': ref.scenes,
        '译文A': r.translationA || '',
        '译文B': r.translationB || '',
        'C推荐最终译文': r.translation || '',
        'C裁决': d.decision || (r.chosen === 'merged' ? '融合' : ('译文' + (r.chosen || ''))),
        'C总评分': (typeof d.overall_score === 'number' ? d.overall_score : ''),
        '风险等级': d.risk_level || (sevName[r.reviewSeverity] || '需复核'),
        '程序检查': Array.isArray(r.programChecks) && r.programChecks.length ? '❌ ' + r.programChecks.join('; ') : '✓ 通过',
        '一致性评分': r.consistency,
        '问题类型': Array.isArray(d.error_types) ? d.error_types.join('; ') : '',
        '复核原因': d.review_reason || r.divergence || r.reviewReason || '',
        '需补充语境': d.context_needed || '',
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

// 多语言术语库 + DNT：导入/查看。terms=[{en,zh,ja,fr,pt,es,...}], dnt=[...]
app.get('/api/glossary-ml', (req, res) => {
  res.json({ success: true, terms: DB.glossaryML || [], dnt: DB.dnt || [] });
});

app.post('/api/glossary-ml', (req, res) => {
  const { terms, dnt, mode } = req.body;
  if (Array.isArray(terms)) {
    if (mode === 'replace') DB.glossaryML = [];
    const byEn = {};
    (DB.glossaryML || []).forEach(t => { if (t && t.en) byEn[t.en] = t; });
    for (const t of terms) {
      if (!t || !t.en) continue;
      byEn[t.en] = { ...(byEn[t.en] || {}), ...t };   // 按 en 去重合并
    }
    DB.glossaryML = Object.values(byEn);
  }
  if (Array.isArray(dnt)) {
    DB.dnt = mode === 'replace' ? [...new Set(dnt)] : [...new Set([...(DB.dnt || []), ...dnt])];
  }
  saveDB();
  res.json({ success: true, termsCount: (DB.glossaryML || []).length, dntCount: (DB.dnt || []).length });
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
const CONCURRENCY = parseInt(process.env.TRANSLATE_CONCURRENCY || '20', 10);

// ---- 确定性程序检查（优先级高于模型评分：即使C给98分，%s数量错也拦截）----
function programChecks(sourceText, finalText, glossary = {}, dntList = []) {
  const src = String(sourceText || ''), out = String(finalText || '');
  const issues = [];
  // emoji 匹配正则(复用于 未翻译判定 与 emoji一致性)
  const emojiReGlobal = /(\p{Extended_Pictographic}(\uFE0F|\u200D\p{Extended_Pictographic})*|[\u{1F1E6}-\u{1F1FF}]{2})/gu;
  // 1. 译文非空
  if (!out.trim()) issues.push('译文为空');
  // 2. 占位符集合一致（%s %d %1$s {name} {{var}} #num# #Username# 等）
  const phRe = /%\d*\$?[sd]|\{\{?\w+\}?\}|#\w+#/g;
  const norm = arr => (arr || []).map(x => x.replace(/^\{+|\}+$/g, '')).sort().join(',');
  const srcPh = src.match(phRe) || [], outPh = out.match(phRe) || [];
  if (srcPh.length !== outPh.length) issues.push(`占位符数量不符(原文${srcPh.length}/译文${outPh.length})`);
  else if (norm(srcPh) !== norm(outPh)) issues.push('占位符类型/名称不一致');
  // 3. HTML/XML 标签集合一致
  const tagRe = /<\/?[a-zA-Z][^>]*>/g;
  const srcTags = (src.match(tagRe) || []).sort().join(''), outTags = (out.match(tagRe) || []).sort().join('');
  if (srcTags !== outTags) issues.push('HTML标签不一致');
  // 4. URL 未改变
  const urlRe = /https?:\/\/[^\s"'<>]+/g;
  const srcUrls = (src.match(urlRe) || []).sort().join(' '), outUrls = (out.match(urlRe) || []).sort().join(' ');
  if (srcUrls !== outUrls) issues.push('URL被改动');
  // 5. 数字/金额集合一致（防金额/数量被改）
  const numRe = /\d[\d,.]*/g;
  const srcNums = (src.match(numRe) || []).map(x => x.replace(/[,]/g, '')).sort().join(','),
        outNums = (out.match(numRe) || []).map(x => x.replace(/[,]/g, '')).sort().join(',');
  if (srcNums !== outNums) issues.push('数字/金额不一致');
  // 6. 强制术语命中（宽松：术语表锁定"概念"，允许目标语语法变形，故用词干前缀匹配而非全等）
  //    如 Invite→Invitación，模型用 Invitar(动词变形)也算命中；避免死板字符串误判
  for (const [k, v] of Object.entries(glossary || {})) {
    if (!v || !src.includes(k)) continue;
    const outL = out.toLowerCase(), vL = String(v).toLowerCase();
    if (outL.includes(vL)) continue;                       // 完全包含 → 命中
    // 取译法的主词（最长的词），用前6字符(或更短)作词干，命中即算(容忍性数/冠词/变位)
    const mainWord = vL.split(/[\s/、,，]+/).filter(Boolean).sort((a, b) => b.length - a.length)[0] || vL;
    const stem = mainWord.slice(0, Math.max(4, Math.min(6, mainWord.length - 2)));
    if (stem.length >= 4 && outL.includes(stem)) continue; // 词干命中 → 算命中(允许语法变形)
    issues.push(`术语未命中: ${k}→${v}`);
  }
  // 7. 译文疑似未翻译（译文与原文完全相同且含英文字母）——排除DNT词/纯标识符(数字_符号)/极短词
  if (out.trim() && out.trim() === src.trim() && /[a-zA-Z]/.test(src)
      && !/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(out)) {
    const stripped = src.replace(emojiReGlobal, '').trim();
    const isIdentifier = /^[A-Za-z0-9 _\-\.]+$/.test(stripped) && /[0-9_]/.test(stripped); // 如 Diamond Exchange_3000
    const dntOnly = (dntList || []).some(d => d && stripped === d);                        // 整条就是个DNT词
    const tooShort = stripped.replace(/[^a-zA-Z]/g, '').length < 3;                        // 太短(如 OK, PK)
    // 含真实句子(有空格且多词)才更可能是"该翻没翻"；单词/标识符宽容处理
    if (!isIdentifier && !dntOnly && !tooShort) issues.push('译文疑似未翻译(与原文相同)');
  }
  // 8. emoji 集合一致（原文有的 emoji 译文必须原样保留，不得删除或变乱码）
  const emojiSort = s => ((String(s).match(emojiReGlobal)) || []).sort().join('');
  const srcEmoji = emojiSort(src), outEmoji = emojiSort(out);
  if (srcEmoji !== outEmoji) {
    const sc = (src.match(emojiReGlobal) || []).length, oc = (out.match(emojiReGlobal) || []).length;
    issues.push(`emoji不一致(原文${sc}个/译文${oc}个,须原样保留)`);
  }
  // 9. 译文含乱码替换符(U+FFFD)通常是编码损坏
  if (/\uFFFD/.test(out)) issues.push('译文含乱码字符(编码损坏)');
  return { pass: issues.length === 0, issues };
}

// ---- 确定性高危内容识别（借鉴 localize-anything/risk_classifier 思想，适配中英混合社交App场景）----
// 通过原文关键词确定性判定高危类别，作为 C 模型主观风险判断的兜底：
// 即使 A/B 一致、C 判 low，只要命中支付/安全/隐私/法务/处罚/未成年等敏感词，也强制不自动放行。
const HIGH_RISK_PATTERNS = [
  // 支付/资产/退款（金额与承诺错误代价高）
  /\b(payment|pay|refund|purchase|billing|withdraw|withdrawal|recharge|top ?up|subscription|subscribe|renew|charge|price|deposit|balance|wallet|transaction)\b/i,
  /支付|付款|退款|充值|提现|订阅|续费|扣款|余额|钱包|交易|账单|购买/,
  // 账号安全/认证
  /\b(password|passcode|login|log ?in|sign ?in|sign ?out|verification code|two.?factor|2fa|authenticate|authentication|security|account security)\b/i,
  /密码|验证码|登录|登陆|注销|账号安全|身份验证|双重验证|两步验证/,
  // 隐私/权限
  /\b(privacy|permission|personal (data|information)|grant access|allow access)\b/i,
  /隐私|权限|个人信息|个人资料授权/,
  // 法务/合规/同意
  /\b(terms|policy|consent|agreement|license|disclaimer|tos|eula|compliance|legal)\b/i,
  /条款|协议|隐私政策|用户协议|授权同意|合规|法律/,
  // 处罚/封禁/申诉（治理，含义敏感）
  /\b(ban|banned|suspend|suspension|restrict|restriction|block|blocked|appeal|violation|penalty|terminate)\b/i,
  /封禁|封号|禁用|冻结|停用|限制|拉黑|申诉|违规|处罚|封停|解封/,
  // 未成年人保护
  /\b(minor|underage|child|children|parental)\b/i,
  /未成年|未成年人|儿童|监护/,
  // 破坏性操作
  /\b(delete account|delete|remove|erase|reset|revoke|cancel subscription|permanently)\b/i,
  /删除账号|注销账号|永久删除|清空|重置|撤销|解除绑定/,
];
// 返回命中的高危类别数(0=非高危)；用于确定性风险兜底
function detectHighRisk(sourceText) {
  const src = String(sourceText || '');
  let hits = 0;
  for (const re of HIGH_RISK_PATTERNS) { if (re.test(src)) hits++; }
  return hits;
}

// ---- 三档自动分流（程序检查一票否决，优先于模型评分）----
// 返回 'auto'(自动通过) | 'spot_check'(运营抽查) | 'human'(人工复审)
function classifyRoute(cRes, progCheck, transA, transB, sourceText) {
  const d = (cRes && cRes.detail) || {};
  const score = typeof d.overall_score === 'number' ? d.overall_score : (cRes.consistency * 10);
  // 确定性高危兜底：原文命中敏感词 → 风险至少拉到 high(即使C判低)，绝不因A/B一致而自动放行
  const detRisk = detectHighRisk(sourceText) > 0;
  const risk = detRisk ? 'high' : (d.risk_level || 'low');
  const decision = d.decision || '';
  const checksPass = progCheck.pass
    && d.placeholder_check !== 'fail' && d.terminology_check !== 'fail' && d.locale_check !== 'fail';

  // 程序检查是硬约束，任何情况下未过都进人工（占位符/emoji/数字/术语等确定性错误）
  if (!progCheck.pass) return 'human';
  if (d.placeholder_check === 'fail' || d.terminology_check === 'fail' || d.locale_check === 'fail') return 'human';

  // 【A/B 独立一致豁免】两个独立模型译出完全相同结果 + 程序检查全过 → 最强正确性信号
  // 非高危 → 直接自动通过(不受C软性吹毛求疵影响)；高危 → 至少抽查(不放行也不必占人工)
  const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const abIdentical = norm(transA) && norm(transA) === norm(transB);
  if (abIdentical && checksPass && decision !== 'rewrite' && decision !== 'human_review') {
    // 高危内容即使A/B一致也不自动放行，降到抽查(留一道人眼)；非高危直接自动通过
    return risk === 'high' ? 'spot_check' : 'auto';
  }
  // A/B 一致但 C 坚持要人审/重写 → 非高危降抽查减负；高危落到下方 high→human
  if (abIdentical && checksPass && risk !== 'high') return 'spot_check';

  // 人工复审（任一命中）
  if (score < 70) return 'human';                            // 阈值放宽: <70 才必须人工(原<85)
  if (d.needs_human_review === true) return 'human';
  if (risk === 'high') return 'human';                       // A/B分歧的高危内容(支付/安全/隐私/处罚/未成年)必人审
  if (decision === 'human_review') return 'human';
  // 运营抽查: 70-84 分 / medium风险 / rewrite
  if (score >= 70 && score <= 84) return 'spot_check';
  if (risk === 'medium') return 'spot_check';
  if (decision === 'rewrite') return 'spot_check';
  // 自动通过：score>=85 且 auto_approve 且 检查通过 且 low risk (原>=90)
  if (score >= 85 && d.auto_approve === true && checksPass && risk === 'low') return 'auto';
  // 兜底：score 85+ 但缺 auto_approve 信号（如兜底/简版C输出）→ 抽查
  return 'spot_check';
}

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
    const gloss = buildGlossary(lang);   // 按目标语言构建术语表(多语言取对应列)+DNT
    try {
      // A、B 两个模型独立翻译（并行）
      [aRes, bRes] = await Promise.all([
        modelA_generate(sourceText, lang, gloss, refs),
        modelB_generate(sourceText, lang, gloss, refs)
      ]);
      // C 比对裁决，择优/融合 + 一致性评分
      cRes = await modelC_arbitrate(sourceText, aRes.translation, bRes.translation, lang, gloss, refs);
    } catch (err) {
      console.error(`[Pipeline] Row ${rowIndex + 1}/${lang} 失败: ${err.message}`);
      aRes = aRes || { translation: sourceText, confidence: 0, model: 'error' };
      bRes = bRes || { translation: sourceText, confidence: 0, model: 'error' };
      cRes = { final: aRes.translation, consistency: 1, chosen: 'A', divergence: err.message, model: 'error' };
    }

    // 程序检查（确定性，优先级高于模型评分）+ 三档分流
    const prog = programChecks(sourceText, cRes.final, gloss.map, gloss.dntList);
    const route = classifyRoute(cRes, prog, aRes.translation, bRes.translation, sourceText);   // auto | spot_check | human
    const needsReview = route !== 'auto';       // 抽查和人工都进复核队列（抽查=可选核，人工=必核）
    const progFail = !prog.pass;
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
      route,                              // 分流结果 auto/spot_check/human
      programChecks: prog.issues,         // 程序检查发现的硬性问题
      needsReview,
      reviewReason: needsReview ? (progFail ? '程序检查未过: ' + prog.issues.join('; ') : (cRes.divergence || (cRes.detail && cRes.detail.review_reason) || `一致性 ${cRes.consistency}/10`)) : '',
      reviewSeverity: (route === 'human' ? 'high' : route === 'spot_check' ? 'medium' : 'low'),
      modelA: aRes.model, modelB: bRes.model, modelC: cRes.model,
      cDetail: cRes.detail || null,        // C 终审详细字段(评分/decision/风险/error_types等)
      createdAt: new Date().toISOString()
    };
    DB.results.push(result);
    return result;
  }

  for (const lang of targetLangs) {
    console.log(`[Pipeline] Processing language: ${lang}`);
    const rowIdxs = [];
    for (let i = 0; i < totalRows; i++) rowIdxs.push(i);

    // 滑动窗口并发：始终保持 conc 个在途，一条完成立刻补下一条(消除分批的木桶效应)
    let nextIdx = 0, doneCount = 0, lastLog = 0;
    async function worker() {
      while (nextIdx < rowIdxs.length) {
        const ri = rowIdxs[nextIdx++];
        await processOne(ri, lang);
        doneCount++;
        // 每完成 conc 条落盘一次+打点(避免频繁写盘)
        if (doneCount - lastLog >= conc || doneCount === rowIdxs.length) {
          lastLog = doneCount;
          saveDB();
          console.log(`[Pipeline] ${lang} 进度 ${doneCount}/${totalRows}`);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(conc, rowIdxs.length) }, () => worker()));
    saveDB();
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




