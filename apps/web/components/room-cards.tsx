'use client';

// Room cards (D-094): a room-list reply drawn as one card per room, with
// the room's photo, instead of the table.
//
// The DATA is still the reply's pipe table (lib/tables.ts): the first column
// is the room, every other column a labelled line on the card, exactly as
// the phone layout already shows a table (globals.css, 560px). What this
// adds is the photo, joined by room NAME to `meta.roomCards`, which the
// pipeline sends at a per_room tenant. A room the table names but the
// database does not (or has no photo for) gets a card with no photo. A
// card the table does not mention is not drawn: the model's words decide
// what is said, the database only decorates them.
//
// Clicking a photo opens the lightbox (lightbox.tsx). Every string here is
// a React child or a `src`; nothing is markup.

import type { RoomCard } from '@rag/pipeline';
import { parseInline } from '@/lib/tables';
import { Lightbox, useLightbox } from '@/components/lightbox';

function inline(text: string) {
  return parseInline(text).map((run, i) => (run.kind === 'bold' ? <strong key={i}>{run.text}</strong> : run.text));
}

/** The card whose name matches the row's first cell, ignoring case and the model's `**`. */
export function cardFor(cards: RoomCard[], title: string): RoomCard | undefined {
  const wanted = title.replace(/\*\*/g, '').trim().toLowerCase();
  return cards.find((c) => c.name.trim().toLowerCase() === wanted);
}

/** Does this table's first column name at least one of the cards' rooms? */
export function tableIsRooms(rows: string[][], cards: RoomCard[]): boolean {
  return rows.some((row) => cardFor(cards, row[0] ?? '') !== undefined);
}

export function RoomCards({ header, rows, cards }: { header: string[]; rows: string[][]; cards: RoomCard[] }) {
  const lightbox = useLightbox();

  return (
    <>
      <div className="room-cards">
        {rows.map((row, i) => {
          const title = row[0] ?? '';
          const card = cardFor(cards, title);
          const photo = card?.photos[0];
          return (
            <div className="room-card" key={i}>
              {photo && card ? (
                <button type="button" className="room-card-photo" onClick={() => lightbox.show(card.name, card.photos)} aria-label={`See ${card.name} larger`}>
                  {/* A plain <img>, not next/image: the URL is the tenant's bucket, not a configured host. */}
                  <img src={photo} alt={card.name} loading="lazy" />
                  {card.photos.length > 1 && <span className="room-card-count">{card.photos.length} photos</span>}
                </button>
              ) : null}
              <div className="room-card-title">{inline(title)}</div>
              {row.slice(1).map((cell, k) =>
                cell === '' ? null : (
                  <div className="room-card-line" key={k}>
                    <span className="room-card-label">{header[k + 1] ?? ''}</span>
                    <span className="room-card-value">{inline(cell)}</span>
                  </div>
                ),
              )}
            </div>
          );
        })}
      </div>
      <Lightbox open={lightbox.open} close={lightbox.close} step={lightbox.step} />
    </>
  );
}
