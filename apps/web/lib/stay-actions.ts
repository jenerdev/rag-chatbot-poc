// What a stay's detail page offers (D-114): ONE place that says which
// action applies to a stay right now, for this member. Pure and tested
// (stay-actions.test.ts). A courtesy, never the guard: the routes and
// Postgres refuse an action that does not apply, whatever the page showed.
//
//   confirm     pending, and no night taken by another stay or closed
//   decline     pending
//   cancel      confirmed and not over (check-out after today)
//   review      a proof waiting (one per submitted payment)
//   decide      a change request waiting (approve / reject)
//   refund      money received that is no longer owed: the stay ended
//               without happening (cancelled, expired), or more came in than
//               the stay costs
//
// Each needs its permission (lib/permissions.ts): bookings:write for the
// stay's own decisions, payments:write for proofs, changes and refunds.

import type { StayDetail } from '@rag/bookings';
import { can, type Role } from './permissions';

export interface StayActions {
  confirm: boolean;
  decline: boolean;
  cancel: boolean;
  /** the ids of the proofs this member may review now */
  review: number[];
  /** the ids of the change requests this member may decide now */
  decide: number[];
  refund: boolean;
  /** why Confirm is not offered on a pending stay, in words; null when it is (or the stay is not pending) */
  confirmBlocked: string | null;
  /** a pending, tracked stay with nothing verified: Confirm will ask for a note */
  confirmNeedsNote: boolean;
}

type ActionInput = Pick<StayDetail, 'status' | 'checkOut' | 'today' | 'clash' | 'closed' | 'payment' | 'payments' | 'changes'>;

export function stayActions(stay: ActionInput, role: Role | null): StayActions {
  const stayWrite = role !== null && can(role, 'bookings:write');
  const payWrite = role !== null && can(role, 'payments:write');
  const pending = stay.status === 'pending';
  const confirmBlocked = !pending
    ? null
    : stay.closed
      ? 'A night of this stay is on a closed date. Decline it, or reopen the date on the Holidays screen.'
      : stay.clash
        ? 'A night of this stay is already taken by another booking, so it cannot be confirmed. Decline it, or cancel the other booking first.'
        : null;
  const over = stay.status === 'cancelled' || stay.status === 'expired';
  const overpaid = stay.payment.price !== null && stay.payment.received > stay.payment.price;
  return {
    confirm: stayWrite && pending && confirmBlocked === null,
    decline: stayWrite && pending,
    cancel: stayWrite && stay.status === 'confirmed' && stay.checkOut > stay.today,
    review: payWrite ? stay.payments.filter((p) => p.kind === 'payment' && p.status === 'submitted').map((p) => p.id) : [],
    decide: payWrite ? stay.changes.filter((c) => c.status === 'pending').map((c) => c.id) : [],
    refund: payWrite && stay.payment.received > 0 && (over || overpaid),
    confirmBlocked,
    confirmNeedsNote: pending && stay.payment.required !== null && !stay.payment.enough,
  };
}
