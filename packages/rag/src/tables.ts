// tables.ts — the ONE way code writes a table into a reply.
//
// plan/tables.md § 4. A reply is text, and a table in it is a GitHub pipe
// table: a header line, a separator line, one line per row. The browser's
// parser (apps/web/lib/tables.ts) draws exactly this shape and nothing
// else, so every table written in code goes through here, and the two
// files agree by construction: a header over `|---|`, cells separated by
// `|`, one blank line either side left to the caller.
//
// A cell never holds a `|` or a newline, whatever the data says: a room
// name is tenant-typed text (units.name), and one pipe in it would split
// the row on screen. Both are replaced with a space, which is the only
// change this file ever makes to a value.

/** `| a | b |` for the header, `|---|---|` under it, then one line per row. */
export function pipeTable(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.map(cell).join(' | ')} |`;
  return [line(header), `|${header.map(() => '---').join('|')}|`, ...rows.map(line)].join('\n');
}

function cell(text: string): string {
  return text.replace(/\s*[|\r\n]+\s*/g, ' ').trim();
}
