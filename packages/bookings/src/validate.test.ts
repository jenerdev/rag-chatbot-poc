// The input checks' tests. No database and no network, only the pure part.
//
// These matter more than usual because one of the two callers is a model. A
// date it writes is text that looked plausible to it, not text that was ever
// checked, so every way a date can be almost right is below.

import { describe, expect, it } from 'vitest';
import { BookingInputError } from './errors.js';
import { daysBetween, freeGuestsWords, isIsoDate, localDate, optionalText, parseConfig, partyWords, requireText, validateRange } from './validate.js';

describe('isIsoDate', () => {
  it.each(['2026-10-01', '2028-02-29', '2026-12-31'])('accepts %s', (d) => {
    expect(isIsoDate(d)).toBe(true);
  });

  it.each([
    ['2026-02-30', 'rolls over to March in Date'],
    ['2026-02-29', 'not a leap year'],
    ['2026-13-01', 'month 13'],
    ['2026-1-1', 'not zero-padded'],
    ['01/10/2026', 'another format'],
    ['2026-10-01T00:00:00Z', 'a timestamp'],
    ['October 1', 'words'],
    ['', 'empty'],
  ])('rejects %s (%s)', (d) => {
    expect(isIsoDate(d)).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isIsoDate(20261001)).toBe(false);
    expect(isIsoDate(null)).toBe(false);
    expect(isIsoDate(undefined)).toBe(false);
  });
});

describe('daysBetween', () => {
  it('counts whole days, across a month end', () => {
    expect(daysBetween('2026-10-01', '2026-10-01')).toBe(0);
    expect(daysBetween('2026-10-30', '2026-11-02')).toBe(3);
  });
});

describe('localDate — the tenant\'s today, not the server\'s', () => {
  // 16:30 UTC on 30 Sept is 00:30 on 1 Oct in Manila (UTC+8).
  const instant = new Date('2026-09-30T16:30:00Z');

  it('is already tomorrow in Manila', () => {
    expect(localDate('Asia/Manila', instant)).toBe('2026-10-01');
  });

  it('is still today in UTC', () => {
    expect(localDate('UTC', instant)).toBe('2026-09-30');
  });

  it('throws on a timezone that does not exist', () => {
    expect(() => localDate('Mars/Olympus_Mons', instant)).toThrow(RangeError);
  });
});

describe('validateRange', () => {
  const opts = { today: '2026-10-01', maxDays: 31, allowPast: false };

  it('fills in `to` when only one date is given', () => {
    expect(validateRange({ from: '2026-10-12' }, opts)).toEqual({ from: '2026-10-12', to: '2026-10-12' });
  });

  it('accepts today', () => {
    expect(validateRange({ from: '2026-10-01' }, opts).from).toBe('2026-10-01');
  });

  it('refuses the past, and says what today is so the model can correct itself', () => {
    expect(() => validateRange({ from: '2026-09-30' }, opts)).toThrow('2026-09-30 is in the past. Today is 2026-10-01.');
  });

  it('allows the past when asked to (the admin list)', () => {
    expect(validateRange({ from: '2020-01-01' }, { ...opts, allowPast: true }).from).toBe('2020-01-01');
  });

  it('refuses an end before the start', () => {
    expect(() => validateRange({ from: '2026-10-12', to: '2026-10-11' }, opts)).toThrow(BookingInputError);
  });

  it('counts both ends: 31 days is the limit, 32 is over it', () => {
    expect(validateRange({ from: '2026-10-01', to: '2026-10-31' }, opts).to).toBe('2026-10-31');
    expect(() => validateRange({ from: '2026-10-01', to: '2026-11-01' }, opts)).toThrow('32 days');
  });

  it('refuses an impossible date with a message that says the format', () => {
    expect(() => validateRange({ from: '2026-02-30' }, opts)).toThrow('Use YYYY-MM-DD');
  });

  it('throws BookingInputError, which carries status 400', () => {
    try {
      validateRange({ from: 'tomorrow' }, opts);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BookingInputError);
      expect((error as BookingInputError).status).toBe(400);
    }
  });
});

describe('requireText / optionalText', () => {
  it('trims, and refuses blank', () => {
    expect(requireText('  Ana  ', 'Guest name', 10)).toBe('Ana');
    expect(() => requireText('   ', 'Guest name', 10)).toThrow('Guest name is required.');
    expect(() => requireText(42, 'Guest name', 10)).toThrow(BookingInputError);
  });

  it('bounds the length', () => {
    expect(() => requireText('x'.repeat(11), 'Guest name', 10)).toThrow('longer than 10');
  });

  it('turns empty into null, so the column holds NULL and not ""', () => {
    expect(optionalText('', 'Notes', 10)).toBeNull();
    expect(optionalText('   ', 'Notes', 10)).toBeNull();
    expect(optionalText(undefined, 'Notes', 10)).toBeNull();
    expect(optionalText(' hi ', 'Notes', 10)).toBe('hi');
  });
});

// D-147 (plan/free-guests.md): the config's free age and the ONE wording.
describe('parseConfig: free_up_to_age (D-147)', () => {
  const base = { timezone: 'Asia/Manila' };
  it('absent is null; a whole number from 0 to 17 is kept; anything else is refused', () => {
    expect(parseConfig(base, 't').freeUpToAge).toBeNull();
    expect(parseConfig({ ...base, free_up_to_age: 3 }, 't').freeUpToAge).toBe(3);
    expect(parseConfig({ ...base, free_up_to_age: 0 }, 't').freeUpToAge).toBe(0);
    expect(parseConfig({ ...base, free_up_to_age: 17 }, 't').freeUpToAge).toBe(17);
    for (const bad of [18, -1, 2.5, '3', true]) {
      expect(() => parseConfig({ ...base, free_up_to_age: bad }, 't')).toThrow(/free_up_to_age/);
    }
  });
});

describe('freeGuestsWords / partyWords (D-147)', () => {
  it('says the rule once, in one way', () => {
    expect(freeGuestsWords(null)).toBeNull();
    expect(freeGuestsWords(3)).toBe('Children aged 3 and below stay free.');
    expect(freeGuestsWords(0)).toBe('Infants under 1 stay free.');
  });
  it('prints the party the same everywhere', () => {
    expect(partyWords(4, 0)).toBe('4 guests');
    expect(partyWords(1, 0)).toBe('1 guest');
    expect(partyWords(4, 1)).toBe('4 guests + 1 child (free)');
    expect(partyWords(2, 2)).toBe('2 guests + 2 children (free)');
  });
});
