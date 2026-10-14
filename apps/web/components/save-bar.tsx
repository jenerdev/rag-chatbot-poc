'use client';

import { Icon } from '@/components/icons';

/**
 * The bottom of a settings form, kept in view while it scrolls: whether
 * anything is unsaved, Discard, and the ONE submit. Save stays enabled when
 * nothing changed (a re-save is harmless), but says so.
 */
export function SaveBar({ dirty, busy, onDiscard, label }: { dirty: boolean; busy: boolean; onDiscard?: () => void; label: string }) {
  return (
    <div className={dirty ? 'save-bar dirty' : 'save-bar'}>
      <span className="save-bar-state" role="status">
        {dirty ? (
          <>
            <span className="save-dot" aria-hidden="true" /> Unsaved changes
          </>
        ) : (
          <>
            <Icon name="check" size={14} /> Everything is saved
          </>
        )}
      </span>
      {dirty && onDiscard && (
        <button type="button" disabled={busy} onClick={onDiscard}>
          Discard
        </button>
      )}
      <button type="submit" className="primary" disabled={busy}>
        {busy ? 'Saving…' : label}
      </button>
    </div>
  );
}
