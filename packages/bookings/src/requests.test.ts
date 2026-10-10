// The customer request checks' tests (plan/customer-booking.md Phase 2). No
// database: only the pure part that runs before request_booking() is called.
//
// request_booking() in SQL is the wall and checks all of this again (verify
// 82–89 prove that side). These prove the page gets the same answer first, in
// its own words, and that the two sides agree on the numbers.

import { describe, expect, it } from 'vitest';
import { MAX_BOOKING_ADVANCE_DAYS, MAX_REQUEST_ROWS, MAX_STAY_NIGHTS } from './constants.js';
import { BookingInputError } from './errors.js';
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
      rooms: [{ unitId: 3, guests: 32 }],
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

  it('whole_resort takes exactly one unit; per_room takes several, never the same twice', () => {
    const two = [{ unitId: 1, guests: 2 }, { unitId: 2, guests: 2 }];
    expect(refused({ rooms: two })).toMatch(/booked as a whole/);
    expect(parse({ rooms: two }, 'per_room').rooms).toHaveLength(2);
    expect(refused({ rooms: [{ unitId: 1, guests: 2 }, { unitId: 1, guests: 3 }] }, 'per_room')).toMatch(/twice/);
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
