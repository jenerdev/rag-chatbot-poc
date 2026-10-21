'use client';

// time-field.tsx — a 24-hour time typed as text, "14:00" (plan/date-field.md,
// D-143). `type="time"` drew a different control in every browser and a
// wheel on a phone; a text box with a numeric keyboard draws the same box
// everywhere, keeps any minute (a slot may start at 14:10), and says the
// 12-hour reading under it so a typo is seen before it is saved. The value
// is still "HH:MM", what `type="time"` gave, so nothing after the field
// changes.

import { useId } from 'react';
import { clockLabel, isClock, normalizeClock } from '@/lib/date-field';

export function TimeField({ id, value, onChange, required, disabled }: { id: string; value: string; onChange: (value: string) => void; required?: boolean; disabled?: boolean }) {
  const hintId = `${useId()}-hint`;
  const reading = clockLabel(value);
  return (
    <>
      <input
        id={id}
        type="text"
        className="time-field"
        inputMode="numeric"
        autoComplete="off"
        placeholder="14:00"
        maxLength={5}
        // The pattern is what `required` and a submit check; the reading below is what a person checks.
        pattern="([01][0-9]|2[0-3]):[0-5][0-9]"
        required={required}
        disabled={disabled}
        value={value}
        aria-invalid={value !== '' && !isClock(value) ? true : undefined}
        aria-describedby={hintId}
        onChange={(event) => onChange(normalizeClock(event.target.value))}
      />
      <div className={`hint${value !== '' && !isClock(value) ? ' field-error' : ''}`} id={hintId}>
        {reading ?? '24-hour clock, like 14:00 for 2:00 PM'}
      </div>
    </>
  );
}
