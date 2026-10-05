'use client';

// The lightbox (D-094): a room's photos large on a dark overlay, arrows and
// a count when there is more than one, closed by the ×, the overlay or
// Escape, the arrow keys stepping. Shared by the room cards and the Photo
// column on a room table (reply-text.tsx). Every string is a child or a
// `src`; nothing is markup.
//
// Since plan/ui-refresh.md Phase 4: a modal dialog in fact, not only in
// name. Focus moves to Close when it opens and back to the photo that opened
// it when it closes; it fades in (unless motion is reduced); on a phone a
// horizontal swipe steps, with pointer events, no library.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './icons';

export interface LightboxState {
  room: string;
  photos: string[];
  index: number;
}

/** The open/close/step state, bound to the keyboard only while open. */
export function useLightbox() {
  const [open, setOpen] = useState<LightboxState | null>(null);
  // What had focus when it opened: focus goes back there on close.
  const opener = useRef<HTMLElement | null>(null);
  const close = useCallback(() => {
    setOpen(null);
    opener.current?.focus();
    opener.current = null;
  }, []);
  const show = useCallback((room: string, photos: string[]) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen({ room, photos, index: 0 });
  }, []);
  const step = useCallback(
    (by: number) => setOpen((o) => (o ? { ...o, index: (o.index + by + o.photos.length) % o.photos.length } : o)),
    [],
  );

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

  return { open, show, close, step };
}

/** A horizontal move longer than this, released, is a swipe. */
const SWIPE_PX = 40;

export function Lightbox({ open, close, step }: { open: LightboxState | null; close: () => void; step: (by: number) => void }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const swipeFrom = useRef<number | null>(null);
  const isOpen = open !== null;
  useEffect(() => {
    if (isOpen) closeButton.current?.focus();
  }, [isOpen]);

  if (!open) return null;
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={`${open.room} photo ${open.index + 1} of ${open.photos.length}`} onClick={close}>
      {/* Clicks inside the frame must not close it: the arrows live there. */}
      <div
        className="lightbox-frame"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => {
          swipeFrom.current = event.clientX;
        }}
        onPointerUp={(event) => {
          const from = swipeFrom.current;
          swipeFrom.current = null;
          if (from === null || open.photos.length < 2) return;
          const moved = event.clientX - from;
          if (Math.abs(moved) > SWIPE_PX) step(moved < 0 ? 1 : -1);
        }}
      >
        <img src={open.photos[open.index]} alt={`${open.room}, photo ${open.index + 1}`} />
        {open.photos.length > 1 && (
          <>
            <button type="button" className="lightbox-nav prev" onClick={() => step(-1)} aria-label="Previous photo">
              <Icon name="chevron-left" size={24} />
            </button>
            <button type="button" className="lightbox-nav next" onClick={() => step(1)} aria-label="Next photo">
              <Icon name="chevron-right" size={24} />
            </button>
            <div className="lightbox-count">
              {open.index + 1} / {open.photos.length}
            </div>
          </>
        )}
        <button ref={closeButton} type="button" className="lightbox-close" onClick={close} aria-label="Close">
          <Icon name="close" size={22} />
        </button>
      </div>
    </div>
  );
}
