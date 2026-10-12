// payment-review.ts — the staff side of payments (plan/manage-booking.md Phase 4, S-14).
//
// On a STAFF token; every caller has passed requireAdmin() for the
// permission the route names. Reads go through RLS (any member reads
// payments, stays and the event log); every write is one SQL function that
// asks the role again (D-079), because no token has a write policy on
// payments or on the bookings config:
//   review_payment()        verify (with the amount FOUND and "I checked the
//                           account") or reject (with the reason the guest
//                           reads); verify-and-confirm in one transaction
//   record_refund()         a refund made elsewhere, recorded
//   set_payment_settings()  the `payments` key of the config, and nothing else
//
// No money is added up here (CLAUDE.md, Money): each stay's figures are
// stay_payment()'s, called once per stay on the list.

import { expireDueStays } from './deadlines.js';
import { BookingConflictError, BookingInputError } from './errors.js';
import type { PaymentStatus, StayPayment } from './guest.js';
import { PROOF_BUCKET } from './payments.js';
import type { Json } from '@rag/db';
import type { BookingTenant } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How long a signed proof URL lives: long enough to look, short enough not to share. */
export const PROOF_URL_SECONDS = 300;
/** The queue's page: the open proofs are few; "all" shows the latest this many. */
export const MAX_PAYMENT_ROWS = 200;

export interface PaymentRow {
  id: number;
  groupId: string;
  reference: string;
  guestName: string;
  checkIn: string | null;
  kind: 'payment' | 'refund';
  method: string;
  payerReference: string | null;
  claimedAmount: number;
  paidOn: string;
  status: 'submitted' | 'verified' | 'rejected';
  verifiedAmount: number | null;
  rejectionReason: string | null;
  note: string | null;
  hasProof: boolean;
  createdAt: string;
  reviewedAt: string | null;
  /** the stay as it stands now: its status and stay_payment() */
  stayStatus: string | null;
  payment: StayPayment;
}

export interface StayEvent {
  at: string;
  actor: 'guest' | 'staff' | 'system';
  /** the staff member's id, for "you" on the screen */
  actorUser: string | null;
  kind: 'created' | 'status' | 'payment' | 'change';
  from: string | null;
  to: string | null;
  amount: number | null;
  note: string | null;
}

export interface PaymentSettings {
  methods: { kind: 'gcash' | 'bank' | 'other'; label: string; accountName: string | null; accountNumber: string | null; instructions: string | null }[];
  fee: { kind: 'full' } | { kind: 'fixed' | 'percent'; value: number };
  payWithinHours: number | null;
  reviewWithinHours: number | null;
  terms: string | null;
  /** Phase 5 (§ 9 q1): when a stay holds its dates; absent = none */
  hold: 'none' | 'on_proof' | 'on_request';
  /** Phase 6: refund tiers by days before check-in; [] = no refund */
  cancellation: { daysBefore: number; refundPercent: number }[];
  /** Phase 6: date changes close this many days before check-in; null = none taken on the page */
  rescheduleUntilDaysBefore: number | null;
}

/** A write's refusal, in the function's own words. */
function writeError(error: { code?: string; message: string }, what: string): Error {
  if (error.code === '22023' || error.code === '23514') return new BookingInputError(error.message);
  if (error.code === '55000') return new BookingConflictError(error.message);
  if (error.code === '23P01') {
    return new BookingConflictError('A night of this booking was confirmed for another booking meanwhile. Nothing was changed: verify without confirming, then decide the clash.');
  }
  if (error.code === '42501') return Object.assign(new Error(error.message), { status: 403 });
  return new Error(`Could not ${what}: ${error.message}`);
}

/**
 * The queue: `open` (proofs waiting, oldest first) or everything recent
 * (newest first). Each row carries its stay's reference, guest and money.
 */
export async function listPayments(tenant: BookingTenant, which: 'open' | 'all', groupId?: string): Promise<PaymentRow[]> {
  await expireDueStays(tenant);
  let query = tenant.db
    .from('payments')
    .select('id, group_id, kind, method, payer_reference, claimed_amount, paid_on, proof_path, status, verified_amount, rejection_reason, note, created_at, reviewed_at')
    .eq('tenant_id', tenant.id)
    .order('created_at', { ascending: which === 'open' })
    .limit(MAX_PAYMENT_ROWS);
  if (which === 'open') query = query.eq('status', 'submitted').eq('kind', 'payment');
  // One stay's payments, for its detail page (D-114).
  if (groupId !== undefined) query = query.eq('group_id', groupId);
  const { data: rows, error } = await query;
  if (error) throw new Error(`Could not load payments: ${error.message}`);
  if (rows.length === 0) return [];

  const groups = [...new Set(rows.map((r) => r.group_id))];
  const [stays, bookings, money] = await Promise.all([
    tenant.db.from('stays').select('group_id, reference').eq('tenant_id', tenant.id).in('group_id', groups),
    tenant.db.from('bookings').select('group_id, guest_name, booked_date, status').eq('tenant_id', tenant.id).in('group_id', groups),
    Promise.all(groups.map(async (g) => [g, await stayPayment(tenant, g)] as const)),
  ]);
  if (stays.error) throw new Error(`Could not load stays: ${stays.error.message}`);
  if (bookings.error) throw new Error(`Could not load bookings: ${bookings.error.message}`);
  const reference = new Map(stays.data.map((s) => [s.group_id, s.reference]));
  const moneyOf = new Map(money);
  const RANK = ['confirmed', 'pending', 'expired', 'cancelled'];
  const stayOf = (g: string) => {
    const mine = bookings.data.filter((b) => b.group_id === g);
    const status = [...mine].sort((a, b) => RANK.indexOf(a.status) - RANK.indexOf(b.status))[0]?.status ?? null;
    const dates = mine.filter((b) => b.status === status).map((b) => b.booked_date).sort();
    return { guestName: mine[0]?.guest_name ?? '', checkIn: dates[0] ?? null, status };
  };

  return rows.map((r) => {
    const stay = stayOf(r.group_id);
    return {
      id: r.id,
      groupId: r.group_id,
      reference: reference.get(r.group_id) ?? '',
      guestName: stay.guestName,
      checkIn: stay.checkIn,
      kind: r.kind,
      method: r.method,
      payerReference: r.payer_reference,
      claimedAmount: r.claimed_amount,
      paidOn: r.paid_on,
      status: r.status,
      verifiedAmount: r.verified_amount,
      rejectionReason: r.rejection_reason,
      note: r.note,
      hasProof: r.proof_path !== null,
      createdAt: r.created_at,
      reviewedAt: r.reviewed_at,
      stayStatus: stay.status,
      payment: moneyOf.get(r.group_id)!,
    };
  });
}

/** stay_payment() for one stay, on the staff token (RLS: any member). */
export async function stayPayment(tenant: BookingTenant, groupId: string): Promise<StayPayment> {
  const { data, error } = await tenant.db.rpc('stay_payment', { p_tenant_id: tenant.id, p_group_id: groupId });
  if (error) throw new Error(`Could not load the payment: ${error.message}`);
  const p = data as Record<string, unknown>;
  return {
    status: p.status as PaymentStatus,
    price: (p.price as number | null) ?? null,
    required: (p.required as number | null) ?? null,
    received: p.received as number,
    outstanding: (p.outstanding as number | null) ?? null,
    enough: p.enough as boolean,
    open: p.open as boolean,
  };
}

/** A 5-minute signed URL for one proof, or null when it is not this tenant's (or has no file). */
export async function proofUrl(tenant: BookingTenant, paymentId: number): Promise<string | null> {
  const { data, error } = await tenant.db.from('payments').select('proof_path').eq('tenant_id', tenant.id).eq('id', paymentId).maybeSingle();
  if (error) throw new Error(`Could not load the payment: ${error.message}`);
  if (!data?.proof_path) return null;
  const signed = await tenant.db.storage.from(PROOF_BUCKET).createSignedUrl(data.proof_path, PROOF_URL_SECONDS);
  if (signed.error) throw new Error(`Could not open the proof: ${signed.error.message}`);
  return signed.data.signedUrl;
}

export interface Review {
  action: 'verify' | 'reject';
  /** verify: the amount found in the account, centavos */
  amount: number | null;
  accountChecked: boolean;
  /** reject: the reason the guest reads; verify: an optional note */
  note: string | null;
  /** verify: also confirm the stay when the verified amount is enough */
  confirm: boolean;
}

/** Verify or reject a proof. null = not this tenant's payment (one answer for "not yours" and "not there"). */
export async function reviewPayment(tenant: BookingTenant, paymentId: number, review: Review): Promise<{ payment: StayPayment; confirmed: boolean } | null> {
  const { data, error } = await tenant.db.rpc('review_payment', {
    p_tenant_id: tenant.id,
    p_payment_id: paymentId,
    p_action: review.action,
    p_amount: review.amount,
    p_account_checked: review.accountChecked,
    p_note: review.note,
    p_confirm: review.confirm,
  });
  if (error?.code === 'P0002') return null;
  if (error) throw writeError(error, 'review the payment');
  const result = data as unknown as { payment: StayPayment; confirmed: boolean };
  console.log(`[bookings] ${tenant.slug} payment ${paymentId} → ${review.action}${result.confirmed ? ' + confirmed' : ''}`);
  return result;
}

/** Record a refund made elsewhere. null = not this tenant's stay. */
export async function recordRefund(tenant: BookingTenant, groupId: string, amount: number, method: string, note: string): Promise<{ paymentId: number } | null> {
  if (!UUID.test(groupId)) throw new BookingInputError('That is not a booking id.');
  const { data, error } = await tenant.db.rpc('record_refund', { p_tenant_id: tenant.id, p_group_id: groupId, p_amount: amount, p_method: method, p_note: note });
  if (error?.code === 'P0002') return null;
  if (error) throw writeError(error, 'record the refund');
  return { paymentId: data as number };
}

/** A stay's history, oldest first: every creation, status change and payment, with who. */
export async function stayHistory(tenant: BookingTenant, groupId: string): Promise<StayEvent[]> {
  if (!UUID.test(groupId)) throw new BookingInputError('That is not a booking id.');
  const { data, error } = await tenant.db
    .from('booking_events')
    .select('at, actor_kind, actor_user, kind, from_value, to_value, amount, note')
    .eq('tenant_id', tenant.id)
    .eq('group_id', groupId)
    .order('at')
    .order('id');
  if (error) throw new Error(`Could not load the history: ${error.message}`);
  return data.map((e) => ({ at: e.at, actor: e.actor_kind, actorUser: e.actor_user, kind: e.kind, from: e.from_value, to: e.to_value, amount: e.amount, note: e.note }));
}

/** The tenant's payment settings, or null when it takes no payment on the page. */
export async function paymentSettings(tenant: BookingTenant): Promise<PaymentSettings | null> {
  const { data, error } = await tenant.db.from('tenant_applications').select('config').eq('tenant_id', tenant.id).eq('application_key', 'bookings').maybeSingle();
  if (error) throw new Error(`Could not load the payment settings: ${error.message}`);
  return fromConfig((data?.config as Record<string, unknown> | undefined)?.payments);
}

/** Save the settings (null turns payments off). The validator in SQL decides; its words come back as a 400. */
export async function setPaymentSettings(tenant: BookingTenant, settings: PaymentSettings | null): Promise<PaymentSettings | null> {
  const { data, error } = await tenant.db.rpc('set_payment_settings', { p_tenant_id: tenant.id, p_payments: settings === null ? null : (toConfig(settings) as Json) });
  if (error) throw writeError(error, 'save the payment settings');
  console.log(`[bookings] ${tenant.slug} payment settings ${settings === null ? 'removed' : 'saved'}`);
  return fromConfig(data);
}

/** The JSON the validator knows (snake_case), from the screen's shape. Empty optional fields are left out. */
export function toConfig(s: PaymentSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {
    methods: s.methods.map((m) => ({
      kind: m.kind,
      label: m.label.trim(),
      ...(m.accountName?.trim() ? { account_name: m.accountName.trim() } : {}),
      ...(m.accountNumber?.trim() ? { account_number: m.accountNumber.trim() } : {}),
      ...(m.instructions?.trim() ? { instructions: m.instructions.trim() } : {}),
    })),
    fee: s.fee,
  };
  if (s.payWithinHours !== null) out.pay_within_hours = s.payWithinHours;
  if (s.reviewWithinHours !== null) out.review_within_hours = s.reviewWithinHours;
  if (s.terms?.trim()) out.terms = s.terms.trim();
  if (s.hold !== 'none') out.hold = s.hold;
  if (s.cancellation.length > 0) out.cancellation = s.cancellation.map((t) => ({ days_before: t.daysBefore, refund_percent: t.refundPercent }));
  if (s.rescheduleUntilDaysBefore !== null) out.reschedule_until_days_before = s.rescheduleUntilDaysBefore;
  return out;
}

/** The screen's shape from the stored JSON; null for none. */
export function fromConfig(raw: unknown): PaymentSettings | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  const fee = (p.fee ?? { kind: 'full' }) as PaymentSettings['fee'];
  return {
    methods: (Array.isArray(p.methods) ? p.methods : []).map((m) => {
      const x = m as Record<string, unknown>;
      return {
        kind: (x.kind as PaymentSettings['methods'][number]['kind']) ?? 'other',
        label: str(x.label) ?? '',
        accountName: str(x.account_name),
        accountNumber: str(x.account_number),
        instructions: str(x.instructions),
      };
    }),
    fee,
    payWithinHours: num(p.pay_within_hours),
    reviewWithinHours: num(p.review_within_hours),
    terms: str(p.terms),
    hold: p.hold === 'on_proof' || p.hold === 'on_request' ? p.hold : 'none',
    cancellation: (Array.isArray(p.cancellation) ? p.cancellation : []).map((t) => {
      const x = t as Record<string, unknown>;
      return { daysBefore: num(x.days_before) ?? 0, refundPercent: num(x.refund_percent) ?? 0 };
    }),
    rescheduleUntilDaysBefore: num(p.reschedule_until_days_before),
  };
}
