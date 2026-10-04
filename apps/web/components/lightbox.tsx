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
  );
}
