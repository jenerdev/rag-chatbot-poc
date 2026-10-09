// calendar-range.ts — which dates each calendar view covers (plan/calendar.md
// § 4.2, D-103). Pure and browser-safe: the route uses it to decide what to
// read, the screen to step Earlier / Later and to lay out the grid, so the two
// can never disagree about which days a "month" holds.
//
// Dates are YYYY-MM-DD strings in the TENANT's calendar (trap 9), and the
// arithmetic is done on UTC midnights, where a day is always 24 hours. Weeks
// start on Monday (ISO), as the bookings config's weekend_days do.

export const VIEWS = ['month', 'week', 'day'] as const;
export type CalendarView = (typeof VIEWS)[number];

export function isView(value: unknown): value is CalendarView {
  return typeof value === 'string' && (VIEWS as readonly string[]).includes(value);
}

const ms = (date: string) => Date.parse(`${date}T00:00:00Z`);
const iso = (time: number) => new Date(time).toISOString().slice(0, 10);

export function shiftDays(date: string, days: number): string {
  return iso(ms(date) + days * 86_400_000);
}

/** 1 = Monday … 7 = Sunday (ISO). */
export function isoWeekday(date: string): number {
  return new Date(ms(date)).getUTCDay() || 7;
}

export function mondayOf(date: string): string {
  return shiftDays(date, 1 - isoWeekday(date));
}

export function firstOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** The year and month (1-12) of a YYYY-MM-DD date. */
function yearMonth(date: string): [number, number] {
  return [Number(date.slice(0, 4)), Number(date.slice(5, 7))];
}

function lastOfMonth(date: string): string {
  const [y, m] = yearMonth(date);
  return iso(Date.UTC(y, m, 0)); // day 0 of the next month
}

/**
 * The dates a view shows, both ends included. A month is the whole grid:
 * Monday on or before the 1st to Sunday on or after the last day, so 28, 35 or
 * 42 days, and the neighbouring months' days are read too (plan § 2.6).
 */
export function rangeFor(view: CalendarView, date: string): { from: string; to: string } {
  if (view === 'day') return { from: date, to: date };
  if (view === 'week') {
    const from = mondayOf(date);
    return { from, to: shiftDays(from, 6) };
  }
  const from = mondayOf(firstOfMonth(date));
  const last = lastOfMonth(date);
  return { from, to: shiftDays(last, 7 - isoWeekday(last)) };
}

/** The date one step Earlier (-1) or Later (+1): a month keeps to the 1st, so 31 January → 1 February, never 3 March. */
export function step(view: CalendarView, date: string, direction: -1 | 1): string {
  if (view === 'day') return shiftDays(date, direction);
  if (view === 'week') return shiftDays(date, 7 * direction);
  const [y, m] = yearMonth(date);
  return iso(Date.UTC(y, m - 1 + direction, 1));
}

/** The dates of a range, in order. */
export function datesOf(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = shiftDays(d, 1)) out.push(d);
  return out;
}

/**
 * The months the "Go to month" select offers, as "YYYY-MM", oldest first:
 * `back` months before `today`'s month to `ahead` after it. The month on
 * screen is always among them, even when Earlier / Later went further out.
 */
export function monthOptions(today: string, shown: string, back = 12, ahead = 12): string[] {
  const [y, m] = yearMonth(today);
  const months: string[] = [];
  for (let i = -back; i <= ahead; i++) months.push(iso(Date.UTC(y, m - 1 + i, 1)).slice(0, 7));
  const current = shown.slice(0, 7);
  if (!months.includes(current)) months.push(current);
  return months.sort();
}
