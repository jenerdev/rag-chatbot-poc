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

/** A cell that is an amount, so it lines up on the right: "₱3,500.00 (weekend rate)". */
function isAmount(cell: string): boolean {
  return /^[₱$€£¥]/.test(cell);
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
                    <th key={j}>{cell}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {segment.rows.map((row, j) => (
                  <tr key={j}>
                    {row.map((cell, k) => (
                      <td key={k} className={isAmount(cell) ? 'amount' : undefined}>
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
