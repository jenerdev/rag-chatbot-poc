'use client';

// The assistant's reply, drawn as text with each pipe table as a <table>.
//
// plan/tables.md Rule 1: lib/tables.ts knows ONE block shape and hands back
// strings; this file hands every one of them to React as a CHILD, never as
// markup. So the escaping the chat has always relied on ("textContent, NEVER
// innerHTML", chat-screen.tsx rule 1) still costs nothing: a `<script>` in a
// cell is the six characters `<script>`, on screen, in a cell.
//
// The text segments keep the bubble's `white-space: pre-wrap`, so a reply
// with no table in it renders exactly as it did before this component
// existed (lib/tables.test.ts: one segment, byte for byte).

import { parseSegments } from '@/lib/tables';

/** A cell that is an amount: "₱3,500.00". */
function isAmount(cell: string): boolean {
  return /^[₱$€£¥]/.test(cell);
}

/**
 * Which columns are amounts: every filled cell in the column is one, and at
 * least one is filled. Decided per COLUMN, not per cell, so a taken slot's
 * empty price cell lines up with the prices, and the header above them is
 * centred (the user's choice, Phase 4 walk) rather than left-aligned over
 * right-aligned figures.
 */
function amountColumns(rows: string[][]): boolean[] {
  const width = rows[0]?.length ?? 0;
  return Array.from({ length: width }, (_, k) => {
    const filled = rows.map((r) => r[k] ?? '').filter((c) => c !== '');
    return filled.length > 0 && filled.every(isAmount);
  });
}

export function ReplyText({ text }: { text: string }) {
  return (
    <>
      {parseSegments(text).map((segment, i) =>
        segment.kind === 'text' ? (
          <span className="reply-text" key={i}>
            {segment.text}
          </span>
        ) : (
          <div className="reply-table" key={i}>
            <table>
              <thead>
                <tr>
                  {segment.header.map((cell, j) => (
                    <th key={j} className={amountColumns(segment.rows)[j] ? 'amount' : undefined}>
                      {cell}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {segment.rows.map((row, j) => (
                  <tr key={j}>
                    {row.map((cell, k) => (
                      // data-label: the column's name, which the phone layout
                      // prints in front of the value (globals.css, 560px). An
                      // attribute, so React escapes it like a child.
                      <td key={k} data-label={segment.header[k] ?? ''} className={amountColumns(segment.rows)[k] ? 'amount' : undefined}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ),
      )}
    </>
  );
}
