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
  payment: { status: 'unpaid', price: 450000, required: 135000, received: 0, outstanding: 450000, enough: false, open: false },
  pay_by: '2026-10-11T03:00:00+00:00',
  review_by: null,
  held_until: null,
  payments: [],
  pay: {
    methods: [{ kind: 'gcash', label: 'GCash', account_name: 'Harbor Inn', account_number: '0917 000 0000' }],
    terms: null,
  },
};

describe('parseGuestStay', () => {
  it('types what guest_stay() returns', () => {
    const stay = parseGuestStay(raw)!;
    expect(stay.reference).toBe('HAR-7KQ4MX');
    expect(stay.guestName).toBe('Maria Santos');
    expect(stay.rooms).toEqual([{ unit: 'Garden Room', slot: 'Overnight', guests: 2 }]);
    expect(stay.price).toEqual({ base: 400000, extraGuests: 0, surcharge: 50000, discount: 0, total: 450000 });
    expect(stay.payBy).toBe('2026-10-11T03:00:00+00:00');
    expect(stay.heldUntil).toBeNull();
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

describe('parseGuestStay: the payment (Phase 3)', () => {
  it('types the derived payment, the history and how to pay', () => {
    const stay = parseGuestStay({
      ...raw,
      payment: { ...raw.payment, status: 'rejected' },
      payments: [
        { kind: 'payment', method: 'GCash', claimed_amount: 135000, verified_amount: null, paid_on: '2026-10-10', status: 'rejected', rejection_reason: 'Blurry', created_at: '2026-10-10T05:00:00+00:00' },
      ],
    })!;
    expect(stay.payment).toEqual({ status: 'rejected', price: 450000, required: 135000, received: 0, outstanding: 450000, enough: false, open: false });
    expect(stay.payments[0]).toMatchObject({ claimedAmount: 135000, verifiedAmount: null, rejectionReason: 'Blurry' });
    expect(stay.pay?.methods[0]).toEqual({ kind: 'gcash', label: 'GCash', accountName: 'Harbor Inn', accountNumber: '0917 000 0000', instructions: null });
  });

  it('is null pay for a tenant that takes no payment, and not_tracked is a status', () => {
    const stay = parseGuestStay({ ...raw, pay: null, payment: { ...raw.payment, status: 'not_tracked', required: null } })!;
    expect(stay.pay).toBeNull();
    expect(stay.payment.required).toBeNull();
  });

  it('fails loudly on a payment status the function never returns', () => {
    expect(() => parseGuestStay({ ...raw, payment: { ...raw.payment, status: 'held' } })).toThrow(/unknown payment status/);
    expect(() => parseGuestStay({ ...raw, payment: undefined })).toThrow(/payment is not an object/);
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
