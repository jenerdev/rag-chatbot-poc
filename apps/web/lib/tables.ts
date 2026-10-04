// tables.ts — the ONE block syntax the chat draws: a pipe table.
//
// plan/tables.md Rule 1. The reply is text, and stays text, except for a
// block of lines shaped like
//
//   | Room | Guests | Price |
//   |---|---|---|
//   | Garden Room | up to 2 | ₱3,500.00 (weekend rate) |
//
// which becomes a <table>. Nothing else is parsed: no bold, no links, no
// headings, no lists. This is not a markdown renderer and must not grow into
// one, because the reply comes from the model and the documents, and the
// moment a string becomes markup, a document can inject it. Here a string
// only ever becomes CELL TEXT, handed to React as a child, so it is escaped
// exactly as the whole reply was before (chat-screen.tsx rule 1).
//
// Browser-safe and pure, like money.ts: no import, no I/O, no exception. An
// input this file does not understand is returned as text, so the worst a
// malformed table from the model can do is look the way it does today.
//
// Strict about the separator, tolerant about the rest (plan § 2.1): a block
// needs a header line AND a separator line (every cell `-`s, with an optional
// `:` at either end) directly under it; without the separator, a line that
// happens to start and end with `|` is prose. Below the separator, every
// consecutive row-shaped line is a row, padded or cut to the header's width.

export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'table'; header: string[]; rows: string[][] };

/** Does this line look like a table row: `| a | b |`, whitespace allowed around it? */
function isRowLine(line: string): boolean {
  const t = line.trim();
  return t.length >= 2 && t.startsWith('|') && t.endsWith('|');
}

/** The cells of a row line, trimmed. `|a|b|` → ['a', 'b']. */
function cells(line: string): string[] {
  const t = line.trim();
  return t
    .slice(1, -1)
    .split('|')
    .map((c) => c.trim());
}

/** `|---|:--:|` — the line that turns the one above it into a header. */
function isSeparator(line: string): boolean {
  if (!isRowLine(line)) return false;
  const c = cells(line);
  return c.length > 0 && c.every((cell) => /^:?-+:?$/.test(cell));
}

/** Pad a short row with empty cells, or cut a long one, to the header's width. */
function fit(row: string[], width: number): string[] {
  if (row.length === width) return row;
  if (row.length > width) return row.slice(0, width);
  return [...row, ...Array<string>(width - row.length).fill('')];
}

/**
 * Split a reply into text and table segments, in order.
 *
 * Text is returned exactly as written, newlines included, so a reply with no
 * table is ONE text segment equal to the input: the screen shows it as it
 * did before this file existed. The one liberty taken is at a table's edge:
 * the single blank line before and after a table is dropped, because the
 * table brings its own spacing and the blank line would show twice.
 *
 * Streaming (plan § 2.2): this runs on the whole text after every delta. A
 * header whose separator has not arrived is text; a last row still being
 * written has no closing `|` yet, so it is text under the table until it
 * closes. Both are the plain-text look of a moment ago, never a broken one.
 */
export function parseSegments(reply: string): Segment[] {
  if (reply === '') return [];
  const lines = reply.split('\n');
  const segments: Segment[] = [];
  let text: string[] = [];

  const flushText = (beforeTable: boolean): void => {
    if (beforeTable && text.length > 0 && text[text.length - 1] === '') text.pop();
    if (text.length > 0) segments.push({ kind: 'text', text: text.join('\n') });
    text = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (isRowLine(line) && next !== undefined && isSeparator(next)) {
      flushText(true);
      const header = cells(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && isRowLine(lines[j]!)) {
        rows.push(fit(cells(lines[j]!), header.length));
        j += 1;
      }
      segments.push({ kind: 'table', header, rows });
      i = j;
      // The one blank line after a table is the table's own spacing.
      if (lines[i] === '' && i < lines.length - 1) i += 1;
      continue;
    }
    text.push(line);
    i += 1;
  }
  flushText(false);
  return segments;
}
