'use client';

// The photo viewer (D-094, redrawn by plan/room-cards.md): a room's photos
// large on a dark overlay. Shared by the room cards and the Photo column on
// a room table (reply-text.tsx). Every string is a child or a `src`;
// nothing is markup.
//
// Its parts, top to bottom:
//   - a bar with the room's name, "2 of 5", and Close: nothing sits ON the
//     photo any more (the × and the count used to cover its corners);
//   - the photo, as large as the screen allows, with the arrows beside it
//     (over its edges on a phone, where there is no room beside it);
//   - with more than one photo, a strip of thumbnails: any photo in one tap.
//
// A modal dialog in fact (plan/ui-refresh.md Phase 4): focus moves to Close
// when it opens, Tab stays inside it, and focus goes back to what opened it
// when it closes; Escape, the overlay or Close closes it; the arrow keys
// step; on a phone a horizontal swipe steps, with pointer events, no
// library. It fades in, unless motion is reduced.

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
  /**
   * `from`: the control that opened it, where focus returns. Passed by the
   * caller because a click does not always focus a button (Safari, and a
   * scripted click), so "whatever had focus" can be the page itself.
   */
  const show = useCallback((room: string, photos: string[], from?: HTMLElement | null) => {
    opener.current = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setOpen({ room, photos, index: 0 });
  }, []);
  const step = useCallback(
    (by: number) => setOpen((o) => (o ? { ...o, index: (o.index + by + o.photos.length) % o.photos.length } : o)),
    [],
  );
  /** Straight to one photo: a thumbnail. */
  const to = useCallback((index: number) => setOpen((o) => (o && index >= 0 && index < o.photos.length ? { ...o, index } : o)), []);

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

  return { open, show, close, step, to };
}

/** A horizontal move longer than this, released, is a swipe. */
const SWIPE_PX = 40;

export function Lightbox({ open, close, step, to }: { open: LightboxState | null; close: () => void; step: (by: number) => void; to?: (index: number) => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const swipeFrom = useRef<number | null>(null);
  const isOpen = open !== null;
  useEffect(() => {
    if (isOpen) closeButton.current?.focus();
  }, [isOpen]);

  // Tab and Shift+Tab go round the dialog's own controls, never behind it.
  const keepFocus = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== 'Tab' || !dialog.current) return;
    const controls = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled)')];
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }, []);

  if (!open) return null;
  const many = open.photos.length > 1;
  return (
    <div
      ref={dialog}
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`${open.room}, photo ${open.index + 1} of ${open.photos.length}`}
      onKeyDown={keepFocus}
      // The dark around the photo closes it; the photo and the controls do not.
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (target === event.currentTarget || target.classList.contains('lightbox-stage')) close();
      }}
    >
      <div className="lightbox-bar">
        <span className="lightbox-title">{open.room}</span>
        {many && (
          <span className="lightbox-count" aria-hidden="true">
            {open.index + 1} of {open.photos.length}
          </span>
        )}
        <button ref={closeButton} type="button" className="lightbox-close" onClick={close} aria-label="Close photos">
          <Icon name="close" size={20} />
        </button>
      </div>

      <div
        className="lightbox-stage"
        onPointerDown={(event) => {
          swipeFrom.current = event.clientX;
        }}
        onPointerUp={(event) => {
          const from = swipeFrom.current;
          swipeFrom.current = null;
          if (from === null || !many) return;
          const moved = event.clientX - from;
          if (Math.abs(moved) > SWIPE_PX) step(moved < 0 ? 1 : -1);
        }}
      >
        {many && (
          <button type="button" className="lightbox-nav prev" onClick={() => step(-1)} aria-label="Previous photo">
            <Icon name="chevron-left" size={24} />
          </button>
        )}
        <img key={open.index} src={open.photos[open.index]} alt={`${open.room}, photo ${open.index + 1}`} />
        {many && (
          <button type="button" className="lightbox-nav next" onClick={() => step(1)} aria-label="Next photo">
            <Icon name="chevron-right" size={24} />
          </button>
        )}
      </div>

      {many && to && (
        <div className="lightbox-thumbs" role="group" aria-label="All photos">
          {open.photos.map((src, k) => (
            <button key={src + k} type="button" className="lightbox-thumb" aria-label={`Photo ${k + 1}`} aria-current={k === open.index ? 'true' : undefined} onClick={() => to(k)}>
              {/* Decorative here: the button is named. */}
              <img src={src} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
