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
//
// D-094: with the rooms' photos (`cards`), a table whose first column names
// rooms is drawn as cards (`view: 'cards'`, a room-list turn) or as the
// table plus a Photo column whose View button opens the lightbox
// (`view: 'column'`: the rate card, a dated availability table, the
// extra-guest terms). Any other table is a table.

import type { RoomCard } from '@rag/pipeline';
import { parseInline, parseSegments } from '@/lib/tables';
import { cardFor, RoomCards, tableIsRooms } from '@/components/room-cards';
import { Lightbox, useLightbox } from '@/components/lightbox';

/** A cell that is an amount: "₱3,500.00". A leading emoji the model added does not change that. */
function isAmount(cell: string): boolean {
  return /^(?:[\p{Extended_Pictographic}️‍]+\s*)?[₱$€£¥]/u.test(cell);
}

/**
 * A line's runs as children: a string for text, <strong> with a string
 * child for bold. Still no markup from a string anywhere (D-091 Rule 1).
 */
function inline(text: string) {
  return parseInline(text).map((run, i) => (run.kind === 'bold' ? <strong key={i}>{run.text}</strong> : run.text));
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

/**
 * One table. With `cards`, a Photo column is appended: a View button on
 * the rows whose room has photos, an empty cell on the rest.
 */
function Table({ header, rows, cards }: { header: string[]; rows: string[][]; cards?: RoomCard[] }) {
  const lightbox = useLightbox();
  const amounts = amountColumns(rows);
  const photoColumn = cards !== undefined;
  return (
    <>
      <div className="reply-table">
        <table>
          <thead>
            <tr>
              {header.map((cell, j) => (
                <th key={j} className={amounts[j] ? 'amount' : undefined}>
                  {cell}
                </th>
              ))}
              {photoColumn && <th className="photo">Photo</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, j) => {
              const card = photoColumn ? cardFor(cards, row[0] ?? '') : undefined;
              return (
                <tr key={j}>
                  {row.map((cell, k) => (
                    // data-label: the column's name, which the phone layout
                    // prints in front of the value (globals.css, 560px). An
                    // attribute, so React escapes it like a child.
                    <td key={k} data-label={header[k] ?? ''} className={amounts[k] ? 'amount' : undefined}>
                      {inline(cell)}
                    </td>
                  ))}
                  {photoColumn && (
                    <td data-label="Photo" className="photo">
                      {card && card.photos.length > 0 ? (
                        <button type="button" className="photo-link" onClick={() => lightbox.show(card.name, card.photos)}>
                          View{card.photos.length > 1 ? ` (${card.photos.length})` : ''}
                        </button>
                      ) : null}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {photoColumn && <Lightbox open={lightbox.open} close={lightbox.close} step={lightbox.step} to={lightbox.to} />}
    </>
  );
}

export function ReplyText({ text, cards, view = 'column' }: { text: string; cards?: RoomCard[]; view?: 'cards' | 'column' }) {
  const rooms = cards !== undefined && cards.length > 0 ? cards : undefined;
  return (
    <>
      {parseSegments(text).map((segment, i) => {
        if (segment.kind === 'text') {
          return (
            <span className="reply-text" key={i}>
              {inline(segment.text)}
            </span>
          );
        }
        const isRooms = rooms !== undefined && tableIsRooms(segment.rows, rooms);
        if (isRooms && view === 'cards') return <RoomCards key={i} header={segment.header} rows={segment.rows} cards={rooms!} />;
        return <Table key={i} header={segment.header} rows={segment.rows} cards={isRooms ? rooms : undefined} />;
      })}
    </>
  );
}
