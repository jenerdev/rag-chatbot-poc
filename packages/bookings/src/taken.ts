// taken.ts — the words a pending booking gets when its night is already
// confirmed (plan/staff-clash.md, D-099).
//
// The trigger bookings_pending_not_taken refuses the INSERT with 23P01, the
// exclusion constraint's own code, and a message that names the date and
// the unit: "taken on 2026-10-20: Garden Room is already confirmed for that
// slot". The constraint itself (a CONFIRMED insert on a confirmed night)
// raises the same code with Postgres's own text, which names the constraint
// and nothing a person wants to read. This is the ONE place the two are told
// apart: the trigger's words pass through unchanged; anything else gets the
// package's generic sentence, written where the date is known
// (bookings.ts, writeError()). Pure, so taken.test.ts can prove it.

import { BookingConflictError } from './errors.js';

// A confirmed night, or (schema-holds.sql, manage-booking Phase 5) a night
// another guest's stay holds while they pay.
const TAKEN = /^taken on (\d{4}-\d{2}-\d{2}): (.+) is (already confirmed|held for another guest) for that slot$/;

/** The trigger's refusal as the error the route maps to 409, with its words kept; null for any other error. */
export function takenError(error: { code?: string; message: string }): BookingConflictError | null {
  if (error.code !== '23P01') return null;
  const match = TAKEN.exec(error.message);
  if (!match) return null;
  return new BookingConflictError(takenMessage(match[1]!, match[2]!, match[3] !== 'already confirmed'));
}

/** "taken on 2026-10-20: Garden Room is already confirmed for that slot" (or "is held for another guest"), as the trigger writes it. */
export function takenMessage(date: string, unit: string, held = false): string {
  return `taken on ${date}: ${unit} is ${held ? 'held for another guest' : 'already confirmed'} for that slot`;
}
