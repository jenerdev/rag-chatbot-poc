'use client';

// The lightbox (D-094): a room's photos large on a dark overlay, arrows and
// a count when there is more than one, closed by the ×, the overlay or
// Escape, the arrow keys stepping. Shared by the room cards and the Photo
// column on a room table (reply-text.tsx). Every string is a child or a
// `src`; nothing is markup.

import { useCallback, useEffect, useState } from 'react';

export interface LightboxState {
  room: string;
  photos: string[];
  index: number;
}

/** The open/close/step state, bound to the keyboard only while open. */
export function useLightbox() {
  const [open, setOpen] = useState<LightboxState | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const show = useCallback((room: string, photos: string[]) => setOpen({ room, photos, index: 0 }), []);
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

/**
 * The three icons as inline SVG strokes, not text glyphs: a "‹" or "×"
 * character sits on a text baseline and never centres in a round button
 * the same way across fonts; a 24px path in a flex-centred button does.
 */
function Chevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d={dir === 'left' ? 'M15 5 8 12l7 7' : 'm9 5 7 7-7 7'} />
    </svg>
  );
}

function Cross() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function Lightbox({ open, close, step }: { open: LightboxState | null; close: () => void; step: (by: number) => void }) {
  if (!open) return null;
  return (
    <div className="lightbox" role="dialog" aria-label={`${open.room} photo ${open.index + 1} of ${open.photos.length}`} onClick={close}>
      {/* Clicks inside the frame must not close it: the arrows live there. */}
      <div className="lightbox-frame" onClick={(event) => event.stopPropagation()}>
        <img src={open.photos[open.index]} alt={`${open.room}, photo ${open.index + 1}`} />
        {open.photos.length > 1 && (
          <>
            <button type="button" className="lightbox-nav prev" onClick={() => step(-1)} aria-label="Previous photo">
              <Chevron dir="left" />
            </button>
            <button type="button" className="lightbox-nav next" onClick={() => step(1)} aria-label="Next photo">
              <Chevron dir="right" />
            </button>
            <div className="lightbox-count">
              {open.index + 1} / {open.photos.length}
            </div>
          </>
        )}
        <button type="button" className="lightbox-close" onClick={close} aria-label="Close">
          <Cross />
        </button>
      </div>
    </div>
  );
}
