'use client';

// Room cards (D-094, redrawn by plan/room-cards.md): a room-list reply drawn
// as one card per room, with the room's photo, instead of the table.
//
// The DATA is still the reply's pipe table (lib/tables.ts): the first column
// is the room, every other column a fact about it. What this adds is the
// photo, joined by room NAME to `meta.roomCards`, which the pipeline sends at
// a per_room tenant. A room the table names but the database does not (or
// has no photo for) gets a card with no photo. A card the table does not
// mention is not drawn: the model's words decide what is said, the database
// only decorates them.
//
// How a card reads (plan/room-cards.md): a SHORT cell ("up to 3",
// "₱3,500.00") is a fact chip under the name, its column's header as its
// label; a LONG cell (a sentence) is the card's text, labelled only when
// there is more than one, so "Details" is not said over every description.
// On a phone the cards are one row that swipes sideways (CSS), so the next
// room shows at the edge instead of below a screen of this one.
//
// Clicking a photo opens the viewer (lightbox.tsx). Every string here is a
// React child or a `src`; nothing is markup.

import type { RoomCard } from '@rag/pipeline';
import { parseInline } from '@/lib/tables';
import { Icon } from '@/components/icons';
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

/** Longer than this (as text, without `**`), or a sentence, a cell is the card's text, not a chip. */
export const FACT_MAX = 32;

/** A row's cells, split into chips and text. Pure, tested. */
export function cardParts(header: string[], row: string[]): { facts: { label: string; value: string }[]; texts: { label: string; value: string }[] } {
  const facts: { label: string; value: string }[] = [];
  const texts: { label: string; value: string }[] = [];
  row.slice(1).forEach((cell, k) => {
    if (cell.trim() === '') return;
    const part = { label: header[k + 1] ?? '', value: cell };
    const plain = cell.replace(/\*\*/g, '').trim();
    // A sentence is text whatever its length ("Opens onto the garden."); a short phrase is a fact.
    const sentence = /\s/.test(plain) && /[.!?]$/.test(plain);
    (plain.length <= FACT_MAX && !sentence ? facts : texts).push(part);
  });
  return { facts, texts };
}

/** "1 photo", "3 photos": the badge and the button's name say the same. */
const photoCount = (n: number) => (n === 1 ? '1 photo' : `${n} photos`);

export function RoomCards({ header, rows, cards }: { header: string[]; rows: string[][]; cards: RoomCard[] }) {
  const lightbox = useLightbox();

  return (
    <>
      {/* A region you can scroll with the keyboard: on a phone it scrolls sideways. */}
      <div className="room-cards" role="region" aria-label="Rooms" tabIndex={0}>
        {rows.map((row, i) => {
          const title = row[0] ?? '';
          const card = cardFor(cards, title);
          const photo = card?.photos[0];
          const { facts, texts } = cardParts(header, row);
          return (
            <article className="room-card" key={i}>
              {photo && card ? (
                // The name contains the badge's words ("2 photos"): WCAG 2.5.3, what you see is what you say.
                <button type="button" className="room-card-photo" onClick={() => lightbox.show(card.name, card.photos)} aria-label={`See ${photoCount(card.photos.length)} of ${card.name}`}>
                  {/* A plain <img>, not next/image: the URL is the tenant's bucket, not a configured host. */}
                  <img src={photo} alt={card.name} loading="lazy" />
                  <span className="room-card-count">
                    <Icon name="image" size={14} />
                    {photoCount(card.photos.length)}
                  </span>
                </button>
              ) : null}
              <div className="room-card-body">
                <div className="room-card-title">{inline(title)}</div>
                {facts.length > 0 && (
                  <ul className="room-card-facts">
                    {facts.map((f, k) => (
                      <li key={k}>
                        <span className="room-card-label">{f.label}</span>
                        <span className="room-card-value">{inline(f.value)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {texts.map((t, k) => (
                  <p className="room-card-text" key={k}>
                    {texts.length > 1 && <span className="room-card-label">{t.label}</span>}
                    {inline(t.value)}
                  </p>
                ))}
              </div>
            </article>
          );
        })}
      </div>
      <Lightbox open={lightbox.open} close={lightbox.close} step={lightbox.step} to={lightbox.to} />
    </>
  );
}
