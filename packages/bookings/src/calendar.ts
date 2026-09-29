// calendar.ts — a tenant's holiday and peak days (plan/customer-booking.md § 2.3).
//
// A holiday is a DATE, not a rule: Holy Week moves, special non-working days
// are declared by proclamation, a fiesta is one town's. So staff type them
// in, and unit_price() reads them (schema-customer-booking.sql § 6). This file
// holds no price arithmetic: it only keeps the list.
//
// Reading is open to any token of the tenant (the page shows which dates are
// holidays); writing is staff only, and RLS refuses a chat token's writes
// anyway. Every query filters on tenant_id (CLAUDE.md rule 6).
//
// A change here never reprices a request or booking already stored: the
// trigger keeps a row's breakdown unless the row moves.

import { MAX_CALENDAR_LABEL } from './constants.js';
import { requireConfig } from './bookings.js';
import { BookingInputError } from './errors.js';
import type { BookingTenant, CalendarDay } from './types.js';
import { addDays, isIsoDate, localDate, parsePrice, requireText, validateRange } from './validate.js';

/**
 * The calendar from `from` to `to`, both included, in date order. Defaults:
 * today to a year from today, in the tenant's timezone. Past dates are allowed,
 * so staff can copy last year's.
 */
export async function listCalendar(tenant: BookingTenant, range: { from?: unknown; to?: unknown } = {}): Promise<CalendarDay[]> {
  const { timezone } = await requireConfig(tenant);
  const today = localDate(timezone);
  const start = range.from ?? today;
  const { from, to } = validateRange(
    { from: start, to: range.to ?? (isIsoDate(start) ? addDays(start, 366) : start) },
    { today, maxDays: 800, allowPast: true },
  );
  const { data, error } = await tenant.db
    .from('rate_calendar')
    .select('day, kind, label, surcharge')
    .eq('tenant_id', tenant.id)
    .gte('day', from)
    .lte('day', to)
    .order('day');
  if (error) throw new Error(`Could not load the holiday calendar: ${error.message}`);
  return data.map((d) => ({ day: d.day, kind: d.kind, label: d.label, surcharge: d.surcharge }));
}

/**
 * Add a holiday, or change the one already on that date (an upsert on
 * (tenant, day)). `surcharge` is centavos per night per unit, 0 by default.
 */
export async function setCalendarDay(
  tenant: BookingTenant,
  input: { day?: unknown; kind?: unknown; label?: unknown; surcharge?: unknown },
): Promise<CalendarDay> {
  await requireConfig(tenant);
  const kind = calendarKind(input.kind);
  const row = {
    tenant_id: tenant.id,
    day: calendarDate(input.day),
    kind,
    label: requireText(input.label, 'Label', MAX_CALENDAR_LABEL),
    // Centavos, bounded by MAX_PRICE like every amount (a typo guard).
    surcharge: input.surcharge === undefined || input.surcharge === null || input.surcharge === '' ? 0 : parsePrice(input.surcharge, 'Surcharge'),
  };
  // Nothing is sold on a closed date, so it has no surcharge (the table says so too).
  if (kind === 'closed' && row.surcharge !== 0) throw new BookingInputError('A closed date has no surcharge.');
  const { data, error } = await tenant.db
    .from('rate_calendar')
    .upsert(row, { onConflict: 'tenant_id,day' })
    .select('day, kind, label, surcharge')
    .single();
  if (error) throw calendarError(error, `Could not save ${row.day}`);
  console.log(`[bookings] ${tenant.slug} calendar ${row.day} ${row.kind} "${row.label}" +${row.surcharge}`);
  return { day: data.day, kind: data.kind, label: data.label, surcharge: data.surcharge };
}

/**
 * Remove a holiday. `false` means "not yours or not there".
 *
 * Counted, not trusted: a delete RLS refuses is not an error, just 0 rows
 * (CLAUDE.md trap 17 is the same lesson from Storage).
 */
export async function removeCalendarDay(tenant: BookingTenant, day: unknown): Promise<boolean> {
  await requireConfig(tenant);
  const date = calendarDate(day);
  const { data, error } = await tenant.db.from('rate_calendar').delete().eq('tenant_id', tenant.id).eq('day', date).select('day');
  if (error) throw new Error(`Could not remove ${date}: ${error.message}`);
  if (data.length > 0) console.log(`[bookings] ${tenant.slug} calendar ${date} removed`);
  return data.length > 0;
}

/**
 * Copy chosen days to the same month and day of another year: last year's
 * 24, 25 and 31 Dec become this year's (plan § 2.3). Staff choose which, on
 * the screen, because only they know which dates are fixed. Holy Week is
 * never among them: it moves. A 29 February is skipped in a year without one.
 * An existing entry on the target date is overwritten.
 */
export async function copyCalendarDays(
  tenant: BookingTenant,
  input: { days?: unknown; toYear?: unknown },
): Promise<CalendarDay[]> {
  await requireConfig(tenant);
  if (!Array.isArray(input.days) || input.days.length === 0) throw new BookingInputError('Choose at least one date to copy.');
  if (input.days.length > 100) throw new BookingInputError('Copy at most 100 dates at once.');
  const toYear = input.toYear;
  if (typeof toYear !== 'number' || !Number.isInteger(toYear) || toYear < 2000 || toYear > 2100) {
    throw new BookingInputError('The year to copy to must be a year such as 2027.');
  }
  const days = input.days.map(calendarDate);

  const { data, error } = await tenant.db
    .from('rate_calendar')
    .select('day, kind, label, surcharge')
    .eq('tenant_id', tenant.id)
    .in('day', days);
  if (error) throw new Error(`Could not load the dates to copy: ${error.message}`);
  // Every row carries every key (CLAUDE.md trap 15).
  const rows = data
    .map((d) => ({ tenant_id: tenant.id, day: `${toYear}${d.day.slice(4)}`, kind: d.kind, label: d.label, surcharge: d.surcharge }))
    .filter((r) => isIsoDate(r.day));
  if (rows.length === 0) return [];

  const { data: saved, error: saveError } = await tenant.db
    .from('rate_calendar')
    .upsert(rows, { onConflict: 'tenant_id,day' })
    .select('day, kind, label, surcharge');
  if (saveError) throw calendarError(saveError, 'Could not copy the dates');
  console.log(`[bookings] ${tenant.slug} calendar copied ${saved.length} date(s) to ${toYear}`);
  return saved
    .map((d) => ({ day: d.day, kind: d.kind, label: d.label, surcharge: d.surcharge }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
}

function calendarDate(value: unknown): string {
  if (!isIsoDate(value)) throw new BookingInputError(`"${String(value)}" is not a date. Use YYYY-MM-DD.`);
  return value;
}

function calendarKind(value: unknown): 'holiday' | 'peak' | 'closed' {
  if (value === undefined || value === null || value === '') return 'holiday';
  if (value === 'holiday' || value === 'peak' || value === 'closed') return value;
  throw new BookingInputError('Kind must be "holiday", "peak" or "closed".');
}

/**
 * A calendar write Postgres refused on purpose: closing a date that has
 * confirmed bookings (rate_calendar_closed_check, D-080). Its message says
 * how many, and what to do. Anything else stays a plain Error.
 */
function calendarError(error: { code?: string; message: string }, what: string): Error {
  if (error.code === '23514' && /confirmed booking/.test(error.message)) {
    const match = /^(\d{4}-\d{2}-\d{2}) has (\d+) confirmed/.exec(error.message);
    return new BookingInputError(
      match
        ? `${match[1]} has ${match[2]} confirmed booking${match[2] === '1' ? '' : 's'}. Cancel or move ${match[2] === '1' ? 'it' : 'them'} before closing the date.`
        : error.message,
    );
  }
  return new Error(`${what}: ${error.message}`);
}
