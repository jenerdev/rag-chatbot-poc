'use client';

// A tooltip that a keyboard sees too (plan/ui-components.md Phase 6). The
// native `title` shows on mouse hover only, after a delay, never on focus
// and never on a phone, so a reason kept there is hidden from most people.
//
// <Tip label="Edit"><button aria-label="Edit Garden Room">…</button></Tip>
// shows "Edit" on hover AND on keyboard focus (CSS :hover, :focus-visible).
// It follows WCAG 1.4.13: Escape hides it (dismissible), the pointer can
// move onto it without it vanishing (hoverable: no gap between it and its
// trigger), and it stays while hovered or focused (persistent).
//
// `describe`: the tip says something the control's name does not (a
// reason), so the control points at it with aria-describedby. Off by
// default: on an icon button the tip repeats the aria-label, and a screen
// reader would read it twice, so the tip is aria-hidden instead.

import { cloneElement, useId, useState, type ReactElement } from 'react';

export function Tip({ label, children, describe = false }: { label: string; children: ReactElement<{ 'aria-describedby'?: string }>; describe?: boolean }) {
  const id = useId();
  const [dismissed, setDismissed] = useState(false);
  return (
    <span
      className={dismissed ? 'tip dismissed' : 'tip'}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !dismissed) setDismissed(true);
      }}
      onMouseLeave={() => setDismissed(false)}
      onBlur={() => setDismissed(false)}
    >
      {describe ? cloneElement(children, { 'aria-describedby': id }) : children}
      <span role="tooltip" id={id} className="tip-text" aria-hidden={describe ? undefined : true}>
        {label}
      </span>
    </span>
  );
}
