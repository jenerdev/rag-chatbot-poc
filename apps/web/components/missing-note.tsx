'use client';

// D-155: a form's submit button is never disabled because the form is
// incomplete (the user, 2026-11-03: people were left "finding what else is
// missing" behind a greyed-out button). It stays on; a click with something
// missing sends nothing, says what is missing in the danger tone, and takes
// the person to that field. A button is still disabled while its request is
// in flight (no double submit), and where a disabled state is a guard of its
// own rather than a missing field (Confirm on a clashing stay, trap 21).
//
// Every form uses this ONE pair:
//   const gate = useMissingGate();
//   const missing: Missing | null = …the form's own first gap, or null…;
//   onSubmit: if (gate.blocked(missing)) return;
//   <MissingNote missing={missing} tried={gate.tried} idle="Ready to save." />
// Before a click the note is the form's muted hint (or the gap itself, muted,
// as the booking page always said it); after a click that found a gap it is
// an alert, which a screen reader announces, and it follows the person as
// they fill fields in: the next gap, then the idle hint once nothing is left.

import { useCallback, useState } from 'react';
import { Icon } from './icons';
import type { Missing } from '@/lib/missing';

export { firstMissing, type Missing } from '@/lib/missing';

/** Take the person to the field: focus it, bring it into view, and mark it until they change it. */
function showField(id: string | undefined) {
  if (!id) return;
  const el = document.getElementById(id);
  if (!(el instanceof HTMLElement)) return;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
  el.focus({ preventScroll: true });
  // aria-invalid draws the danger border (base.css). Only set when the
  // element does not manage it itself, and cleared on the first edit.
  if (el.getAttribute('aria-invalid') === null) {
    el.setAttribute('aria-invalid', 'true');
    const clear = () => {
      el.removeAttribute('aria-invalid');
      el.removeEventListener('input', clear);
      el.removeEventListener('change', clear);
    };
    el.addEventListener('input', clear);
    el.addEventListener('change', clear);
  }
}

export function useMissingGate() {
  const [tried, setTried] = useState(false);
  /** At the top of a submit: true (and the gap shown) when something is missing. */
  const blocked = useCallback((missing: Missing | null): boolean => {
    if (!missing) return false;
    setTried(true);
    showField(missing.field);
    return true;
  }, []);
  /** After a successful submit or a reset form: the next attempt starts quiet. */
  const reset = useCallback(() => setTried(false), []);
  return { tried, blocked, reset };
}

/**
 * The line beside a form's button. `idle` is shown when nothing is missing
 * (or nothing until a click, with `quiet`); null idle draws nothing then.
 */
export function MissingNote({
  missing,
  tried,
  idle = null,
  quiet = false,
  className,
}: {
  missing: Missing | null;
  tried: boolean;
  idle?: string | null;
  /** true: say nothing about a gap until a click found one (forms with no hint of their own) */
  quiet?: boolean;
  className?: string;
}) {
  if (missing && tried) {
    return (
      <span className={`missing-note missing-note-alert${className ? ` ${className}` : ''}`} role="alert">
        <Icon name="alert" size={16} />
        {missing.message}
      </span>
    );
  }
  const text = missing && !quiet ? missing.message : idle;
  if (!text) return null;
  return <span className={`missing-note small muted${className ? ` ${className}` : ''}`}>{text}</span>;
}
