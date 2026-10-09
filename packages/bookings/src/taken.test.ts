// taken.ts's pure half: the trigger's refusal keeps its words; the
// constraint's refusal, the same code, does not match and falls through to
// the generic sentence. The database half is tools/rooms.mjs, 4d.

import { describe, expect, it } from 'vitest';
import { BookingConflictError } from './errors.js';
import { takenError, takenMessage } from './taken.js';

describe('takenError', () => {
  it("passes a hold's words through too (schema-holds.sql)", () => {
    const error = takenError({ code: '23P01', message: 'taken on 2026-10-20: Garden Room is held for another guest for that slot' });
    expect(error?.status).toBe(409);
    expect(error?.message).toBe(takenMessage('2026-10-20', 'Garden Room', true));
  });

  it("passes bookings_pending_not_taken's words through as a 409", () => {
    const error = takenError({ code: '23P01', message: 'taken on 2026-10-20: Garden Room is already confirmed for that slot' });
    expect(error).toBeInstanceOf(BookingConflictError);
    expect(error?.status).toBe(409);
    expect(error?.message).toBe(takenMessage('2026-10-20', 'Garden Room'));
  });

  it('keeps a unit name with spaces and punctuation whole', () => {
    const error = takenError({ code: '23P01', message: 'taken on 2026-10-20: Sea View Suite (2nd floor) is already confirmed for that slot' });
    expect(error?.message).toContain('Sea View Suite (2nd floor)');
  });

  it("is null for the constraint's own 23P01 and for any other code", () => {
    expect(takenError({ code: '23P01', message: 'conflicting key value violates exclusion constraint "bookings_no_overlap"' })).toBeNull();
    expect(takenError({ code: '23514', message: 'taken on 2026-10-20: Garden Room is already confirmed for that slot' })).toBeNull();
    expect(takenError({ message: 'taken on 2026-10-20: Garden Room is already confirmed for that slot' })).toBeNull();
  });
});
