// The customer request checks' tests (plan/customer-booking.md Phase 2). No
// database: only the pure part that runs before request_booking() is called.
//
// request_booking() in SQL is the wall and checks all of this again (verify
// 82–89 prove that side). These prove the page gets the same answer first, in
// its own words, and that the two sides agree on the numbers.

import { describe, expect, it } from 'vitest';
import { MAX_BOOKING_ADVANCE_DAYS, MAX_REQUEST_ROWS, MAX_STAY_NIGHTS } from './constants.js';
import { BookingInputError } from './errors.js';
import { clashes, parseSpan, takingRows } from './requests.js';
import { addDays, normaliseEmail, normalisePhone, pageSettings, parseRequest, paymentFlow } from './validate.js';

const TODAY = '2026-09-28';
const valid = {
  slotId: 7,
  rooms: [{ unitId: 3, guests: 32 }],
  checkIn: '2026-11-12',
  nights: 2,
  name: '  Maria Santos ',
  phone: '0917 123 4567',
  email: ' Maria@Example.COM ',
  notes: '',
};
const parse = (overrides: Record<string, unknown> = {}, bookingType: 'whole_resort' | 'per_room' = 'whole_resort') =>
  parseRequest({ ...valid, ...overrides }, { today: TODAY, bookingType, maxNights: MAX_STAY_NIGHTS, maxAdvanceDays: MAX_BOOKING_ADVANCE_DAYS });
const refused = (overrides: Record<string, unknown>, bookingType: 'whole_resort' | 'per_room' = 'whole_resort') => {
  try {
    parse(overrides, bookingType);
  } catch (error) {
    expect(error).toBeInstanceOf(BookingInputError);
    return (error as Error).message;
  }
  throw new Error(`accepted: ${JSON.stringify(overrides)}`);
};

describe('the limits agree with request_booking()', () => {
  // schema-customer-booking.sql § 11: c_max_nights 14, c_max_advance 365,
  // c_max_rows 70. If one side changes alone, this fails.
  it('is 14 nights, 365 days, 70 rows', () => {
    expect([MAX_STAY_NIGHTS, MAX_BOOKING_ADVANCE_DAYS, MAX_REQUEST_ROWS]).toEqual([14, 365, 70]);
  });
});

describe('parseRequest', () => {
  it('trims, normalises and fills the defaults', () => {
    expect(parse()).toEqual({
      slotId: 7,
      rooms: [{ unitId: 3, guests: 32, free: 0 }],
      checkIn: '2026-11-12',
      nights: 2,
      name: 'Maria Santos',
      phone: '09171234567',
      email: 'maria@example.com',
      notes: null,
    });
    expect(parse({ nights: undefined }).nights).toBe(1);
  });

  it('accepts today and the last bookable day, refuses the day before and the day after', () => {
    expect(parse({ checkIn: TODAY, nights: 1 }).checkIn).toBe(TODAY);
    expect(parse({ checkIn: addDays(TODAY, MAX_BOOKING_ADVANCE_DAYS), nights: 1 }).checkIn).toBe('2027-09-28');
    expect(refused({ checkIn: '2026-09-27' })).toMatch(/in the past/);
    expect(refused({ checkIn: '2027-09-29' })).toMatch(/365 days ahead/);
    // A tenant's own horizon (D-078) replaces the default, counted from ITS today.
    const horizon = { today: TODAY, bookingType: 'whole_resort' as const, maxNights: 14, maxAdvanceDays: 30 };
    expect(parseRequest({ ...valid, checkIn: '2026-10-28', nights: 1 }, horizon).checkIn).toBe('2026-10-28');
    expect(() => parseRequest({ ...valid, checkIn: '2026-10-29', nights: 1 }, horizon)).toThrow(/30 days ahead, so the latest date is 2026-10-28/);
    expect(refused({ checkIn: '2026-02-30' })).toMatch(/not a date/);
  });

  it('accepts 14 nights and refuses 15 and 0', () => {
    expect(parse({ nights: 14 }).nights).toBe(14);
    expect(refused({ nights: 15 })).toMatch(/at most 14 nights/);
    // A tenant's own max stay (D-078) replaces the default.
    expect(() => parseRequest({ ...valid, nights: 4 }, { today: TODAY, bookingType: 'whole_resort', maxNights: 3, maxAdvanceDays: 365 })).toThrow(
      /at most 3 nights/,
    );
    expect(parseRequest({ ...valid, nights: 3 }, { today: TODAY, bookingType: 'whole_resort', maxNights: 3, maxAdvanceDays: 365 }).nights).toBe(3);
    expect(refused({ nights: 0 })).toMatch(/positive whole number/);
    expect(refused({ nights: 1.5 })).toMatch(/positive whole number/);
  });

  it('bounds units × nights at 70', () => {
    const five = [1, 2, 3, 4, 5].map((unitId) => ({ unitId, guests: 2 }));
    expect(parse({ rooms: five, nights: 14 }, 'per_room').rooms).toHaveLength(5);
    const six = [...five, { unitId: 6, guests: 2 }];
    expect(refused({ rooms: six, nights: 12 }, 'per_room')).toMatch(/72 room-nights/);
  });

  it('whole_resort takes exactly one unit; per_room takes several, a type once per room wanted (D-133)', () => {
    const two = [{ unitId: 1, guests: 2 }, { unitId: 2, guests: 2 }];
    expect(refused({ rooms: two })).toMatch(/booked as a whole/);
    expect(parse({ rooms: two }, 'per_room').rooms).toHaveLength(2);
    // Two rooms of one type: the database caps it at the type's free rooms, in words.
    expect(parse({ rooms: [{ unitId: 1, guests: 2 }, { unitId: 1, guests: 3 }] }, 'per_room').rooms).toEqual([
      { unitId: 1, guests: 2, free: 0 },
      { unitId: 1, guests: 3, free: 0 },
    ]);
    expect(refused({ rooms: [{ unitId: 1, guests: 2 }, { unitId: 1, guests: 3 }] })).toMatch(/booked as a whole/);
    expect(refused({ rooms: [] }, 'per_room')).toMatch(/at least one room/);
    expect(refused({ rooms: [{ unitId: 1 }] })).toMatch(/Guests/);
  });

  it('refuses a missing or bad contact detail', () => {
    expect(refused({ name: 'X' })).toMatch(/2 to 100 characters/);
    expect(refused({ name: 42 })).toMatch(/name is required/);
    expect(refused({ phone: '02 8123 4567' })).toMatch(/mobile number/);
    expect(refused({ phone: undefined })).toMatch(/mobile number/);
    expect(refused({ email: 'maria@' })).toMatch(/valid email/);
    expect(refused({ notes: 'x'.repeat(1001) })).toMatch(/longer than 1000/);
  });

  it("says the same rules in a staff member's words on the staff form (D-111)", () => {
    const staff = { today: TODAY, bookingType: 'whole_resort' as const, maxNights: MAX_STAY_NIGHTS, maxAdvanceDays: MAX_BOOKING_ADVANCE_DAYS, byStaff: true };
    expect(() => parseRequest({ ...valid, name: 'X' }, staff)).toThrow("The guest's name must be 2 to 100 characters.");
    expect(() => parseRequest({ ...valid, name: undefined }, staff)).toThrow("The guest's name is required.");
    // Everything else is the page's rule, unchanged: both contacts, the horizon, the guests.
    expect(() => parseRequest({ ...valid, email: undefined }, staff)).toThrow(/valid email/);
    expect(() => parseRequest({ ...valid, phone: '' }, staff)).toThrow(/mobile number/);
    expect(() => parseRequest({ ...valid, checkIn: '2026-09-27' }, staff)).toThrow(/in the past/);
    expect(parseRequest(valid, staff)).toEqual(parse());
  });
});

describe('normalisePhone', () => {
  it.each([
    ['0917 123 4567', '09171234567'],
    ['0917-123-4567', '09171234567'],
    ['+63 917 123 4567', '09171234567'],
    ['(0917) 123.4567', '09171234567'],
  ])('%s → %s', (input, output) => {
    expect(normalisePhone(input)).toBe(output);
  });
  it.each(['02 8123 4567', '0917 123 456', '+1 917 123 4567', '', 'call me'])('refuses %s', (input) => {
    expect(normalisePhone(input)).toBeNull();
  });
});

describe('normaliseEmail', () => {
  it('lower-cases and trims', () => {
    expect(normaliseEmail(' A.B@Example.PH ')).toBe('a.b@example.ph');
  });
  it.each(['a@b', 'a b@c.d', '@c.d', `${'x'.repeat(250)}@c.dd`])('refuses %s', (input) => {
    expect(normaliseEmail(input)).toBeNull();
  });
});

describe('pageSettings', () => {
  it('reads instructions and guest_hint, absent or blank is null', () => {
    expect(pageSettings({ timezone: 'Asia/Manila', booking_page: { instructions: ' Pay by GCash. ', guest_hint: '' } })).toEqual({
      instructions: 'Pay by GCash.',
      guestHint: null,
    });
    expect(pageSettings({ timezone: 'Asia/Manila' })).toEqual({ instructions: null, guestHint: null });
  });
});

describe('paymentFlow', () => {
  it('is null when the tenant takes no payment on the page', () => {
    expect(paymentFlow({ timezone: 'Asia/Manila' })).toBeNull();
    expect(paymentFlow(null)).toBeNull();
  });
  it('reads the deposit, the two windows and the hold', () => {
    expect(
      paymentFlow({ payments: { methods: [], fee: { kind: 'percent', value: 3000 }, pay_within_hours: 24, review_within_hours: 12, hold: 'on_proof' } }),
    ).toEqual({ deposit: true, payWithinHours: 24, reviewWithinHours: 12, hold: 'on_proof' });
  });
  it('the full price, no windows, no hold, when they are absent or odd', () => {
    expect(paymentFlow({ payments: { methods: [], fee: { kind: 'full' }, pay_within_hours: 0, hold: 'sometimes' } })).toEqual({
      deposit: false,
      payWithinHours: null,
      reviewWithinHours: null,
      hold: 'none',
    });
  });
});

describe('clashes: a pending stay against the nights other stays take', () => {
  const night = (group: string, unit: number, status: string, extra: Partial<{ held: boolean; held_until: string | null; during: string }> = {}) => ({
    group_id: group,
    unit_id: unit,
    during: '["2026-10-16 06:00:00+00","2026-10-17 04:00:00+00")',
    status,
    held: false,
    held_until: null as string | null,
    ...extra,
  });
  const now = Date.parse('2026-10-10T18:00:00Z');
  const future = '2026-10-11T09:13:46.062571+00:00';

  it('parses a stored span, half-open', () => {
    expect(parseSpan('["2026-10-16 06:00:00+00","2026-10-17 04:00:00+00")')).toEqual([Date.parse('2026-10-16T06:00:00Z'), Date.parse('2026-10-17T04:00:00Z')]);
    expect(parseSpan(null)).toBeNull();
  });

  it("never clashes with its OWN hold (ALT-F3CUFK's case)", () => {
    const own = [night('me', 1, 'pending', { held: true, held_until: future }), night('me', 2, 'pending', { held: true, held_until: future })];
    expect(clashes(own, 'me', takingRows(own, now))).toBe(false);
  });

  it("clashes with another stay's confirmed night, or its live hold, on the same unit", () => {
    const own = [night('me', 1, 'pending')];
    expect(clashes(own, 'me', takingRows([night('other', 1, 'confirmed')], now))).toBe(true);
    expect(clashes(own, 'me', takingRows([night('other', 1, 'pending', { held: true, held_until: future })], now))).toBe(true);
  });

  it('does not clash with a lapsed hold, a plain pending, another unit, or the next night', () => {
    const own = [night('me', 1, 'pending')];
    const others = [
      night('a', 1, 'pending', { held: true, held_until: '2026-10-10T00:00:00Z' }),
      night('b', 1, 'pending'),
      night('c', 2, 'confirmed'),
      // checks in at 14:00 the day this one checks out at 12:00: no overlap
      night('d', 1, 'confirmed', { during: '["2026-10-17 06:00:00+00","2026-10-18 04:00:00+00")' }),
    ];
    expect(clashes(own, 'me', takingRows(others, now))).toBe(false);
  });

  it('counts rooms (D-133): a type of 2 rooms clashes only when the others take as many as it has left', () => {
    const rooms = new Map([[1, 2]]);
    const inRoom = (group: string, status: string, room: number) => ({ ...night(group, 1, status), room_id: room });
    const one = [inRoom('other', 'confirmed', 10)];
    const both = [inRoom('a', 'confirmed', 10), inRoom('b', 'confirmed', 11)];
    // One pending room wanted: free with 1 of 2 taken, clashing with 2 of 2.
    expect(clashes([night('me', 1, 'pending')], 'me', takingRows(one, now), rooms)).toBe(false);
    expect(clashes([night('me', 1, 'pending')], 'me', takingRows(both, now), rooms)).toBe(true);
    // Two rooms of the type wanted the same night: 1 of 2 taken is not enough.
    expect(clashes([night('me', 1, 'pending'), night('me', 1, 'pending')], 'me', takingRows(one, now), rooms)).toBe(true);
    // Two rows of ANOTHER stay in one room (a long stay) are one room taken.
    const sameRoom = [inRoom('x', 'confirmed', 10), { ...inRoom('x', 'confirmed', 10), during: '["2026-10-16 07:00:00+00","2026-10-16 09:00:00+00")' }];
    expect(clashes([night('me', 1, 'pending')], 'me', takingRows(sameRoom, now), rooms)).toBe(false);
  });
});

// D-147 (plan/free-guests.md): a room's free guests are a second count,
// checked here as request_booking() checks them (0 to 50, whole), 0 when
// absent, and never part of a price (the quote and the trigger take guests).
describe('parseRequest: free guests (D-147)', () => {
  it('fills 0 when absent, keeps a count, and refuses a bad one in words', () => {
    expect(parse().rooms).toEqual([{ unitId: 3, guests: 32, free: 0 }]);
    expect(parse({ rooms: [{ unitId: 3, guests: 32, free: 2 }] }).rooms).toEqual([{ unitId: 3, guests: 32, free: 2 }]);
    expect(parse({ rooms: [{ unitId: 3, guests: 32, free: '1' }] }).rooms[0]!.free).toBe(1);
    expect(parse({ rooms: [{ unitId: 3, guests: 32, free: null }] }).rooms[0]!.free).toBe(0);
    expect(refused({ rooms: [{ unitId: 3, guests: 32, free: -1 }] })).toMatch(/Free guests must be a whole number from 0 to 50/);
    expect(refused({ rooms: [{ unitId: 3, guests: 32, free: 1.5 }] })).toMatch(/Free guests/);
    expect(refused({ rooms: [{ unitId: 3, guests: 32, free: 51 }] })).toMatch(/Free guests/);
    // The paying count is still required: a room of children alone is not a booking.
    expect(refused({ rooms: [{ unitId: 3, guests: 0, free: 2 }] })).toMatch(/Guests/);
  });
});
