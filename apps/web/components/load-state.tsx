'use client';

// What a list shows when it has no rows to show (plan/ui-components.md
// Phases 2 and 3): still loading, failed to load, or loaded and empty.
//
// Before: a list's state was ONE string, "Loading…" until a failure wrote
// the error over it, in the same small grey text, with no way to try again
// but reloading the page. So a failed load looked like a slow one. Now the
// two are different values and look different: a skeleton while loading;
// an alert with a Retry button when it failed. Retry calls the screen's own
// load function, the one that failed (no new fetch, no new route).
//
// The skeleton has the SHAPE of what is coming (2026-10-20, the user: "skeleton
// loading UI should match the shape of real data/ui"). A screen passes its own
// `skeleton`, drawn with the SAME layout classes as its real rows and a Bone
// wherever a real row has text, a chip, an avatar or a button, so the
// placeholder cannot drift from the rows it stands for and the page does not
// jump when they arrive. Without one, the old two bars.
//
// EmptyState is the third case, loaded and nothing there: a title, one line,
// and, when the member may add one, the button that does it, instead of a
// sentence that points at a button somewhere else on the page.

import { Fragment, type CSSProperties, type ReactNode } from 'react';
import { Icon, type IconName } from './icons';

export type Load = { state: 'loading' } | { state: 'error'; message: string };
export const LOADING: Load = { state: 'loading' };
export const failed = (message: string): Load => ({ state: 'error', message });

/**
 * One grey shape standing for one piece of real content, inside the real
 * row's own layout. `w`: its width (a %, `ch` or `px` string; text is
 * usually a %). `h`: `line` (a line of body text, the default), `small`
 * (a muted meta line), `title` (a heading), `chip` (a badge or chip),
 * `button` / `button-sm` (a button's / a small button's height), or a CSS length. `round`: an avatar or an
 * icon (`circle`) or a pill (`pill`).
 */
export function Bone({ w = '100%', h = 'line', round, className }: { w?: string; h?: 'line' | 'small' | 'title' | 'chip' | 'button' | 'button-sm' | string; round?: 'circle' | 'pill'; className?: string }) {
  const named = h === 'line' || h === 'small' || h === 'title' || h === 'chip' || h === 'button' || h === 'button-sm';
  const style: CSSProperties = { width: w, ...(named ? {} : { height: h }) };
  return <span className={['bone', named ? `bone-${h}` : null, round ? `bone-${round}` : null, className].filter(Boolean).join(' ')} style={style} aria-hidden="true" />;
}

/**
 * `n` copies of a skeleton row, keyed; widths may vary by `i` so the rows do
 * not look stamped. Fragments, not a wrapper: a wrapper made every row the
 * first of its kind, and `.list-row:first-of-type` dropped every divider.
 */
export function boneRows(n: number, row: (i: number) => ReactNode): ReactNode[] {
  return Array.from({ length: n }, (_, i) => <Fragment key={i}>{row(i)}</Fragment>);
}

/**
 * The list's place-holder until its rows arrive. `rows`: about as many as the
 * list usually has, so the page does not jump when they come. `skeleton`: the
 * screen's own, shaped like its real rows (see the header); it is drawn as
 * given, `rows` is for the generic one only.
 */
export function LoadState({ load, onRetry, rows = 3, what = 'list', skeleton }: { load: Load; onRetry: () => void; rows?: number; what?: string; skeleton?: ReactNode }) {
  if (load.state === 'error') {
    return (
      <div className="notice error load-error" role="alert">
        <span>
          Could not load the {what}. {load.message}
        </span>
        <button type="button" className="sm" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }
  if (skeleton) {
    return (
      <div className="skeleton-shape" role="status" aria-label={`Loading the ${what}`}>
        {/* Hidden from assistive tech: the status's name says what is loading. */}
        <div aria-hidden="true" inert>
          {skeleton}
        </div>
      </div>
    );
  }
  return (
    <div className="skeleton-list" role="status" aria-label={`Loading the ${what}`}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row" aria-hidden="true">
          <span className="skeleton-bar short" />
          <span className="skeleton-bar" />
        </div>
      ))}
    </div>
  );
}

/**
 * Loaded, and nothing there. `action`: the page's own add button, or none
 * (a role that may not add gets none, the same courtesy as the page's).
 * `compact`: inside a small panel (requests, the dashboard's arrivals).
 */
export function EmptyState({ icon, title, children, action, compact }: { icon: IconName; title: string; children?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={compact ? 'empty-list compact' : 'empty-list'}>
      <span className="empty-list-icon" aria-hidden="true">
        <Icon name={icon} size={20} />
      </span>
      <strong>{title}</strong>
      {children && <span>{children}</span>}
      {action && <div className="empty-list-action">{action}</div>}
    </div>
  );
}
