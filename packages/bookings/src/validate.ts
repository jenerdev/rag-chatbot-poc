// validate.ts — the input checks, pure and I/O-free so they can be tested alone.
//
// Validation lives in this package, not only at the route (plan/bookings.md
// Phase 2). There are two callers, the admin Route Handlers and the chatbot's
// tool executor, and only one of them has a zod schema in front of it. The
// other one's arguments were written by a model.

import { BookingInputError } from './errors.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Is this a real calendar date written as YYYY-MM-DD?
 *
 * The shape check alone would accept "2026-02-30". `Date` would then roll it
 * over to 2 March without complaint, so the parsed date is written back out and
 * must match the input. That round trip is what rejects impossible dates.
 */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Whole days from `from` to `to`. Both are YYYY-MM-DD, compared as UTC midnights, so no DST. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Today's date in a timezone, as YYYY-MM-DD.
 *
 * The TENANT'S today, not the server's (plan/bookings.md § 2.3). A server in
 * UTC at 23:30 Manila time is still on the previous day. That is enough to
 * reject a booking for "today" as being in the past, or to accept yesterday.
 *
 * This is formatting an instant into a zone, which Intl does correctly. The
 * reverse, turning a wall-clock time into an instant, is the error-prone
 * direction, and that one is done in SQL (slot_range).
 */
export function localDate(timezone: string, now: Date = new Date()): string {
  // en-CA formats a date as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Check a date range, and fill in `to` when it is missing (a single day).
 *
 * `allowPast` is true for the admin list, where staff look back at who came,
 * and false for availability, where a past date has no useful answer.
 *
 * The messages are written to be read by a person AND by a model. When the
 * tool executor gets one of these, it hands it back to the model as the tool
 * result so the model can ask the user for a proper date. So the message says
 * what was wrong and what would be right.
 */
export function validateRange(
  range: { from: unknown; to?: unknown },
  { today, maxDays, allowPast }: { today: string; maxDays: number; allowPast: boolean },
): { from: string; to: string } {
  const { from } = range;
  const to = range.to ?? from;
  if (!isIsoDate(from)) throw new BookingInputError(`"${String(from)}" is not a date. Use YYYY-MM-DD.`);
  if (!isIsoDate(to)) throw new BookingInputError(`"${String(to)}" is not a date. Use YYYY-MM-DD.`);
  if (to < from) throw new BookingInputError(`The end date ${to} is before the start date ${from}.`);
  if (!allowPast && from < today) {
    throw new BookingInputError(`${from} is in the past. Today is ${today}.`);
  }
  const days = daysBetween(from, to) + 1;
  if (days > maxDays) {
    throw new BookingInputError(`${days} days is too long a range. The limit is ${maxDays} days.`);
  }
  return { from, to };
}

/** A required, trimmed, bounded string, such as a guest name. */
export function requireText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '') throw new BookingInputError(`${label} is required.`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new BookingInputError(`${label} is longer than ${maxLength} characters.`);
  return trimmed;
}

/** An optional, trimmed, bounded string. Empty becomes null, so the column holds NULL, never "". */
export function optionalText(value: unknown, label: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new BookingInputError(`${label} must be text.`);
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > maxLength) throw new BookingInputError(`${label} is longer than ${maxLength} characters.`);
  return trimmed;
}
