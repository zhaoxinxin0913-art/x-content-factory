const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = 5051;

// 模型配置（运行时可通过 /api/settings 修改，无需重启）
const SETTINGS_FILE = path.join(__dirname, 'translation-settings.json');
let SETTINGS = {
  useCcSwitch: process.env.USE_CC_SWITCH === 'true',
  ccSwitchUrl: process.env.CC_SWITCH_URL || 'http://127.0.0.1:15721/v1',
  apiKey: process.env.CC_SWITCH_KEY || 'dummy',
  modelA: process.env.MODEL_A || 'kimi-k2.6',      // 生成器（翻译）
  modelB: process.env.MODEL_B || 'deepseek-chat',  // 校验器（质检）
  modelC: process.env.MODEL_C || 'kimi-k2.6'       // 提取器（问题汇总）
};
try {
  if (require('fs').existsSync(SETTINGS_FILE)) {
    SETTINGS = { ...SETTINGS, ...JSON.parse(require('fs').readFileSync(SETTINGS_FILE, 'utf8')) };
  }
} catch (e) { console.error('settings load failed:', e.message); }
function saveSettings() {
  try { require('fs').writeFileSync(SETTINGS_FILE, JSON.stringify(SETTINGS, null, 2)); } catch (e) {}
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
  
  if (SETTINGS.useCcSwitch) {
    try {
      const OpenAI = require('openai');
      const openai = new OpenAI({
        baseURL: SETTINGS.ccSwitchUrl,
        apiKey: SETTINGS.apiKey
      });

      const glossaryText = Object.keys(glossary).length > 0
        ? `\n\n术语表（请严格遵守）：\n${Object.entries(glossary).map(([k, v]) => `${k} → ${v}`).join('\n')}`
        : '';

      const prompt = `你是一个专业的数据库字段翻译专家。
任务：将以下数据库字段翻译成${langName(targetLang)}。

要求：
1. 保持专业术语准确性
2. 符合数据库字段命名习惯
3. 简洁清晰，避免冗余
${glossaryText}

源字段：${sourceText}

请直接返回翻译结果，不要附加解释。同时评估你的翻译置信度（0-100）。

返回 JSON 格式：
{
  "translation": "翻译结果",
  "confidence": 85
}`;

      const response = await openai.chat.completions.create({
        model: SETTINGS.modelA,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        response_format: { type: 'json_object' }
      });

      const result = JSON.parse(response.choices[0].message.content);
      return {
        translation: result.translation || sourceText,
        confidence: result.confidence || 50,
        model: SETTINGS.modelA
      };
    } catch (error) {
      console.error('[Model A] CC Switch error, fallback to Google Translate:', error.message);
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
  
  if (SETTINGS.useCcSwitch) {
    try {
      const OpenAI = require('openai');
      const openai = new OpenAI({
        baseURL: SETTINGS.ccSwitchUrl,
        apiKey: SETTINGS.apiKey
      });

      const prompt = `你是一个严格的翻译质量校验专家。

任务：评估以下数据库字段翻译的质量。

源字段（原文）：${sourceText}
翻译结果：${translatedText}
目标语言：${langName(targetLang)}

评估维度：
1. 准确性：是否忠实传达原意？
2. 术语：专业术语使用是否正确？
3. 通顺度：译文是否自然流畅？
4. 一致性：风格是否统一？

请给出：
- 总分（1-10）
- 问题类型（如有）：术语错误/漏译/歧义/不通顺/过长/不当
- 具体问题描述
- 修改建议

返回 JSON 格式：
{
  "score": 8,
  "issues": ["术语错误"],
  "description": "具体问题描述",
  "suggestion": "建议的修改方案"
}`;

      const response = await openai.chat.completions.create({
        model: SETTINGS.modelB,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        response_format: { type: 'json_object' }
      });

      const result = JSON.parse(response.choices[0].message.content);
      return {
        score: result.score || 5,
        issues: result.issues || [],
        description: result.description || '',
        suggestion: result.suggestion || '',
        model: SETTINGS.modelB
      };
    } catch (error) {
      console.error('[Model B] CC Switch error, fallback to simple validation:', error.message);
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
  
  // 简单提取逻辑：评分 ≤ 6 或有问题标签的项
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

  return {
    needsReview,
    stats: {
      total: validationReports.length,
      issues: needsReview.length,
      needReview: needsReview.length
    },
    model: SETTINGS.useCcSwitch ? SETTINGS.modelC : 'rule-based-extractor-fallback'
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
  res.json({
    success: true,
    mode: SETTINGS.useCcSwitch ? 'cc-switch' : 'fallback',
    ccSwitchUrl: SETTINGS.ccSwitchUrl,
    models: { A: SETTINGS.modelA, B: SETTINGS.modelB, C: SETTINGS.modelC },
    message: SETTINGS.useCcSwitch
      ? `AI 模型模式：A=${SETTINGS.modelA} · B=${SETTINGS.modelB} · C=${SETTINGS.modelC}`
      : '兜底模式：MyMemory/Google 翻译 + 规则校验'
  });
});

// 读取/保存模型设置（运行时切换模型，无需重启）
app.get('/api/settings', (req, res) => {
  res.json({ success: true, settings: { ...SETTINGS, apiKey: SETTINGS.apiKey ? '••••••' : '' } });
});
app.post('/api/settings', (req, res) => {
  const { useCcSwitch, ccSwitchUrl, apiKey, modelA, modelB, modelC } = req.body || {};
  if (typeof useCcSwitch === 'boolean') SETTINGS.useCcSwitch = useCcSwitch;
  if (ccSwitchUrl) SETTINGS.ccSwitchUrl = ccSwitchUrl;
  if (apiKey && apiKey !== '••••••') SETTINGS.apiKey = apiKey;
  if (modelA) SETTINGS.modelA = modelA;
  if (modelB) SETTINGS.modelB = modelB;
  if (modelC) SETTINGS.modelC = modelC;
  saveSettings();
  res.json({ success: true, settings: { ...SETTINGS, apiKey: SETTINGS.apiKey ? '••••••' : '' } });
});

// 测试 CC-Switch 连通性 + 可用模型
app.get('/api/settings/test', async (req, res) => {
  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ baseURL: SETTINGS.ccSwitchUrl, apiKey: SETTINGS.apiKey });
    const r = await openai.models.list();
    const ids = (r.data || []).map(m => m.id);
    res.json({ success: true, reachable: true, models: ids });
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

  console.log(`[Pipeline] Starting task ${taskId} (${SETTINGS.useCcSwitch ? 'CC Switch' : 'Fallback'} mode)`);

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
        await new Promise(resolve => setTimeout(resolve, SETTINGS.useCcSwitch ? 500 : 350));
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
  console.log(`🤖 运行模式: ${SETTINGS.useCcSwitch ? 'CC Switch (' + SETTINGS.modelA + '/' + SETTINGS.modelB + ')' : 'Fallback (MyMemory/Google + 规则校验)'}`);
  if (SETTINGS.useCcSwitch) {
    console.log(`🔗 模型代理: ${SETTINGS.ccSwitchUrl}`);
  }
  console.log(`📁 上传目录: ${UPLOAD_DIR}`);
  console.log(`📤 导出目录: ${OUTPUT_DIR}`);
  console.log(`💾 数据库: ${DB_FILE}`);
  console.log('================================');
  console.log('');
  if (!SETTINGS.useCcSwitch) {
    console.log('💡 提示：当前兜底模式。在网站右上角「模型设置」可切换到 AI 多模型模式。');
    console.log('');
  }
});
