// date-field.ts — the arithmetic and the words behind DateField and TimeField
// (plan/date-field.md, D-143). Pure, browser-safe, tested: the component
// only draws what these say, so the grid, the keys and the labels cannot
// disagree.
//
// A date is a YYYY-MM-DD string in the TENANT's calendar (trap 9); the
// arithmetic is UTC midnights, where a day is always 24 hours, as
// calendar-range.ts does. Weeks start on Monday, like the staff calendar,
// so the two grids read the same.

import { longDate } from './calendar-labels';
import { datesOf, firstOfMonth, isoWeekday, shiftDays } from './calendar-range';

const ms = (date: string) => Date.parse(`${date}T00:00:00Z`);
const iso = (time: number) => new Date(time).toISOString().slice(0, 10);

export const WEEKDAYS: ReadonlyArray<{ short: string; long: string }> = [
  { short: 'Mo', long: 'Monday' },
  { short: 'Tu', long: 'Tuesday' },
  { short: 'We', long: 'Wednesday' },
  { short: 'Th', long: 'Thursday' },
  { short: 'Fr', long: 'Friday' },
  { short: 'Sa', long: 'Saturday' },
  { short: 'Su', long: 'Sunday' },
];

export function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(ms(value)) && iso(ms(value)) === value;
}

/** "Thu, 21 Oct 2027": what the field shows. From its parts, so the test holds on every runtime's locale data. */
export function fieldDateLabel(date: string): string {
  const at = new Date(ms(date));
  const part = (options: Intl.DateTimeFormatOptions) => at.toLocaleDateString('en-GB', { ...options, timeZone: 'UTC' });
  return `${part({ weekday: 'short' })}, ${at.getUTCDate()} ${part({ month: 'short' })} ${at.getUTCFullYear()}`;
}

/** "October 2027": the dialog's heading. */
export function monthTitle(month: string): string {
  const at = new Date(ms(`${month}-01`));
  return `${at.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' })} ${at.getUTCFullYear()}`;
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** The month `direction` months away, as YYYY-MM. */
export function stepMonth(month: string, direction: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return iso(Date.UTC(y, m - 1 + direction, 1)).slice(0, 7);
}

/**
 * The month as rows of seven, Monday first; a cell outside the month is
 * null (drawn blank, not as the neighbour's day: in a picker a blank is
 * less to misread than a greyed 31 that belongs to last month).
 */
export function monthWeeks(month: string): (string | null)[][] {
  const first = `${month}-01`;
  const last = iso(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0));
  const days = datesOf(first, last);
  const rows: (string | null)[][] = [];
  let row: (string | null)[] = new Array(isoWeekday(first) - 1).fill(null);
  for (const day of days) {
    row.push(day);
    if (row.length === 7) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length > 0) rows.push([...row, ...new Array(7 - row.length).fill(null)]);
  return rows;
}

export function clampDate(date: string, min?: string, max?: string): string {
  if (min && date < min) return min;
  if (max && date > max) return max;
  return date;
}

export type DayState = { selectable: true; reason: null } | { selectable: false; reason: 'before' | 'after' | 'closed'; label?: string };

/** Whether a day can be chosen, and if not, why: before `min`, after `max`, or a closed date (with its label). */
export function dayState(date: string, bounds: { min?: string; max?: string; closed?: ReadonlyMap<string, string> }): DayState {
  if (bounds.min && date < bounds.min) return { selectable: false, reason: 'before' };
  if (bounds.max && date > bounds.max) return { selectable: false, reason: 'after' };
  const label = bounds.closed?.get(date);
  if (label !== undefined) return { selectable: false, reason: 'closed', label };
  return { selectable: true, reason: null };
}

/** The sentence a day's reason gets: under the grid for the focused day, and in each day's name. */
export function reasonWords(state: DayState, bounds: { min?: string; max?: string }): string {
  switch (state.reason) {
    case 'before':
      return bounds.min ? `before the earliest date, ${fieldDateLabel(bounds.min)}` : 'too early';
    case 'after':
      return bounds.max ? `after the latest date, ${fieldDateLabel(bounds.max)}` : 'too late';
    case 'closed':
      return state.label ? `closed (${state.label})` : 'closed';
    default:
      return '';
  }
}

/** A day's accessible name: "Thursday 21 October 2027, today, closed (Christmas)". */
export function dayName(date: string, today: string | undefined, state: DayState, bounds: { min?: string; max?: string }): string {
  const parts = [longDate(date)];
  if (date === today) parts.push('today');
  const why = reasonWords(state, bounds);
  if (why) parts.push(why);
  return parts.join(', ');
}

/**
 * Where the roving focus goes for a key, or null for a key the grid does not
 * handle. Left/Right a day, Up/Down a week, Home/End the week's Monday/Sunday,
 * PageUp/PageDown a month (a year with Shift), kept on the same day of the
 * month where it exists and on the month's last day otherwise.
 */
export function moveDate(date: string, key: string, shift = false): string | null {
  switch (key) {
    case 'ArrowLeft':
      return shiftDays(date, -1);
    case 'ArrowRight':
      return shiftDays(date, 1);
    case 'ArrowUp':
      return shiftDays(date, -7);
    case 'ArrowDown':
      return shiftDays(date, 7);
    case 'Home':
      return shiftDays(date, 1 - isoWeekday(date));
    case 'End':
      return shiftDays(date, 7 - isoWeekday(date));
    case 'PageUp':
      return sameDayIn(date, shift ? -12 : -1);
    case 'PageDown':
      return sameDayIn(date, shift ? 12 : 1);
    default:
      return null;
  }
}

function sameDayIn(date: string, months: number): string {
  const month = stepMonth(monthOf(date), months);
  const last = iso(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0));
  const day = date.slice(8, 10);
  const wanted = `${month}-${day}`;
  return wanted <= last ? wanted : last;
}

/**
 * The day the dialog opens on: the value; else today, within the bounds;
 * else the earliest allowed day; else `fallback` (the device's date, the
 * last resort when a field has no tenant: a promo's validity, the DPA date).
 */
export function openAt(value: string, today: string | undefined, bounds: { min?: string; max?: string }, fallback: string): string {
  if (value && isDate(value)) return value;
  if (today) return clampDate(today, bounds.min, bounds.max);
  if (bounds.min) return bounds.min;
  return clampDate(fallback, bounds.min, bounds.max);
}

/** The first of the month of `date`, for the heading; exported for the test. */
export { firstOfMonth };

// ——— the time field ———

const CLOCK = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export function isClock(value: string): boolean {
  return CLOCK.test(value);
}

/** "2:00 PM" for "14:00"; null when the text is not a time yet. */
export function clockLabel(hhmm: string): string | null {
  if (!isClock(hhmm)) return null;
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const hour = ((h + 11) % 12) + 1;
  return `${hour}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * What the time field keeps as the person types: digits and one colon, at
 * most five characters, the colon put in after two digits so "1400" reads
 * "14:00". Never rejects a keystroke outright: a half-typed time is shown
 * as invalid, not swallowed.
 */
export function normalizeClock(text: string): string {
  const digits = text.replace(/[^\d]/g, '').slice(0, 4);
  if (text.includes(':') || digits.length > 2) return `${digits.slice(0, 2)}:${digits.slice(2)}`.slice(0, 5);
  return digits;
}
