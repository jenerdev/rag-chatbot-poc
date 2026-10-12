// changes.ts — cancel and reschedule requests (plan/manage-booking.md Phase 6, § 2.8).
//
// A guest ASKS, on the chat token, through two definer functions that match
// them like every guest door (guest_group()):
//   request_change()   a cancel or a reschedule; with `dryRun` it only
//                      quotes (the refund the policy gives today, or the new
//                      price and the difference), so the page shows it first
//   withdraw_change()  takes back the open request
// Staff DECIDE, on a staff token, through decide_change(), which asks the
// role itself (owners and admins: it moves money owed):
//   approve a cancel      the stay → cancelled; the refund due stays on the
//                         request for staff to pay and record
//   approve a reschedule  the old nights cancelled and the new ones inserted
//                         in the same group, one transaction; a night taken
//                         meanwhile is a 409 and nothing changes
//   reject                a reason the guest reads
// Every amount is the database's (unit_quote(), change_terms()).

import { BookingConflictError, BookingInputError } from './errors.js';
import { MAX_GUEST_CONTACT, MAX_GUEST_REFERENCE } from './guest.js';
import { expireDueStays } from './deadlines.js';
import type { BookingTenant } from './types.js';
import { isIsoDate } from './validate.js';

export interface ChangeQuote {
  kind: 'cancel' | 'reschedule';
  /** a stored request's id; absent on a dry run */
  id?: number;
  refundDue?: number;
  refundPercent?: number;
  newCheckIn?: string;
  quotedPrice?: number;
  quotedDifference?: number;
}

export interface ChangeInput {
  reference: string;
  contact: string;
  kind: 'cancel' | 'reschedule';
  newCheckIn: string | null;
  reason: string | null;
  dryRun: boolean;
}

function changeError(error: { code?: string; message: string }): Error | null {
  if (error.code === 'P0002') return null;
  if (error.code === '22023') return new BookingInputError(error.message);
  if (error.code === '55000') return new BookingConflictError(error.message);
  if (error.code === '23505') return new BookingConflictError('You already have a request waiting for this booking.');
  if (error.code === '23P01') return new BookingConflictError('A night of the new dates was taken meanwhile. Nothing was changed.');
  if (error.code === '42501') return Object.assign(new Error(error.message), { status: 403 });
  return new Error(`Could not handle the change: ${error.message}`);
}

/** The guest's request (or its quote). null = the reference and contact match no stay. */
export async function requestChange(tenant: BookingTenant, input: ChangeInput): Promise<ChangeQuote | null> {
  if (!input.reference.trim() || !input.contact.trim()) throw new BookingInputError('Look up your booking first.');
  if (input.reference.trim().length > MAX_GUEST_REFERENCE || input.contact.trim().length > MAX_GUEST_CONTACT) {
    throw new BookingInputError('That reference or contact is too long.');
  }
  if (input.kind === 'reschedule' && !isIsoDate(input.newCheckIn)) throw new BookingInputError('Choose the new check-in date.');
  const { data, error } = await tenant.db.rpc('request_change', {
    p_tenant_id: tenant.id,
    p_reference: input.reference.trim(),
    p_contact: input.contact.trim(),
    p_kind: input.kind,
    p_new_check_in: input.kind === 'reschedule' ? input.newCheckIn : null,
    p_reason: input.reason?.trim() || null,
    p_dry_run: input.dryRun,
  });
  if (error) {
    const mapped = changeError(error);
    if (mapped === null) return null;
    throw mapped;
  }
  const r = data as Record<string, unknown>;
  return {
    kind: r.kind as ChangeQuote['kind'],
    ...(typeof r.id === 'number' ? { id: r.id } : {}),
    ...(typeof r.refund_due === 'number' ? { refundDue: r.refund_due } : {}),
    ...(typeof r.refund_percent === 'number' ? { refundPercent: r.refund_percent } : {}),
    ...(typeof r.new_check_in === 'string' ? { newCheckIn: r.new_check_in } : {}),
    ...(typeof r.quoted_price === 'number' ? { quotedPrice: r.quoted_price } : {}),
    ...(typeof r.quoted_difference === 'number' ? { quotedDifference: r.quoted_difference } : {}),
  };
}

/** Withdraw the open request. null = a miss; false = nothing was open. */
export async function withdrawChange(tenant: BookingTenant, reference: string, contact: string): Promise<boolean | null> {
  const { data, error } = await tenant.db.rpc('withdraw_change', { p_tenant_id: tenant.id, p_reference: reference.trim(), p_contact: contact.trim() });
  if (error) {
    const mapped = changeError(error);
    if (mapped === null) return null;
    throw mapped;
  }
  return data as boolean;
}

export interface ChangeRow {
  id: number;
  groupId: string;
  reference: string;
  guestName: string;
  checkIn: string | null;
  kind: 'cancel' | 'reschedule';
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  newCheckIn: string | null;
  quotedPrice: number | null;
  quotedDifference: number | null;
  refundDue: number | null;
  guestReason: string | null;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
}

/** Staff: the open requests (oldest first), or the latest of all. */
export async function listChanges(tenant: BookingTenant, which: 'open' | 'all', groupId?: string): Promise<ChangeRow[]> {
  await expireDueStays(tenant);
  let query = tenant.db
    .from('change_requests')
    .select('id, group_id, kind, status, new_check_in, quoted_price, quoted_difference, refund_due, guest_reason, decision_note, created_at, decided_at')
    .eq('tenant_id', tenant.id)
    .order('created_at', { ascending: which === 'open' })
    .limit(200);
  if (which === 'open') query = query.eq('status', 'pending');
  // One stay's requests, for its detail page (D-114).
  if (groupId !== undefined) query = query.eq('group_id', groupId);
  const { data: rows, error } = await query;
  if (error) throw new Error(`Could not load change requests: ${error.message}`);
  if (rows.length === 0) return [];
  const groups = [...new Set(rows.map((r) => r.group_id))];
  const [stays, bookings] = await Promise.all([
    tenant.db.from('stays').select('group_id, reference').eq('tenant_id', tenant.id).in('group_id', groups),
    tenant.db.from('bookings').select('group_id, guest_name, booked_date, status').eq('tenant_id', tenant.id).in('group_id', groups),
  ]);
  if (stays.error || bookings.error) throw new Error(`Could not load the stays: ${(stays.error ?? bookings.error)!.message}`);
  const ref = new Map(stays.data.map((s) => [s.group_id, s.reference]));
  return rows.map((r) => {
    const mine = bookings.data.filter((b) => b.group_id === r.group_id);
    const live = mine.filter((b) => b.status === 'confirmed' || b.status === 'pending');
    return {
      id: r.id,
      groupId: r.group_id,
      reference: ref.get(r.group_id) ?? '',
      guestName: mine[0]?.guest_name ?? '',
      checkIn: (live.length ? live : mine).map((b) => b.booked_date).sort()[0] ?? null,
      kind: r.kind,
      status: r.status,
      newCheckIn: r.new_check_in,
      quotedPrice: r.quoted_price,
      quotedDifference: r.quoted_difference,
      refundDue: r.refund_due,
      guestReason: r.guest_reason,
      decisionNote: r.decision_note,
      createdAt: r.created_at,
      decidedAt: r.decided_at,
    };
  });
}

/** Staff: approve or reject. null = not this tenant's request. */
export async function decideChange(tenant: BookingTenant, id: number, action: 'approve' | 'reject', note: string | null): Promise<{ status: string } | null> {
  const { data, error } = await tenant.db.rpc('decide_change', { p_tenant_id: tenant.id, p_id: id, p_action: action, p_note: note });
  if (error) {
    const mapped = changeError(error);
    if (mapped === null) return null;
    throw mapped;
  }
  console.log(`[bookings] ${tenant.slug} change request ${id} → ${action}`);
  return data as unknown as { status: string };
}
