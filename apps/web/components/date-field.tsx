'use client';

// date-field.tsx — the ONE date picker (plan/date-field.md, D-143). A button
// that reads like a field, and a month grid in a small dialog under it; every
// browser draws the same thing, where `type="date"` drew Chrome's icon,
// Safari's spinner and the iPhone's wheel.
//
// The native input is still here, invisible, over the button: it holds the
// value for the form, so `required`, `min` and `max` still stop a submit
// exactly as before. The browser's bubble is suppressed (the invalid event is
// cancelled) and the same message is drawn under the field instead, so that
// too looks the same everywhere. A form with `noValidate` never fires it and
// keeps its own hints, as the booking page does.
//
// Keyboard (WAI-ARIA date picker dialog): Enter, Space or an arrow opens;
// arrows move a day or a week, Home/End the week's ends, PageUp/PageDown a
// month (Shift: a year), Enter or Space chooses, Escape closes and focus
// returns to the button. Tab leaves the dialog, which closes it. One day in
// the grid is in the Tab order at a time (roving tabindex). A day that cannot
// be chosen (before `min`, after `max`, closed) is aria-disabled, so it is
// still read, with its reason.
//
// No library, no CSS framework (D-101): `lib/date-field.ts` has the
// arithmetic and the words, tested; `.date-*` in screens.css the look, on
// tokens.

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { longDate } from '@/lib/calendar-labels';
import { WEEKDAYS, dayName, dayState, fieldDateLabel, monthOf, monthTitle, monthWeeks, moveDate, openAt, reasonWords, stepMonth, clampDate } from '@/lib/date-field';
import { Icon } from './icons';

export type DateFieldProps = {
  id: string;
  /** '' or YYYY-MM-DD. */
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  required?: boolean;
  disabled?: boolean;
  /** The TENANT's today (trap 9): the Today mark, and where an empty field opens. Without it there is no mark. */
  today?: string;
  /** Dates that cannot be chosen, each with its reason (a closed date's label). */
  closed?: ReadonlyArray<{ day: string; label: string }>;
  placeholder?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
};

/** The device's date, as a last resort for a field with no tenant and no bounds (openAt's fallback). */
function deviceToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function DateField({ id, value, onChange, min, max, required, disabled, today, closed, placeholder = 'Choose a date', ...aria }: DateFieldProps) {
  const [open, setOpen] = useState(false);
  const [focusDate, setFocusDate] = useState(value || today || min || '');
  const [missing, setMissing] = useState<string | null>(null);
  const [align, setAlign] = useState<'left' | 'right'>('left');
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cells = useRef(new Map<string, HTMLButtonElement>());
  const wantFocus = useRef(false);
  const uid = useId();
  const valueId = `${uid}-value`;
  const titleId = `${uid}-title`;
  const noteId = `${uid}-note`;
  const errorId = `${uid}-error`;

  const closedMap = new Map((closed ?? []).map((c) => [c.day, c.label]));
  const bounds = { min, max, closed: closedMap };
  const month = monthOf(focusDate || openAt(value, today, bounds, deviceToday()));

  // The field's own message clears the moment a date is chosen.
  useEffect(() => {
    if (value) setMissing(null);
  }, [value]);

  // While open: a pointer down outside closes it; focus moves to the day the
  // grid opened on, or to the day a key moved to.
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (wrapper.current && !wrapper.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  useEffect(() => {
    if (open && wantFocus.current) {
      cells.current.get(focusDate)?.focus();
      wantFocus.current = false;
    }
  }, [open, focusDate]);

  function show() {
    if (disabled) return;
    const at = openAt(value, today, bounds, deviceToday());
    setFocusDate(at);
    // Open to the right when the dialog would run past the viewport's edge (a field in the right half of a row).
    const box = wrapper.current?.getBoundingClientRect();
    setAlign(box && box.left + 300 > window.innerWidth ? 'right' : 'left');
    wantFocus.current = true;
    setOpen(true);
  }

  function hide(backToButton: boolean) {
    setOpen(false);
    if (backToButton) trigger.current?.focus();
  }

  function choose(date: string) {
    if (!dayState(date, bounds).selectable) return;
    onChange(date);
    hide(true);
  }

  function go(next: string | null) {
    if (!next) return;
    // Keep the focus inside the bounds, so an arrow never lands on a day that cannot be chosen for being out of range.
    const kept = clampDate(next, min, max);
    wantFocus.current = true;
    setFocusDate(kept);
  }

  function onGridKey(event: KeyboardEvent<HTMLTableElement>) {
    const moved = moveDate(focusDate, event.key, event.shiftKey);
    if (moved) {
      event.preventDefault();
      go(moved);
    } else if (event.key === 'Enter' || event.key === ' ') {
      // Handled here, once, and the default stopped: otherwise the day button's own
      // activation would choose the same day a second time.
      event.preventDefault();
      choose(focusDate);
    }
  }

  function onTriggerKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) show();
    }
  }

  const prevMonth = stepMonth(month, -1);
  const nextMonth = stepMonth(month, 1);
  const canPrev = !min || `${prevMonth}-31` >= min;
  const canNext = !max || `${nextMonth}-01` <= max;
  const focused = focusDate ? dayState(focusDate, bounds) : null;
  const note = focused && !focused.selectable ? reasonWords(focused, bounds) : '';
  const describedBy = [valueId, missing ? errorId : null, aria['aria-describedby'] ?? null].filter(Boolean).join(' ');
  const todayState = today ? dayState(today, bounds) : null;

  return (
    <div
      ref={wrapper}
      className={`date-field${open ? ' open' : ''}`}
      onBlur={(event) => {
        // Tab out of the dialog closes it: focus went somewhere else on the page. A blur with NO
        // next target is not that: on iOS a tap on a button focuses nothing, so the day would blur
        // with null and the dialog would close under the finger. That case is the pointerdown
        // listener's, which knows where the pointer went.
        const next = event.relatedTarget as Node | null;
        if (open && next && wrapper.current && !wrapper.current.contains(next)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        id={id}
        className={`date-trigger${value ? '' : ' empty'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-invalid={aria['aria-invalid'] || missing !== null || undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        onClick={() => (open ? hide(true) : show())}
        onKeyDown={onTriggerKey}
      >
        <span className="date-value">{value ? fieldDateLabel(value) : placeholder}</span>
        <Icon name="calendar" size={16} />
      </button>
      {/* The words a screen reader gets for the value: the long date, not the short one the sighted reader gets. */}
      <span id={valueId} className="visually-hidden">
        {value ? longDate(value) : 'No date chosen'}
      </span>
      <input
        type="date"
        className="date-native"
        tabIndex={-1}
        aria-hidden="true"
        value={value}
        min={min}
        max={max}
        required={required}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onInvalid={(event) => {
          // The same words in every browser, under the field, instead of the browser's bubble.
          event.preventDefault();
          const input = event.currentTarget;
          setMissing(
            input.validity.valueMissing
              ? 'Choose a date.'
              : input.validity.rangeUnderflow && min
                ? `Too early: the earliest is ${fieldDateLabel(min)}.`
                : input.validity.rangeOverflow && max
                  ? `Too far ahead: the latest is ${fieldDateLabel(max)}.`
                  : 'Choose a valid date.',
          );
          trigger.current?.focus();
        }}
      />
      {missing && (
        <div className="hint field-error" id={errorId} role="alert">
          <Icon name="alert" size={14} /> {missing}
        </div>
      )}
      {open && (
        <div
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          className={`date-pop ${align}`}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              hide(true);
            }
          }}
        >
          <div className="date-head">
            <button type="button" className="ghost sm" aria-label="Previous month" disabled={!canPrev} onClick={() => go(clampDate(`${prevMonth}-${focusDate.slice(8, 10)}`, min, max))}>
              <Icon name="chevron-left" size={16} />
            </button>
            <h2 id={titleId} className="date-title" aria-live="polite">
              {monthTitle(month)}
            </h2>
            <button type="button" className="ghost sm" aria-label="Next month" disabled={!canNext} onClick={() => go(clampDate(`${nextMonth}-01`, min, max))}>
              <Icon name="chevron-right" size={16} />
            </button>
          </div>
          <table role="grid" className="date-grid" aria-labelledby={titleId} onKeyDown={onGridKey}>
            <thead>
              <tr>
                {WEEKDAYS.map((d) => (
                  <th key={d.short} scope="col" abbr={d.long}>
                    <span aria-hidden="true">{d.short}</span>
                    <span className="visually-hidden">{d.long}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {monthWeeks(month).map((week, i) => (
                <tr key={i}>
                  {week.map((date, j) =>
                    date === null ? (
                      <td key={j} className="date-blank" />
                    ) : (
                      <td key={date} role="gridcell" aria-selected={date === value || undefined}>
                        {(() => {
                          const state = dayState(date, bounds);
                          return (
                            <button
                              type="button"
                              ref={(el) => {
                                if (el) cells.current.set(date, el);
                                else cells.current.delete(date);
                              }}
                              className={`date-day${date === value ? ' selected' : ''}${date === today ? ' today' : ''}${state.selectable ? '' : ` off ${state.reason}`}`}
                              tabIndex={date === focusDate ? 0 : -1}
                              aria-label={dayName(date, today, state, bounds)}
                              aria-disabled={state.selectable ? undefined : true}
                              aria-describedby={date === focusDate && note ? noteId : undefined}
                              onClick={() => choose(date)}
                              onFocus={() => setFocusDate(date)}
                            >
                              {Number(date.slice(8, 10))}
                            </button>
                          );
                        })()}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="date-foot">
            {/* The focused day's reason, once, for the eye; each day's name carries its own for the ear. */}
            <p className="date-note" id={noteId}>
              {note ? note.charAt(0).toUpperCase() + note.slice(1) : ' '}
            </p>
            <div className="date-actions">
              {today && todayState?.selectable && (
                <button type="button" className="sm" onClick={() => choose(today)}>
                  Today
                </button>
              )}
              {value && !required && (
                <button type="button" className="ghost sm" onClick={() => { onChange(''); hide(true); }}>
                  Clear
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
