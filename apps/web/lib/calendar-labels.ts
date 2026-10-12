// calendar-labels.ts — the words for a date on the staff calendar (plan/calendar.md
// Rule 4, D-103). Pure, browser-safe, tested.
//
// Colour is never the only signal: every date says its state in the cell
// (cellText) and in one sentence for a screen reader (sentence). Both are
// made here from calendar_days()'s row, so the grid, the week and the legend
// cannot word the same state two ways. Nothing is counted here: the numbers
// are the row's.

import type { OccupancyDay, OccupancyState } from '@rag/bookings';

export const STATE_WORD: Readonly<Record<OccupancyState, string>> = {
  available: 'Available',
  partial: 'Partly booked',
  full: 'Fully booked',
  closed: 'Closed',
  none: 'Nothing to sell',
};

/**
 * The short text inside a cell: "Open", "3 / 8", "Full", "Closed", "—". An
 * available date that cannot be booked (past, or beyond the booking window)
 * says nothing: "Open" there read as an offer (the user, 2026-10-09). Its
 * sentence still says "available, in the past"; a count stays, as history.
 */
export function cellText(day: Pick<OccupancyDay, 'state' | 'taken' | 'sellable' | 'bookable'>): string {
  switch (day.state) {
    case 'available':
      return day.bookable ? 'Open' : '';
    case 'partial':
      return `${day.taken} of ${day.sellable}`;
    case 'full':
      return 'Full';
    case 'closed':
      return 'Closed';
    case 'none':
      return '—';
  }
}

/** "Friday 10 October 2026" — a calendar date, so formatted as UTC. */
export function longDate(date: string): string {
  // From its parts: whether a comma follows the weekday differs between
  // runtimes' locale data, and this sentence is tested.
  const at = new Date(`${date}T00:00:00Z`);
  const part = (options: Intl.DateTimeFormatOptions) => at.toLocaleDateString('en-GB', { ...options, timeZone: 'UTC' });
  return `${part({ weekday: 'long' })} ${at.getUTCDate()} ${part({ month: 'long' })} ${at.getUTCFullYear()}`;
}

export function pendingWords(n: number): string {
  return `${n} pending request${n === 1 ? '' : 's'}`;
}

/** The marker a date carries for its rate kind, or null. Closed is the background, not a marker. */
export function dayMarker(day: Pick<OccupancyDay, 'rateKind' | 'label'>): { kind: 'holiday' | 'peak'; text: string } | null {
  if (day.rateKind === 'holiday') return { kind: 'holiday', text: day.label ? `Holiday: ${day.label}` : 'Holiday' };
  if (day.rateKind === 'peak') return { kind: 'peak', text: day.label ? `Peak: ${day.label}` : 'Peak' };
  return null;
}

/**
 * Everything about a date in one sentence, for its button's aria-label:
 * "Friday 10 October 2026, today: partly booked, 3 of 8 taken, 1 pending
 * request, holiday: Araw ng mga Bayani".
 */
export function sentence(day: OccupancyDay, today: string): string {
  const parts: string[] = [];
  const head = `${longDate(day.day)}${day.day === today ? ', today' : ''}`;
  let state = STATE_WORD[day.state].toLowerCase();
  if (day.state === 'closed' && day.label) state += ` (${day.label})`;
  if (day.state === 'partial' || day.state === 'full') state += `, ${day.taken} of ${day.sellable} taken`;
  parts.push(state);
  if (day.pending > 0) parts.push(pendingWords(day.pending));
  const marker = dayMarker(day);
  if (marker) parts.push(marker.text.charAt(0).toLowerCase() + marker.text.slice(1));
  if (!day.bookable && day.state !== 'closed') parts.push(day.day < today ? 'in the past' : 'beyond the booking window');
  return `${head}: ${parts.join(', ')}`;
}
