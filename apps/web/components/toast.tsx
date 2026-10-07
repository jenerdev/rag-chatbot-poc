'use client';

// Toasts: what an action says when it is done (plan/ui-components.md Phase 1,
// D-102). Before them, each staff screen kept a notice at the TOP of the
// page, so "Deleted …" for a row at the bottom appeared where nobody was
// looking, and an open drawer (a modal) hid it altogether.
//
// useNotice() keeps the old setNotice() signature, so a screen changes a few
// lines, not its logic:
//   - a success becomes a toast that goes by itself after a few seconds;
//   - an error while the screen's drawer is open stays IN the drawer
//     (`notice`, drawn as the .drawer-notice it already had), beside the form
//     that has to change;
//   - any other error becomes a toast that stays until it is closed.
// Standing facts (an overlap warning, a closed date) stay .notice banners.
//
// ONE queue per browser tab, and ONE <Toaster /> per page, rendered by the
// page's frame (StaffFrame, the platform screen), so two panels on one page
// (the platform's tenant form and its members) never stack two regions in
// the same corner, and a toast outlives the component that raised it (the
// tenant form that is replaced once "Created." is said).
//
// The region is a popover="manual" element: the top layer, like <dialog>.
// Without it, a toast would sit under any open modal. It is shown once, on
// mount, so the live region exists before the first message (a region
// created together with its text is often not announced), and shown again
// only when a modal is open, so it lands above that modal.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Icon } from './icons';
import { pushToast, toastTimeout, type ToastItem, type ToastKind } from '@/lib/toast';

export type Notice = { message: string; kind: ToastKind } | null;

// --- the queue: module state, read through useSyncExternalStore -----------

const NONE: ToastItem[] = [];
let queue: ToastItem[] = NONE;
let nextId = 1;
const listeners = new Set<() => void>();

function publish(next: ToastItem[]) {
  queue = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function dismiss(id: number) {
  publish(queue.filter((t) => t.id !== id));
}

/** A toast from anywhere on the page. */
export function notify(message: string, kind: ToastKind) {
  publish(pushToast(queue, { id: nextId++, message, kind }));
}

/**
 * `drawerOpen`: whether the screen's drawer (or its inline form) is open
 * now. Read when an error arrives, after an await too, so it is kept in a
 * ref, not a closure.
 */
export function useNotice(drawerOpen = false) {
  const inDrawer = useRef(drawerOpen);
  useEffect(() => {
    inDrawer.current = drawerOpen;
  }, [drawerOpen]);

  const [formError, setFormError] = useState<string | null>(null);

  /** null clears the drawer's error; toasts go on their own or when closed. */
  const setNotice = useCallback((notice: Notice) => {
    if (notice === null) return setFormError(null);
    if (notice.kind === 'error' && inDrawer.current) return setFormError(notice.message);
    setFormError(null);
    notify(notice.message, notice.kind);
  }, []);

  const notice: Notice = formError === null ? null : { message: formError, kind: 'error' };
  return { notice, setNotice };
}

// --- the region ----------------------------------------------------------

export function Toaster() {
  const items = useSyncExternalStore(subscribe, () => queue, () => NONE);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const region = ref.current;
    if (!region?.showPopover) return;
    try {
      if (!region.matches(':popover-open')) region.showPopover();
      // The top layer stacks by the order things were shown: re-show to
      // land above a modal opened since. Only then, since hiding and showing
      // again can cost a screen reader the announcement.
      else if (items.length > 0 && document.querySelector('dialog:modal')) {
        region.hidePopover();
        region.showPopover();
      }
    } catch {
      // A browser without :modal or popovers: the region stays in the page.
    }
  }, [items]);

  return (
    <div ref={ref} popover="manual" className="toasts" role="region" aria-label="Notifications">
      {items.map((item) => (
        <Toast key={item.id} item={item} />
      ))}
    </div>
  );
}

function Toast({ item }: { item: ToastItem }) {
  // Paused while the pointer or the focus is on it: nobody loses a message
  // they are reading. The full time starts again when they leave.
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const ms = toastTimeout(item.kind);
    if (ms === null || paused) return;
    const timer = setTimeout(() => dismiss(item.id), ms);
    return () => clearTimeout(timer);
  }, [item, paused]);

  return (
    <div
      className={`toast ${item.kind}`}
      role={item.kind === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Icon name={item.kind === 'ok' ? 'check' : 'alert'} size={18} />
      <span className="toast-message">{item.message}</span>
      <button type="button" className="ghost sm" aria-label="Dismiss" onClick={() => dismiss(item.id)}>
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
