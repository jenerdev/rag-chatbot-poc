// closed.ts's pure half: the trigger's refusal becomes the same words the
// code says first (D-080). The database half is tools/rooms.mjs, 30–33.

import { describe, expect, it } from 'vitest';
import { closedError, closedMessage } from './closed.js';
import { BookingInputError } from './errors.js';

describe('closedError', () => {
  it("reads bookings_not_on_closed_day's message as the code's words", () => {
    const error = closedError({ code: '23514', message: 'closed on 2026-12-26: Staff party' });
    expect(error).toBeInstanceOf(BookingInputError);
    expect(error?.message).toBe(closedMessage('2026-12-26', 'Staff party'));
    expect(error?.message).toBe('Closed on 2026-12-26 (Staff party). Choose another date.');
  });

  it('leaves every other refusal alone', () => {
    expect(closedError({ code: '23514', message: 'Unit 4 holds at most 2 guests, not 3' })).toBeNull();
    expect(closedError({ code: '23P01', message: 'closed on 2026-12-26: x' })).toBeNull();
  });
});
