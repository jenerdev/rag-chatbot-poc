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
// EmptyState is the third case, loaded and nothing there: a title, one line,
// and, when the member may add one, the button that does it, instead of a
// sentence that points at a button somewhere else on the page.

import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons';

export type Load = { state: 'loading' } | { state: 'error'; message: string };
export const LOADING: Load = { state: 'loading' };
export const failed = (message: string): Load => ({ state: 'error', message });

/**
 * The list's place-holder until its rows arrive. `rows`: about as many as the
 * list usually has, so the page does not jump when they come.
 */
export function LoadState({ load, onRetry, rows = 3, what = 'list' }: { load: Load; onRetry: () => void; rows?: number; what?: string }) {
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
