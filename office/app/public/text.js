// text.js — an employee's reply as blocks, never HTML (plan/office-app.md
// § 3.6). Pure: the panel turns these blocks into elements with
// textContent, so nothing the model writes is ever parsed as markup (the
// product's rule, apps/web/lib/tables.ts, for the same reason).
//
// Blocks:  { type: 'p', spans }         a paragraph
//          { type: 'h', spans }         a "# heading" line
//          { type: 'ul' | 'ol', items: spans[] }
//          { type: 'code', text }       a ``` fence
//          { type: 'table', head: spans[], rows: spans[][] }
// Spans:   { text, bold?, code? }       **bold** and `code`, nothing else

export function spans(line) {
  const out = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
  let at = 0; let m;
  while ((m = re.exec(line))) {
    if (m.index > at) out.push({ text: line.slice(at, m.index) });
    out.push(m[2] !== undefined ? { text: m[2], bold: true } : { text: m[3], code: true });
    at = m.index + m[0].length;
  }
  if (at < line.length) out.push({ text: line.slice(at) });
  return out;
}

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => spans(c.trim()));
const isRule = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export function blocks(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flush = () => { if (para.length) { out.push({ type: 'p', spans: spans(para.join(' ')) }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const body = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      out.push({ type: 'code', text: body.join('\n') });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && isRule(lines[i + 1])) {
      flush();
      const head = cells(line); const rows = [];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(cells(lines[i]));
      i--;
      out.push({ type: 'table', head, rows });
      continue;
    }
    const h = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (h) { flush(); out.push({ type: 'h', spans: spans(h[1]) }); continue; }
    const li = /^\s*([-*]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const type = /\d/.test(li[1]) ? 'ol' : 'ul';
      const last = out[out.length - 1];
      if (last && last.type === type && lines[i - 1] !== undefined && /^\s*([-*]|\d+[.)])\s+/.test(lines[i - 1])) last.items.push(spans(li[2]));
      else out.push({ type, items: [spans(li[2])] });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    para.push(line.trim());
  }
  flush();
  return out;
}
