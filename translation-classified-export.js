const XLSX = require('xlsx-js-style');
const KINDS = { approved: '无需人工复审', human: '待人工复审', spot_check: '运营抽查', all: '全部条目_高亮及原因' };
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
  const suffix = kind === 'all' ? '复核原因' : kind === 'human' ? '复审原因' : '抽查原因';
  const rows = [[...headers, ...langs.flatMap(l => kind === 'approved' ? [languageName(l)] : [languageName(l), languageName(l) + suffix])]];
  const highlights = [], mapping = [['本表Excel行号', '原文件Excel行号']];
  task.data.forEach((raw, rowIndex) => {
    const source = (raw || [])[task.columnIndex];
    const cells = langs.map(lang => {
      const r = byCell.get(`${rowIndex}|${lang}`), review = r && reviewed.get(r.id);
      const translation = cellValue(review?.decision === 'fix' ? review.finalText : r?.translation);
      if (review && ['accept', 'fix'].includes(review.decision)) return { translation, route: 'auto', reason: '' };
      if (!r) return { translation, route: 'human', reason: source == null || source === '' ? '缺少翻译结果；原文列为空，请确认原文' : '缺少翻译结果，需要补译' };
      // 按已保存的分流导出，不在导出时重新裁决模型结果。
      const route = r.route || (r.needsReview ? 'human' : 'auto');
      const reasons = [r.reviewReason, r.cDetail?.review_reason, ...(r.programChecks || [])].filter(Boolean);
      return { translation, route, reason: [...new Set(reasons)].join('\n') || r.divergence || (route === 'human' ? '需要人工复审' : '平台标记运营抽查') };
    });
    const hasHuman = cells.some(c => c.route === 'human');
    if (kind !== 'all' && !(kind === 'approved' ? !hasHuman : cells.some(c => c.route === kind))) return;
    const values = Array.from({ length: width }, (_, i) => cellValue((raw || [])[i]));
    cells.forEach((c, i) => {
      values.push(c.translation);
      if (kind !== 'approved') {
        const flagged = kind === 'all' ? ['human', 'spot_check'].includes(c.route) : c.route === kind;
        const label = kind === 'all' ? (c.route === 'human' ? '【人工复审】' : '【运营抽查】') : '';
        values.push(flagged ? label + c.reason : '');
        if (flagged) highlights.push({ r: rows.length, c: width + i * 2 });
      }
    });
    rows.push(values);
    mapping.push([rows.length, rowIndex + 2]);
  });
  const wb = XLSX.utils.book_new(), ws = XLSX.utils.aoa_to_sheet(rows);
  for (const p of highlights) ws[XLSX.utils.encode_cell(p)].s = { fill: { patternType: 'solid', fgColor: { rgb: 'FFF2CC' } } };
  ws['!autofilter'] = { ref: ws['!ref'] };
  ws['!cols'] = rows[0].map(() => ({ wch: 28 }));
  XLSX.utils.book_append_sheet(wb, ws, '翻译结果');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(mapping), '原始行号映射');
  wb.Workbook = { Sheets: [{ name: '翻译结果', Hidden: 0 }, { name: '原始行号映射', Hidden: 1 }] };
  return wb;
}
module.exports = { buildClassifiedWorkbook, KINDS };
