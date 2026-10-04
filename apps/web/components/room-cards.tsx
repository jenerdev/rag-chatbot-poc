'use client';

// Room cards (D-094): a room-list reply drawn as one card per room, with
// the room's photo, instead of the table.
//
// The DATA is still the reply's pipe table (lib/tables.ts): the first column
// is the room, every other column a labelled line on the card, exactly as
// the phone layout already shows a table (globals.css, 560px). What this
// adds is the photo, joined by room NAME to `meta.roomCards`, which the
// pipeline sends on a room-list turn at a per_room tenant. A room the table
// names but the database does not (or has no photo for) gets a card with no
// photo. A card the table does not mention is not drawn: the model's words
// decide what is said, the database only decorates them.
//
// Clicking a photo opens the lightbox: the photo large on a dark overlay,
// with arrows when the room has more than one, closed by the ×, the overlay
// or Escape. Every string here is a React child or a `src`; nothing is
// markup.

import { useCallback, useEffect, useState } from 'react';
import type { RoomCard } from '@rag/pipeline';
import { parseInline } from '@/lib/tables';

function inline(text: string) {
  return parseInline(text).map((run, i) => (run.kind === 'bold' ? <strong key={i}>{run.text}</strong> : run.text));
}

/** The card whose name matches the row's first cell, ignoring case and the model's `**`. */
function cardFor(cards: RoomCard[], title: string): RoomCard | undefined {
  const wanted = title.replace(/\*\*/g, '').trim().toLowerCase();
  return cards.find((c) => c.name.trim().toLowerCase() === wanted);
}

/** Does this table's first column name at least one of the cards' rooms? */
export function tableIsRooms(rows: string[][], cards: RoomCard[]): boolean {
  return rows.some((row) => cardFor(cards, row[0] ?? '') !== undefined);
}

export function RoomCards({ header, rows, cards }: { header: string[]; rows: string[][]; cards: RoomCard[] }) {
  const [open, setOpen] = useState<{ photos: string[]; index: number; room: string } | null>(null);

  const close = useCallback(() => setOpen(null), []);
  const step = useCallback(
    (by: number) => setOpen((o) => (o ? { ...o, index: (o.index + by + o.photos.length) % o.photos.length } : o)),
    [],
  );

  // Escape closes, the arrow keys step: the keyboard is how many people
  // use a lightbox. Bound only while one is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
      else if (event.key === 'ArrowLeft') step(-1);
      else if (event.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close, step]);

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
                <button
                  type="button"
                  className="room-card-photo"
                  onClick={() => setOpen({ photos: card.photos, index: 0, room: card.name })}
                  aria-label={`See ${card.name} larger`}
                >
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

      {open && (
        <div className="lightbox" role="dialog" aria-label={`${open.room} photo ${open.index + 1} of ${open.photos.length}`} onClick={close}>
          {/* Clicks inside the frame must not close it: the arrows live there. */}
          <div className="lightbox-frame" onClick={(event) => event.stopPropagation()}>
            <img src={open.photos[open.index]} alt={`${open.room}, photo ${open.index + 1}`} />
            {open.photos.length > 1 && (
              <>
                <button type="button" className="lightbox-nav prev" onClick={() => step(-1)} aria-label="Previous photo">
                  ‹
                </button>
                <button type="button" className="lightbox-nav next" onClick={() => step(1)} aria-label="Next photo">
                  ›
                </button>
                <div className="lightbox-count">
                  {open.index + 1} / {open.photos.length}
                </div>
              </>
            )}
            <button type="button" className="lightbox-close" onClick={close} aria-label="Close">
              ×
            </button>
          </div>
        </div>
      )}
    </>
  );
}
