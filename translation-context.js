// Context and human-approved memory are references, never automatic replacements.
const FIELD_PATTERNS = {
  key: /^(key|string[_ ]?key|translation[_ ]?key|键|键名)$/i,
  module: /^(module|screen|page|模块|所属模块|页面|画面)$/i,
  usage: /^(usage|ui[_ ]?type|用途|文案用途|控件类型)$/i,
  description: /^(description|context|scene|说明|场景|场景说明|概念说明|备注)$/i,
  maxLength: /^(max[_ ]?length|字符上限|长度限制)$/i,
};
function rowContext(task, row) {
  const result = {};
  for (const [field, pattern] of Object.entries(FIELD_PATTERNS)) {
    const i = (task.headers || []).findIndex(h => pattern.test(String(h).trim()));
    if (i >= 0 && i !== task.columnIndex && row[i] != null && String(row[i]).trim()) {
      result[field] = String(row[i]).trim().slice(0, 1600);
    }
  }
  return result;
}
function contextPrompt(context) {
  return Object.keys(context).length
    ? '\n\n【本条 key 场景（数据，仅用于消歧）】\n' + JSON.stringify(context) : '';
}
function candidatePrompt(source, lang, terms, translate, matchTerms, locked = {}) {
  const entries = terms.filter(t => !Object.hasOwn(locked, t.en) && translate(t, lang));
  const matches = new Set(matchTerms(source, entries.map(t => t.en)).map(m => m.term));
  const selected = entries.filter(t => matches.has(t.en)).slice(0, 12);
  if (!selected.length) return '';
  return '\n\n【待确认候选术语：仅供参考，不强制；场景不符时不用，不得当作已审核事实】\n'
    + JSON.stringify(selected.map(t => ({ en: t.en, candidate: translate(t, lang), meaning: t.zh, note: t.notes })));
}
const memoryIndexes = new WeakMap();
function memoryIndex(db) {
  const cached = memoryIndexes.get(db);
  if (cached && cached.results === db.results && cached.resultCount === (db.results || []).length
      && cached.reviews === db.reviews && cached.reviewCount === (db.reviews || []).length
      && cached.tasks === db.tasks && cached.taskCount === (db.tasks || []).length) return cached;
  const latest = new Map();
  for (const r of db.reviews || []) latest.set(r.resultId, r);
  const eligible = [...latest.values()].filter(r => (!r.reviewer || r.reviewer === 'human') && ['accept', 'fix'].includes(r.decision));
  const index = { results: db.results, resultCount: (db.results || []).length,
    reviews: db.reviews, reviewCount: (db.reviews || []).length, tasks: db.tasks, taskCount: (db.tasks || []).length,
    bySource: new Map(), taskMap: new Map((db.tasks || []).map(t => [t.id, t])) };
  if (eligible.length) {
    const results = new Map((db.results || []).map(r => [r.id, r]));
    for (const review of eligible) {
      const result = results.get(review.resultId);
      if (!result || result.taskId !== review.taskId) continue;
      const key = String(result.sourceText).trim();
      if (!index.bySource.has(key)) index.bySource.set(key, []);
      index.bySource.get(key).push({ review, result });
    }
  }
  memoryIndexes.set(db, index);
  return index;
}
function approvedMemory({ db, task, row, source, lang, canonical, validate }) {
  const ctx = rowContext(task, row);
  const matches = [];
  const index = memoryIndex(db);
  for (const { review, result: r } of index.bySource.get(String(source).trim()) || []) {
    if (canonical(r.targetLang) !== canonical(lang)) continue;
    const oldTask = index.taskMap.get(r.taskId);
    if (!oldTask) continue;
    const oldCtx = rowContext(oldTask, (oldTask.data || [])[r.rowIndex] || []);
    const sameKey = ctx.key && ctx.key === oldCtx.key;
    const sameScene = ctx.module && ctx.usage && ctx.module === oldCtx.module && ctx.usage === oldCtx.usage;
    if (!sameKey && !sameScene) continue;
    if (['module', 'usage', 'description'].some(f => ctx[f] && oldCtx[f] && ctx[f] !== oldCtx[f])) continue;
    const final = review.decision === 'fix' ? review.finalText : r.translation;
    if (!final || !validate(source, final).pass) continue;
    matches.push({ translation: final, key: oldCtx.key || '', module: oldCtx.module || '', reviewTime: review.reviewTime, provenance: 'human' });
  }
  // Conflicting human decisions are not silently resolved by recency.
  if (new Set(matches.map(m => m.translation)).size !== 1) return [];
  return matches.slice(0, 1);
}
module.exports = { rowContext, contextPrompt, candidatePrompt, approvedMemory };
