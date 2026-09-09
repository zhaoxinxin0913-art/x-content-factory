const XLSX = require('xlsx-js-style');
// 四种导出：无需复审(仅auto) / 无需复审含抽查(auto+spot) / 人工复审 / 运营抽查
// 复审、抽查表为每语种 7 列：译文/A版/B版/原因/风险等级/问题类型/程序检查
const KINDS = { approved: '无需复审', approved_spot: '无需复审含运营抽查', human: '待人工复审', spot_check: '运营抽查' };
const REVIEW_KINDS = { human: true, spot_check: true };
const cellValue = v => v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : v;

function buildClassifiedWorkbook(task, results, reviews, kind, languageName = l => l) {
  if (!KINDS[kind]) throw new Error('无效导出类型');
  const langs = task.targetLangs || [];
  if (!langs.length) throw new Error('任务尚未选择目标语种');
  const byCell = new Map(), reviewed = new Map(reviews.map(r => [r.resultId, r]));
  for (const r of results) {
    const key = `${r.rowIndex}|${r.targetLang}`;
    if (byCell.has(key)) throw new Error('发现重复翻译结果，请先核对任务');
    byCell.set(key, r);
  }
  const headers = [...(task.headers || [])];
  const width = task.data.reduce((n, row) => Math.max(n, (row || []).length), headers.length);
  while (headers.length < width) headers.push(`col_${headers.length + 1}`);

  const isReview = !!REVIEW_KINDS[kind];
  // 表头
  let header;
  if (isReview) {
    header = [...headers];
    for (const l of langs) {
      const n = languageName(l);
      header.push(`${n}译文`, `${n}_A版`, `${n}_B版`, `${n}_原因`, `${n}_风险等级`, `${n}_问题类型`, `${n}_程序检查`);
    }
  } else {
    header = [...headers, ...langs.map(l => languageName(l))];
  }
  const rows = [header];
  const highlights = [], mapping = [['本表Excel行号', '原文件Excel行号']];
  const okRoutes = kind === 'approved_spot' ? ['auto', 'spot_check'] : ['auto'];

  task.data.forEach((raw, rowIndex) => {
    // 每语种取结果 + 应用人工复核覆盖
    const src = (raw || [])[task.columnIndex];
    const srcEmpty = src == null || String(src).trim() === '';
    const cell = lang => {
      const r = byCell.get(`${rowIndex}|${lang}`), review = r && reviewed.get(r.id);
      // 无结果：原文为空则该行本就无需翻译(none)，原文非空才算缺译需人工
      let route = r ? (r.route || (r.needsReview ? 'human' : 'auto')) : (srcEmpty ? 'none' : 'human');
      let translation = cellValue(review && review.decision === 'fix' ? review.finalText : (r ? r.translation : ''));
      if (review && ['accept', 'fix'].includes(review.decision)) route = 'auto';
      return { r, route, translation };
    };
    const cells = langs.map(cell);
    // 整行所有语种都无需翻译(空原文且无结果) → 跳过
    if (cells.every(c => c.route === 'none')) return;

    if (isReview) {
      // 行级纳入：任一语种命中该档
      if (!cells.some(c => c.route === kind)) return;
      const values = Array.from({ length: width }, (_, i) => cellValue((raw || [])[i]));
      cells.forEach((c, i) => {
        const base = width + i * 7;
        if (c.r && c.route === kind) {
          const det = c.r.cDetail || {};
          const rule = /rule-based-arbiter/.test(String(c.r.modelC || ''));
          const reasons = [c.r.reviewReason, det.review_reason, ...(c.r.programChecks || [])].filter(Boolean);
          const et = det.error_types;
          values.push(
            c.translation,
            cellValue(c.r.translationA),
            cellValue(c.r.translationB),
            [...new Set(reasons)].join('\n') || c.r.divergence || (kind === 'human' ? '需要人工复审' : '平台标记运营抽查'),
            rule ? '' : cellValue(det.risk_level || ''),
            rule ? '' : cellValue(Array.isArray(et) ? et.join('; ') : (et || '')),
            (c.r.programChecks || []).join('; ')
          );
          highlights.push({ r: rows.length, c: base });   // 高亮译文格
        } else {
          values.push(c.r ? c.translation : '', '', '', '', '', '', '');
        }
      });
      rows.push(values);
      mapping.push([rows.length, rowIndex + 2]);
    } else {
      // 无需复审 / 含抽查：任一语种命中允许档 → 纳入；每语种只填命中档的译文
      if (!cells.some(c => okRoutes.includes(c.route))) return;
      const values = Array.from({ length: width }, (_, i) => cellValue((raw || [])[i]));
      cells.forEach(c => values.push(okRoutes.includes(c.route) ? c.translation : ''));
      rows.push(values);
      mapping.push([rows.length, rowIndex + 2]);
    }
  });

  const wb = XLSX.utils.book_new(), ws = XLSX.utils.aoa_to_sheet(rows);
  for (const p of highlights) {
    const ref = XLSX.utils.encode_cell({ r: p.r, c: p.c });
    if (ws[ref]) ws[ref].s = { fill: { patternType: 'solid', fgColor: { rgb: 'FFF2CC' } } };
  }
  ws['!autofilter'] = { ref: ws['!ref'] };
  ws['!cols'] = rows[0].map(() => ({ wch: 22 }));
  XLSX.utils.book_append_sheet(wb, ws, '翻译结果');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(mapping), '原始行号映射');
  wb.Workbook = { Sheets: [{ name: '翻译结果', Hidden: 0 }, { name: '原始行号映射', Hidden: 1 }] };
  return wb;
}
module.exports = { buildClassifiedWorkbook, KINDS };
