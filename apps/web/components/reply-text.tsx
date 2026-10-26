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
// rooms is drawn as cards (`view: 'cards'`, a room-list turn) or as a
// GROUPED table (`view: 'column'`: the rate card, a dated availability
// table, the extra-guest terms). Any other table is a table.
//
// Grouped (D-094 amended 2026-10-21, the user: "redundant info is photos
// and room name"): the rate card has one row per room AND slot, so the
// room's name was repeated on every slot row, and so was its photo button.
// Now consecutive rows that name the same room are one <tbody>, the name
// drawn once in a cell that spans them (rowSpan), with the room's photo
// button under the name instead of in a column of its own. The TEXT is
// untouched: the reply still holds every row, and a copy of the table
// (or a screen reader) still reads the room on each. On a phone each
// group is one card, headed by the room, its slots stacked inside.

import type { RoomCard } from '@rag/pipeline';
import { parseInline, parseSegments } from '@/lib/tables';
import { cardFor, photoCount, RoomCards, tableIsRooms } from '@/components/room-cards';
import { Icon } from '@/components/icons';
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

/** A row's first cell as a grouping key: the model's `**` and case do not make two rooms. */
const keyOf = (row: string[]) => (row[0] ?? '').replace(/\*\*/g, '').trim().toLowerCase();

/**
 * Consecutive rows with the same first cell, as one group each. Only
 * NEIGHBOURS merge: a room named again further down is a new group, so the
 * order the reply wrote is the order drawn. Pure, tested.
 */
export function groupRows(rows: string[][]): string[][][] {
  const groups: string[][][] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && keyOf(last[0] ?? []) === keyOf(row)) last.push(row);
    else groups.push([row]);
  }
  return groups;
}

/**
 * One table. With `cards` (a table whose first column names rooms), the
 * rows are grouped by room: one <tbody> per group, the room's name in a
 * cell spanning its rows, and its photo button under the name on the
 * rooms that have photos. Without `cards`, one row is one row.
 */
function Table({ header, rows, cards }: { header: string[]; rows: string[][]; cards?: RoomCard[] }) {
  const lightbox = useLightbox();
  const amounts = amountColumns(rows);
  const rooms = cards !== undefined;
  const groups = rooms ? groupRows(rows) : [rows];
  // When a room has several rows, the SECOND column is what tells them
  // apart (the slot): on a phone it is drawn as a sub-heading inside the
  // room's card, with the row's other cells under it (`td.sub`, chat.css).
  // Decided per table, so every room reads the same way.
  const subKey = rooms && groups.some((group) => group.length > 1);
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
            </tr>
          </thead>
          {groups.map((group, g) => (
            <tbody key={g} className={rooms ? 'group' : undefined}>
              {group.map((row, j) => {
                const card = rooms && j === 0 ? cardFor(cards, row[0] ?? '') : undefined;
                return (
                  <tr key={j}>
                    {row.map((cell, k) => {
                      // The first cell is the row's key (the room, the slot,
                      // the date): the card's title on a phone. In a ROOMS
                      // table it is drawn on the group's first row alone and
                      // spans the rest. A plain table (villa's rate card, no
                      // cards) is ONE "group" of every row, so the span is
                      // gated on `rooms` like the skip above it: with the
                      // skip alone, every row's key cell spanned the whole
                      // table and each row slid one column right (the user,
                      // 2026-10-26: "price table is broken when the resort
                      // is villa").
                      if (k === 0 && rooms && j > 0) return null;
                      if (k === 0) {
                        return (
                          <td key={k} data-label={header[0] ?? ''} className="key" rowSpan={rooms && group.length > 1 ? group.length : undefined}>
                            {inline(cell)}
                            {card && card.photos.length > 0 ? (
                              // The name says what the badge says ("2 photos"): WCAG 2.5.3, what you see is what you say.
                              <button
                                type="button"
                                className="photo-link"
                                onClick={(event) => lightbox.show(card.name, card.photos, event.currentTarget)}
                                aria-label={`See ${photoCount(card.photos.length)} of ${card.name}`}
                              >
                                <Icon name="image" size={14} />
                                {photoCount(card.photos.length)}
                              </button>
                            ) : null}
                          </td>
                        );
                      }
                      return (
                        // data-label: the column's name, which the phone layout
                        // prints in front of the value (chat.css, 560px). An
                        // attribute, so React escapes it like a child.
                        <td key={k} data-label={header[k] ?? ''} className={[k === 1 && subKey ? 'sub' : '', amounts[k] ? 'amount' : ''].filter(Boolean).join(' ') || undefined}>
                          {inline(cell)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
      {rooms && <Lightbox open={lightbox.open} close={lightbox.close} step={lightbox.step} to={lightbox.to} />}
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
