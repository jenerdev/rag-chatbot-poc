// The pure half of booking types (plan/booking-types.md Phase 2): the config's
// defaults, the rooms of a booking, prices in centavos, and what a photo is.
// No database. The half that needs Postgres (prices from the trigger, a group
// that clashes, capacity) is tools/rooms.mjs.

import { describe, expect, it } from 'vitest';
import { MAX_PRICE, MAX_UNITS_PER_BOOKING } from './constants.js';
import { BookingInputError } from './errors.js';
import { parseConfig, parsePrice, parseRooms, positiveInt, sniffImageType } from './validate.js';

describe('parseConfig', () => {
  it('gives every existing tenant whole_resort, Fri–Sun and PHP', () => {
    // Villa's row exactly as it is in the database today: timezone only.
    expect(parseConfig({ timezone: 'Asia/Manila' }, 'villa')).toEqual({
      timezone: 'Asia/Manila',
      bookingType: 'whole_resort',
      weekendDays: [5, 6, 7],
      currency: 'PHP',
      maxStayNights: 14,
      maxAdvanceDays: 365,
      freeUpToAge: null,
    });
  });

  it('reads a per_room config as written', () => {
    expect(
      parseConfig({ timezone: 'Asia/Manila', booking_type: 'per_room', weekend_days: [6, 7], currency: 'USD', max_stay_nights: 3, max_advance_days: 90 }, 'harbor'),
    ).toEqual({ timezone: 'Asia/Manila', bookingType: 'per_room', weekendDays: [6, 7], currency: 'USD', maxStayNights: 3, maxAdvanceDays: 90, freeUpToAge: null });
  });

  it.each([
    [{}, 'no timezone'],
    [null, 'no config at all'],
    [{ timezone: 'Asia/Manila', booking_type: 'per_bed' }, 'an unknown type'],
    [{ timezone: 'Asia/Manila', weekend_days: [0, 6] }, 'weekday 0'],
    [{ timezone: 'Asia/Manila', weekend_days: ['6'] }, 'a weekday as text'],
    [{ timezone: 'Asia/Manila', weekend_days: 6 }, 'not an array'],
    [{ timezone: 'Asia/Manila', currency: 'php' }, 'lower-case currency'],
    [{ timezone: 'Asia/Manila', max_stay_nights: 0 }, 'a zero-night max stay'],
    [{ timezone: 'Asia/Manila', max_stay_nights: '7' }, 'a max stay as text'],
    [{ timezone: 'Asia/Manila', max_advance_days: 731 }, 'a horizon past two years'],
  ])('refuses %j (%s), because SQL would have', (config) => {
    // Not a BookingInputError: a row that fails here was written around the
    // trigger, which is a fault, not a user's bad input.
    expect(() => parseConfig(config, 'x')).toThrow(Error);
    expect(() => parseConfig(config, 'x')).not.toThrow(BookingInputError);
  });
});

describe('parseRooms', () => {
  it('keeps the old one-unit shape, with its guest count', () => {
    expect(parseRooms({ unitId: 3, guestCount: 4 })).toEqual([{ unitId: 3, guestCount: 4 }]);
    expect(parseRooms({ unitId: '3' })).toEqual([{ unitId: 3, guestCount: null }]);
  });

  it('reads several rooms, each with its own guest count', () => {
    expect(parseRooms({ rooms: [{ unitId: 1, guestCount: 2 }, { unitId: 2 }] })).toEqual([
      { unitId: 1, guestCount: 2 },
      { unitId: 2, guestCount: null },
    ]);
  });

  it.each([
    [{}, 'neither'],
    [{ unitId: 1, rooms: [{ unitId: 2 }] }, 'both'],
    [{ rooms: [] }, 'an empty list'],
    [{ rooms: 'room 1' }, 'not a list'],
    [{ rooms: [{ unitId: 1 }, { unitId: 1 }] }, 'the same room twice'],
    [{ rooms: [{ unitId: 0 }] }, 'id 0'],
    [{ rooms: [{ unitId: 1.5 }] }, 'a fraction'],
    [{ rooms: [{ unitId: 1, guestCount: -2 }] }, 'negative guests'],
    [{ rooms: Array.from({ length: MAX_UNITS_PER_BOOKING + 1 }, (_, i) => ({ unitId: i + 1 })) }, 'too many rooms'],
  ])('refuses %j (%s)', (input) => {
    expect(() => parseRooms(input)).toThrow(BookingInputError);
  });
});

describe('parsePrice', () => {
  it.each([0, 1, 350000, MAX_PRICE])('accepts %d centavos', (n) => {
    expect(parsePrice(n, 'Price')).toBe(n);
  });

  it.each([
    [16000.1, 'a float peso: refused, not rounded'],
    [-1, 'negative'],
    [MAX_PRICE + 1, 'over the cap'],
    ['350000', 'text'],
    [Number.NaN, 'NaN'],
  ])('refuses %s (%s)', (value) => {
    expect(() => parsePrice(value, 'Price')).toThrow(BookingInputError);
  });
});

describe('positiveInt', () => {
  it('reads numbers and numeric strings', () => {
    expect(positiveInt(7, 'x')).toBe(7);
    expect(positiveInt('7', 'x')).toBe(7);
  });
  it.each([0, -1, 1.5, '', ' ', 'seven', null, undefined])('refuses %j', (value) => {
    expect(() => positiveInt(value, 'x')).toThrow(BookingInputError);
  });
});

describe('sniffImageType', () => {
  const bytes = (...values: number[]) => new Uint8Array([...values, ...new Array(16).fill(0)]);
  const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

  it('knows JPEG, PNG and WebP by their first bytes', () => {
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toEqual({ ext: 'jpg', contentType: 'image/jpeg' });
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toEqual({ ext: 'png', contentType: 'image/png' });
    expect(sniffImageType(bytes(...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WEBP')))).toEqual({ ext: 'webp', contentType: 'image/webp' });
  });

  it.each([
    ['SVG, which can carry script', ascii('<svg xmlns="http://www.w3.org/2000/svg">')],
    ['a GIF', ascii('GIF89a')],
    ['a PDF', ascii('%PDF-1.7')],
    ['a RIFF that is not WebP (a WAV)', [...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WAVE')]],
    ['half a PNG signature', [0x89, 0x50, 0x4e, 0x47]],
    ['nothing', []],
  ])('refuses %s', (_label, values) => {
    // Unpadded: a truncated signature must not match on zeros.
    expect(sniffImageType(new Uint8Array(values))).toBeNull();
  });
});
