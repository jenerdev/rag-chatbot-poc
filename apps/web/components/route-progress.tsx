'use client';

// route-progress.tsx — the sign that a page is on its way (D-145). Rendered
// INSIDE a <Link>: Next's useLinkStatus() says whether that link's navigation
// is pending (the next page's server render and its code, in flight). While
// it is, two things show: a small ring at the end of the link that was
// clicked, and a thin bar along the top of the viewport. Both are aria-hidden:
// the page that arrives is the announcement; a status that said "loading"
// on every click would be chatter.
//
// The bar is portalled out of the link, to the tenant's root (or <body> on
// the platform). Inside the sidebar it was the sidebar's: a sticky ancestor
// is a fixed element's containing block, and only a 40 % sweep of it was
// coloured at any instant, so it read as a bar over the sidebar; out there,
// on a faint full-width track, it spans the whole viewport (the user: "make
// it full width").
//
// Nothing here knows about routes, timers or a store. The hook is the whole
// state, and a pending link that is unmounted (the page changed) takes its
// bar with it.

import { useLinkStatus } from 'next/link';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * `ring`: the ring at the link's end; off for an icon-only link (the bell),
 * where the bar alone is the sign. `onPending`: told when this link's
 * navigation starts and ends, for the frame that draws the coming page's
 * bones in place of the old page meanwhile (staff-frame.tsx, D-149). The
 * hook is still the whole state: this only repeats it upward.
 */
export function LinkProgress({ ring = true, onPending }: { ring?: boolean; onPending?: (pending: boolean) => void } = {}) {
  const { pending } = useLinkStatus();
  useEffect(() => {
    onPending?.(pending);
  }, [pending, onPending]);
  // The portal needs the document; on the server and in the first client render there is none to agree on.
  // Its target is the tenant's root, not <body>: the theme's colours are custom properties on
  // `.tenant-root` (tokens.css), and a bar outside it would wear the default accent, not the tenant's.
  const [body, setBody] = useState<HTMLElement | null>(null);
  useEffect(() => setBody(document.querySelector<HTMLElement>('.tenant-root') ?? document.body), []);
  if (!pending) return null;
  return (
    <>
      {ring && <span className="link-pending" aria-hidden="true" />}
      {body && createPortal(<span className="route-progress" aria-hidden="true" />, body)}
    </>
  );
}
