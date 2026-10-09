// guest.ts's pure part (plan/manage-booking.md Phase 2): the JSON guest_stay()
// returns, typed, and the status word a guest reads. The function itself is
// verify 125–132's.

import { describe, expect, it } from 'vitest';
import { guestStatus, parseGuestStay } from './guest.js';

const raw = {
  reference: 'HAR-7KQ4MX',
  status: 'pending',
  source: 'web',
  guest_name: 'Maria Santos',
  check_in: '2026-11-12',
  starts_at: '2026-11-12T06:00:00+00:00',
  ends_at: '2026-11-14T02:00:00+00:00',
  ended: false,
  nights: 2,
  created_at: '2026-10-10T03:00:00+00:00',
  rooms: [{ unit: 'Garden Room', slot: 'Overnight', guests: 2 }],
  price: { base: 400000, extra_guests: 0, surcharge: 50000, discount: 0, total: 450000 },
  timezone: 'Asia/Manila',
  currency: 'PHP',
};

describe('parseGuestStay', () => {
  it('types what guest_stay() returns', () => {
    const stay = parseGuestStay(raw)!;
    expect(stay.reference).toBe('HAR-7KQ4MX');
    expect(stay.guestName).toBe('Maria Santos');
    expect(stay.rooms).toEqual([{ unit: 'Garden Room', slot: 'Overnight', guests: 2 }]);
    expect(stay.price).toEqual({ base: 400000, extraGuests: 0, surcharge: 50000, discount: 0, total: 450000 });
  });

  it('is null for a miss, whatever the reason (the function returns null)', () => {
    expect(parseGuestStay(null)).toBeNull();
  });

  it('keeps an unpriced old row as null amounts, not 0', () => {
    const stay = parseGuestStay({ ...raw, price: { base: null, extra_guests: null, surcharge: null, discount: null, total: null } })!;
    expect(stay.price.total).toBeNull();
  });

  it('fails loudly on a shape the function never returns', () => {
    expect(() => parseGuestStay({ ...raw, status: 'held' })).toThrow(/unknown status/);
    expect(() => parseGuestStay({ ...raw, nights: '2' })).toThrow(/nights/);
    expect(() => parseGuestStay({ ...raw, rooms: [{ unit: 'A' }] })).toThrow(/rooms\[0\]\.slot/);
    expect(() => parseGuestStay([raw])).toThrow(/not an object/);
  });
});

describe('guestStatus', () => {
  it('says completed for a confirmed stay that has ended, and nothing else', () => {
    expect(guestStatus({ status: 'confirmed', ended: true })).toBe('completed');
    expect(guestStatus({ status: 'confirmed', ended: false })).toBe('confirmed');
    expect(guestStatus({ status: 'pending', ended: true })).toBe('pending');
    expect(guestStatus({ status: 'cancelled', ended: true })).toBe('cancelled');
  });
});
