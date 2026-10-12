// A stay's payment and history in words: shared by the Payments queue
// (S-14) and a booking's detail page (D-114), so both say the same thing.
// Pure: every amount is formatted, never computed.

import type { StayEvent } from '@rag/bookings';
import { formatMoney } from '@/lib/money';

export const STAY_PAYMENT: Record<string, string> = {
  not_tracked: 'Not tracked',
  unpaid: 'Unpaid',
  submitted: 'Proof to check',
  rejected: 'Proof rejected',
  partially_paid: 'Partly paid',
  paid: 'Paid',
  refunded: 'Refunded',
};

/**
 * A pending stay's status, named by what it waits for (stay_payment()): the
 * guest's payment, staff checking a proof, or staff confirming a paid stay.
 * A stay whose payment is not tracked is plain Pending. Shared by the list
 * (S-3) and the stay's page (S-15), so both say the same word.
 */
export function pendingState(payment: { status: string; enough: boolean } | null): { label: string; tone: string } {
  if (!payment || payment.status === 'not_tracked') return { label: 'Pending', tone: 'warn' };
  if (payment.status === 'submitted') return { label: 'Proof to check', tone: 'warn' };
  if (payment.enough) return { label: 'Paid, to confirm', tone: 'ok' };
  return { label: 'Awaiting payment', tone: 'warn' };
}

export function when(iso: string, timezone: string): string {
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: timezone });
}

/** A status change as a person says it: a pending stay cancelled was DECLINED (D-110). */
export function statusWords(from: string | null, to: string | null): string {
  if (to === 'confirmed') return 'Confirmed';
  if (to === 'cancelled') return from === 'pending' ? 'Declined' : 'Cancelled';
  if (to === 'expired') return 'Expired';
  if (to === 'pending') return 'Back to pending';
  return `${from ?? ''} → ${to ?? ''}`;
}

/** One event of a stay's history, in words. */
export function eventWords(e: StayEvent, currency: string): string {
  if (e.kind === 'created') return `Booked ${e.note === 'web' ? 'on the booking page' : 'by staff'}${e.to === 'confirmed' ? ', confirmed' : ''}`;
  if (e.kind === 'status') return `${statusWords(e.from, e.to)}${e.note ? `: “${e.note}”` : ''}`;
  if (e.kind === 'change') {
    const [kind, status] = (e.to ?? '').split(':');
    const what = kind === 'cancel' ? 'cancel' : `move${e.note && status === 'pending' ? ` to ${e.note}` : ''}`;
    return status === 'pending' ? `Asked to ${what}` : `Request to ${kind === 'cancel' ? 'cancel' : 'move'} ${status}${status !== 'pending' && e.note ? `: ${e.note}` : ''}`;
  }
  const amount = e.amount !== null ? ` ${formatMoney(e.amount, currency)}` : '';
  const [kind, status] = (e.to ?? '').split(':');
  if (kind === 'refund') return `Refund recorded${amount}`;
  if (status === 'submitted') return `Proof sent${amount}${e.note ? ` by ${e.note}` : ''}`;
  if (status === 'verified') return `Payment verified${amount}`;
  if (status === 'rejected') return `Proof rejected${e.note ? `: ${e.note}` : ''}`;
  return `${e.from ?? ''} → ${e.to ?? ''}`;
}
