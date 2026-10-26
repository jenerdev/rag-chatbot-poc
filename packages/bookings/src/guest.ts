// guest.ts — the guest's own stay, for the Manage booking page (plan/manage-booking.md).
//
// ONE read, on a CHAT token: guest_stay(), security definer, takes the
// reference and the email or phone the guest typed and returns this stay's
// guest-facing columns, or null (plan Rule 4). This file only calls it and
// gives the JSON a type. It never reads `bookings` itself: a chat token has
// no read policy there, and the column list that may leave the database is
// the function's, not ours.
//
// A miss is null, whatever the reason (no such reference, the wrong contact,
// a stay with no contact on file, a reference locked after 5 misses), and
// the route turns every null into the same 404 sentence. Telling the reasons
// apart would tell a stranger which references exist.

import { BookingInputError } from './errors.js';
import type { BookingStatus, BookingTenant } from './types.js';

/** What the guest may see of their stay. Money in centavos, as everywhere. */
export interface GuestStay {
  reference: string;
  status: BookingStatus;
  /** 'web' from the booking page, 'staff' typed in by the resort */
  source: 'web' | 'staff';
  guestName: string;
  /** the first night's date, YYYY-MM-DD, in the tenant's day */
  checkIn: string;
  startsAt: string;
  endsAt: string;
  /** the last night has ended (now(), in SQL): a confirmed stay is then "completed" (plan § 2.6) */
  ended: boolean;
  nights: number;
  createdAt: string;
  /** `free` (D-147): the children who stay free, counted apart from `guests` */
  rooms: { unit: string; slot: string; guests: number; free: number }[];
  /** sums of the stored rows; null for rows priced before prices were stored */
  price: { base: number | null; extraGuests: number | null; surcharge: number | null; discount: number | null; total: number | null };
  timezone: string;
  currency: string;
  /** Phase 5: pay by then, or the stay expires; null = no deadline */
  payBy: string | null;
  /** Phase 5: staff decide the proof by then */
  reviewBy: string | null;
  /** Phase 5: the dates are held for this guest until then; null = not held */
  heldUntil: string | null;
  /** stay_payment(): DERIVED from the payments rows, never stored (plan Rule 3) */
  payment: StayPayment;
  /** every proof sent and every refund recorded, oldest first; never the file's path or who reviewed it */
  payments: GuestPayment[];
  /** how to pay, from the tenant's settings; null when the tenant takes no payment on the page */
  pay: { methods: PayMethod[]; terms: string | null } | null;
  /** Phase 6: what a change would mean today (change_terms()) */
  change: ChangeTerms;
  /** Phase 6: every change request, oldest first */
  changes: GuestChange[];
  /** schema-stay-outcome.sql: why a cancelled or expired stay ended (the staff's note, or "Not paid in time"); null while live */
  decisionNote: string | null;
  /** cancelled before it was ever confirmed: the guest reads "Declined" */
  declined: boolean;
  /** a pending stay whose dates another stay has taken since, in words; it takes no payment. Null otherwise */
  taken: string | null;
}

export interface ChangeTerms {
  daysBefore: number | null;
  refundPercent: number;
  /** what the policy would refund TODAY, of what was received; staff pay and record it */
  refundDue: number;
  canCancel: boolean;
  canReschedule: boolean;
  rescheduleUntilDaysBefore: number | null;
}

export interface GuestChange {
  kind: 'cancel' | 'reschedule';
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  newCheckIn: string | null;
  quotedDifference: number | null;
  refundDue: number | null;
  /** only on a rejection: the reason the guest reads */
  decisionNote: string | null;
  createdAt: string;
}

export type PaymentStatus = 'not_tracked' | 'unpaid' | 'submitted' | 'rejected' | 'partially_paid' | 'paid' | 'refunded';

export interface StayPayment {
  status: PaymentStatus;
  /** the live rows' stored prices, summed in SQL */
  price: number | null;
  /** what must be verified before the stay may be confirmed; null = not tracked */
  required: number | null;
  /** verified payments minus verified refunds */
  received: number;
  outstanding: number | null;
  /** received >= required */
  enough: boolean;
  /** a proof is being checked: no second one until it is decided */
  open: boolean;
}

export interface GuestPayment {
  kind: 'payment' | 'refund';
  method: string;
  claimedAmount: number;
  verifiedAmount: number | null;
  paidOn: string;
  status: 'submitted' | 'verified' | 'rejected';
  rejectionReason: string | null;
  createdAt: string;
}

export interface PayMethod {
  kind: 'gcash' | 'bank' | 'other';
  label: string;
  accountName: string | null;
  accountNumber: string | null;
  instructions: string | null;
}

/** The word a guest reads: `completed` is derived, never stored (plan § 2.6). */
export type GuestStatus = BookingStatus | 'completed';

export function guestStatus(stay: Pick<GuestStay, 'status' | 'ended'>): GuestStatus {
  return stay.status === 'confirmed' && stay.ended ? 'completed' : stay.status;
}

/** Longest reference and contact accepted before the database is asked. */
export const MAX_GUEST_REFERENCE = 20;
export const MAX_GUEST_CONTACT = 254;

const STATUSES: readonly BookingStatus[] = ['pending', 'confirmed', 'cancelled', 'expired'];

const PAYMENT_STATUSES: readonly PaymentStatus[] = ['not_tracked', 'unpaid', 'submitted', 'rejected', 'partially_paid', 'paid', 'refunded'];

const optionalText = (v: unknown, name: string): string | null => (v === null || v === undefined ? null : text(v, name));

const text = (v: unknown, name: string): string => {
  if (typeof v !== 'string') throw new Error(`guest_stay: ${name} is not text`);
  return v;
};
const count = (v: unknown, name: string): number => {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`guest_stay: ${name} is not a whole number`);
  return v;
};
const amount = (v: unknown, name: string): number | null => (v === null || v === undefined ? null : count(v, name));

/**
 * guest_stay()'s JSON → a GuestStay, or null for a miss. Anything else the
 * function never returns is an Error (a 500), not a guess: a renamed column
 * must fail here, loudly, not show the guest "undefined".
 */
export function parseGuestStay(raw: unknown): GuestStay | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('guest_stay: not an object');
  const r = raw as Record<string, unknown>;
  const status = text(r.status, 'status') as BookingStatus;
  if (!STATUSES.includes(status)) throw new Error(`guest_stay: unknown status "${status}"`);
  const source = text(r.source, 'source');
  if (source !== 'web' && source !== 'staff') throw new Error(`guest_stay: unknown source "${source}"`);
  if (typeof r.ended !== 'boolean') throw new Error('guest_stay: ended is not a boolean');
  const price = (r.price ?? {}) as Record<string, unknown>;
  const rooms = Array.isArray(r.rooms) ? r.rooms : [];
  return {
    reference: text(r.reference, 'reference'),
    status,
    source,
    guestName: text(r.guest_name, 'guest_name'),
    checkIn: text(r.check_in, 'check_in'),
    startsAt: text(r.starts_at, 'starts_at'),
    endsAt: text(r.ends_at, 'ends_at'),
    ended: r.ended,
    nights: count(r.nights, 'nights'),
    createdAt: text(r.created_at, 'created_at'),
    rooms: rooms.map((room, i) => {
      const x = room as Record<string, unknown>;
      return {
        unit: text(x.unit, `rooms[${i}].unit`),
        slot: text(x.slot, `rooms[${i}].slot`),
        guests: count(x.guests, `rooms[${i}].guests`),
        free: x.free === undefined || x.free === null ? 0 : count(x.free, `rooms[${i}].free`),
      };
    }),
    price: {
      base: amount(price.base, 'price.base'),
      extraGuests: amount(price.extra_guests, 'price.extra_guests'),
      surcharge: amount(price.surcharge, 'price.surcharge'),
      discount: amount(price.discount, 'price.discount'),
      total: amount(price.total, 'price.total'),
    },
    timezone: text(r.timezone, 'timezone'),
    currency: text(r.currency, 'currency'),
    payBy: optionalText(r.pay_by, 'pay_by'),
    reviewBy: optionalText(r.review_by, 'review_by'),
    heldUntil: optionalText(r.held_until, 'held_until'),
    // Absent before schema-stay-outcome.sql has run: read as "nothing to say".
    decisionNote: optionalText(r.decision_note, 'decision_note'),
    declined: r.declined === true,
    taken: optionalText(r.taken, 'taken'),
    payment: parsePayment(r.payment),
    payments: (Array.isArray(r.payments) ? r.payments : []).map((p, i) => {
      const x = p as Record<string, unknown>;
      const kind = text(x.kind, `payments[${i}].kind`);
      const status = text(x.status, `payments[${i}].status`);
      if (kind !== 'payment' && kind !== 'refund') throw new Error(`guest_stay: unknown payment kind "${kind}"`);
      if (status !== 'submitted' && status !== 'verified' && status !== 'rejected') throw new Error(`guest_stay: unknown payment status "${status}"`);
      return {
        kind,
        method: text(x.method, `payments[${i}].method`),
        claimedAmount: count(x.claimed_amount, `payments[${i}].claimed_amount`),
        verifiedAmount: amount(x.verified_amount, `payments[${i}].verified_amount`),
        paidOn: text(x.paid_on, `payments[${i}].paid_on`),
        status,
        rejectionReason: optionalText(x.rejection_reason, `payments[${i}].rejection_reason`),
        createdAt: text(x.created_at, `payments[${i}].created_at`),
      };
    }),
    pay: parsePay(r.pay),
    change: parseTerms(r.change),
    changes: (Array.isArray(r.changes) ? r.changes : []).map((c, i) => {
      const x = c as Record<string, unknown>;
      return {
        kind: text(x.kind, `changes[${i}].kind`) as GuestChange['kind'],
        status: text(x.status, `changes[${i}].status`) as GuestChange['status'],
        newCheckIn: optionalText(x.new_check_in, `changes[${i}].new_check_in`),
        quotedDifference: amount(x.quoted_difference, `changes[${i}].quoted_difference`),
        refundDue: amount(x.refund_due, `changes[${i}].refund_due`),
        decisionNote: optionalText(x.decision_note, `changes[${i}].decision_note`),
        createdAt: text(x.created_at, `changes[${i}].created_at`),
      };
    }),
  };
}

function parseTerms(raw: unknown): ChangeTerms {
  const t = (raw ?? {}) as Record<string, unknown>;
  return {
    daysBefore: amount(t.days_before, 'change.days_before'),
    refundPercent: (amount(t.refund_percent, 'change.refund_percent') ?? 0),
    refundDue: (amount(t.refund_due, 'change.refund_due') ?? 0),
    canCancel: t.can_cancel === true,
    canReschedule: t.can_reschedule === true,
    rescheduleUntilDaysBefore: amount(t.reschedule_until_days_before, 'change.reschedule_until_days_before'),
  };
}

function parsePayment(raw: unknown): StayPayment {
  if (typeof raw !== 'object' || raw === null) throw new Error('guest_stay: payment is not an object');
  const p = raw as Record<string, unknown>;
  const status = text(p.status, 'payment.status') as PaymentStatus;
  if (!PAYMENT_STATUSES.includes(status)) throw new Error(`guest_stay: unknown payment status "${status}"`);
  if (typeof p.enough !== 'boolean' || typeof p.open !== 'boolean') throw new Error('guest_stay: payment.enough / open are not booleans');
  return {
    status,
    price: amount(p.price, 'payment.price'),
    required: amount(p.required, 'payment.required'),
    received: count(p.received, 'payment.received'),
    outstanding: amount(p.outstanding, 'payment.outstanding'),
    enough: p.enough,
    open: p.open,
  };
}

function parsePay(raw: unknown): GuestStay['pay'] {
  if (raw === null || raw === undefined) return null;
  const p = raw as Record<string, unknown>;
  const methods = Array.isArray(p.methods) ? p.methods : [];
  return {
    methods: methods.map((m, i) => {
      const x = m as Record<string, unknown>;
      const kind = text(x.kind, `pay.methods[${i}].kind`);
      if (kind !== 'gcash' && kind !== 'bank' && kind !== 'other') throw new Error(`guest_stay: unknown method kind "${kind}"`);
      return {
        kind,
        label: text(x.label, `pay.methods[${i}].label`),
        accountName: optionalText(x.account_name, `pay.methods[${i}].account_name`),
        accountNumber: optionalText(x.account_number, `pay.methods[${i}].account_number`),
        instructions: optionalText(x.instructions, `pay.methods[${i}].instructions`),
      };
    }),
    terms: optionalText(p.terms, 'pay.terms'),
  };
}

/**
 * The guest's stay, or null. Blank or oversized input is a 400 in words
 * before the database is asked; everything else is guest_stay()'s to decide,
 * including the normalising (case, spaces, +63) and the lockout.
 */
export async function guestStay(tenant: BookingTenant, reference: string, contact: string): Promise<GuestStay | null> {
  const ref = reference.trim();
  const who = contact.trim();
  if (!ref) throw new BookingInputError('Enter your booking reference.');
  if (!who) throw new BookingInputError('Enter the email address or mobile number you booked with.');
  if (ref.length > MAX_GUEST_REFERENCE || who.length > MAX_GUEST_CONTACT) {
    throw new BookingInputError('That reference or contact is too long.');
  }
  const { data, error } = await tenant.db.rpc('guest_stay', { p_tenant_id: tenant.id, p_reference: ref, p_contact: who });
  if (error) throw new Error(`Could not look up the booking: ${error.message}`);
  return parseGuestStay(data);
}
