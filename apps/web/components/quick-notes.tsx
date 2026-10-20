'use client';

// Quick notes (D-135): a row of chips above a note field. One click fills the
// field with that sentence; the field stays editable, and a chip whose
// sentence is the field's current text reads as pressed. The words come
// from lib/quick-notes.ts, the ONE table of them.
//
// A chip is a real <button type="button">, so it never submits the form it
// sits in, and aria-pressed tells a screen reader which one is in the field.
// `danger` colours the pressed chip like a refusal, for the notes a guest
// reads as a "no" (decline, cancel, reject).

import { Icon } from './icons';

export function QuickNotes({ options, value, onPick, danger = false, label = 'Quick notes' }: { options: readonly string[]; value: string; onPick: (note: string) => void; danger?: boolean; label?: string }) {
  if (options.length === 0) return null;
  return (
    <div className={`chip-picks${danger ? ' danger' : ''}`} role="group" aria-label={label}>
      {options.map((note) => {
        const picked = value.trim() === note;
        return (
          <button key={note} type="button" className={`chip${picked ? ' picked' : ''}`} aria-pressed={picked} onClick={() => onPick(note)}>
            {picked && <Icon name="check" size={12} />}
            {note}
          </button>
        );
      })}
    </div>
  );
}
