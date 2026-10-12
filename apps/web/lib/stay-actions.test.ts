import { describe, expect, it } from 'vitest';
import { stayActions } from './stay-actions';

const money = (over = {}) => ({ status: 'unpaid' as const, price: 100000, required: 100000, received: 0, outstanding: 100000, enough: false, open: false, ...over });
const proof = (id: number, status: 'submitted' | 'verified' | 'rejected', kind: 'payment' | 'refund' = 'payment') => ({ id, status, kind }) as never;
const change = (id: number, status: 'pending' | 'approved' | 'rejected' | 'withdrawn') => ({ id, status }) as never;
const base = {
  status: 'pending' as const,
  checkOut: '2026-10-20',
  today: '2026-10-12',
  clash: false,
  closed: false,
  payment: money(),
  payments: [] as never[],
  changes: [] as never[],
};

describe('stayActions', () => {
  it('pending: Confirm and Decline, nothing else; a tracked unpaid stay will ask for a note', () => {
    const a = stayActions(base, 'staff');
    expect([a.confirm, a.decline, a.cancel, a.refund]).toEqual([true, true, false, false]);
    expect(a.confirmNeedsNote).toBe(true);
    expect(stayActions({ ...base, payment: money({ enough: true, received: 100000 }) }, 'staff').confirmNeedsNote).toBe(false);
  });

  it('pending with a clash or a closed night: no Confirm, says why, still Decline', () => {
    for (const blocked of [{ clash: true }, { closed: true }]) {
      const a = stayActions({ ...base, ...blocked }, 'admin');
      expect(a.confirm).toBe(false);
      expect(a.decline).toBe(true);
      expect(a.confirmBlocked).toMatch(blocked.closed ? /closed date/ : /already taken/);
    }
  });

  it('confirmed: Cancel until check-out, then nothing', () => {
    expect(stayActions({ ...base, status: 'confirmed' }, 'staff')).toMatchObject({ confirm: false, decline: false, cancel: true, confirmBlocked: null });
    expect(stayActions({ ...base, status: 'confirmed', checkOut: '2026-10-12' }, 'staff').cancel).toBe(false);
  });

  it('cancelled or expired with money received: Refund (payments:write only)', () => {
    const paid = money({ received: 50000 });
    expect(stayActions({ ...base, status: 'cancelled', payment: paid }, 'admin').refund).toBe(true);
    expect(stayActions({ ...base, status: 'expired', payment: paid }, 'owner').refund).toBe(true);
    expect(stayActions({ ...base, status: 'cancelled', payment: paid }, 'staff').refund).toBe(false);
    expect(stayActions({ ...base, status: 'cancelled' }, 'admin').refund).toBe(false);
    // A live stay owes its money; only an overpayment is refundable.
    expect(stayActions({ ...base, status: 'confirmed', payment: money({ received: 100000 }) }, 'admin').refund).toBe(false);
    expect(stayActions({ ...base, status: 'confirmed', payment: money({ received: 120000 }) }, 'admin').refund).toBe(true);
  });

  it('a proof waiting and a change request waiting, for owners and admins only', () => {
    const stay = { ...base, payments: [proof(1, 'submitted'), proof(2, 'verified'), proof(3, 'submitted', 'refund')], changes: [change(7, 'pending'), change(8, 'rejected')] };
    expect(stayActions(stay, 'admin')).toMatchObject({ review: [1], decide: [7] });
    expect(stayActions(stay, 'staff')).toMatchObject({ review: [], decide: [] });
  });

  it('no role: no action at all', () => {
    const a = stayActions({ ...base, payments: [proof(1, 'submitted')] }, null);
    expect([a.confirm, a.decline, a.cancel, a.refund, a.review.length, a.decide.length]).toEqual([false, false, false, false, 0, 0]);
  });
});
