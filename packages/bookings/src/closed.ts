// closed.ts — the dates a tenant is closed (D-080, schema-closed-days.sql).
//
// A closed date is a holiday-calendar row with kind 'closed'. It closes the
// whole property for every slot that STARTS on that date.
//
// This file is wall 1: the reads that say "closed", and the check a write
// makes before it reaches Postgres, so the person gets the reason in words.
// Wall 2 is the two triggers in schema-closed-days.sql, which refuse the
// write whatever this code does. Every query filters on tenant_id
// (CLAUDE.md rule 6), and any token of the tenant may read the calendar.

import { BookingInputError } from './errors.js';
import type { BookingTenant } from './types.js';

/** The closed dates from `from` to `to`, both included: day → the label staff gave it. */
export async function closedDays(tenant: BookingTenant, from: string, to: string): Promise<Map<string, string>> {
  const { data, error } = await tenant.db
    .from('rate_calendar')
    .select('day, label')
    .eq('tenant_id', tenant.id)
    .eq('kind', 'closed')
    .gte('day', from)
    .lte('day', to);
  if (error) throw new Error(`Could not load the closed dates: ${error.message}`);
  return new Map(data.map((d) => [d.day, d.label]));
}

/** Refuse, in words, when any of `dates` is closed. The first one is named. */
export async function refuseClosedDays(tenant: BookingTenant, dates: string[]): Promise<void> {
  if (dates.length === 0) return;
  const sorted = [...dates].sort();
  const closed = await closedDays(tenant, sorted[0]!, sorted[sorted.length - 1]!);
  const first = sorted.find((d) => closed.has(d));
  if (first) throw new BookingInputError(closedMessage(first, closed.get(first)!));
}

/** "Closed on 2026-12-25 (Maintenance). Choose another date." One wording for the code and the trigger. */
export function closedMessage(date: string, label: string): string {
  return `Closed on ${date} (${label}). Choose another date.`;
}

/**
 * The trigger's refusal, "closed on <date>: <label>" with 23514, as the same
 * words. Null when the error is something else.
 */
export function closedError(error: { code?: string; message: string }): BookingInputError | null {
  if (error.code !== '23514') return null;
  const match = /closed on (\d{4}-\d{2}-\d{2}): (.*)$/.exec(error.message);
  return match ? new BookingInputError(closedMessage(match[1]!, match[2]!)) : null;
}
