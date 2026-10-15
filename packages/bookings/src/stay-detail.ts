// stay-detail.ts — one stay, everything staff need to decide it (D-114).
//
// The Bookings list and the Payments queue are lists; every action happens
// on a stay's own page, /t/<slug>/admin/bookings/<reference>, which reads
// this. ONE read, on the staff token, for: the nights with their STORED
// prices (never re-priced), the guest, the deadlines, stay_payment(), the
// proofs and refunds, the change requests, the history, the staff notes
// (D-132), and whether a pending stay can be confirmed at all (a night taken
// by another stay, or on a closed date).
//
// It decides nothing. The page offers an action only when it applies, and
// the routes (and Postgres behind them) refuse it anyway when it does not.
//
// Every query filters on tenant_id (CLAUDE.md rule 6); a reference that is
// not this tenant's is null, the same answer as one that does not exist.

import { MAX_STAY_NIGHTS } from './constants.js';
import { listSlots, requireConfig, walkInGroups } from './bookings.js';
import { listChanges, type ChangeRow } from './changes.js';
import { closedDays } from './closed.js';
import { expireDueStays } from './deadlines.js';
import type { StayPayment } from './guest.js';
import { listPayments, stayHistory, stayPayment, type PaymentRow, type StayEvent } from './payment-review.js';
import { clashes, parseSpan, takingRows } from './requests.js';
import { listStayNotes, type StayNote } from './stay-notes.js';
import { roomCounts } from './unit-rooms.js';
import type { BookingStatus, BookingTenant, RequestLine } from './types.js';
import { addDays, localDate } from './validate.js';

export interface StayDetail {
  groupId: string;
  reference: string;
  /** the stay's status: its live rows' (a reschedule leaves cancelled old rows beside confirmed new ones) */
  status: BookingStatus;
  source: 'staff' | 'web';
  walkIn: boolean;
  guestName: string;
  guestPhone: string | null;
  guestEmail: string | null;
  notes: string | null;
  decisionNote: string | null;
  createdAt: string;
  slot: string;
  checkIn: string;
  nights: number;
  /** the morning after the last night, YYYY-MM-DD */
  checkOut: string;
  /** the first night's start and the last night's end, instants (the slot's times, from `during`) */
  startsAt: string | null;
  endsAt: string | null;
  /** cancelled before it was ever confirmed: staff and the guest read "Declined" (D-110) */
  declined: boolean;
  /** when the stay reached its present status, from the event log; null before the log began */
  statusAt: string | null;
  units: { unitId: number; unit: string; guests: number | null }[];
  /** the stored rows, night by night: the price breakdown as it was saved */
  lines: RequestLine[];
  /** centavos, the sum of the stored prices; null when a row has none */
  total: number | null;
  promoName: string | null;
  /** manage booking: the deadlines and the hold, as stored */
  payBy: string | null;
  reviewBy: string | null;
  heldUntil: string | null;
  payment: StayPayment;
  payments: PaymentRow[];
  changes: ChangeRow[];
  history: StayEvent[];
  /** staff notes, oldest first (D-132): many per stay, never the guest's */
  staffNotes: StayNote[];
  /** pending only: a night is taken by another stay (confirmed, or held for another guest) */
  clash: boolean;
  /** pending only: a night is on a closed date */
  closed: boolean;
  currency: string;
  timezone: string;
  /** the tenant's today, so the page can tell a running or finished stay apart */
  today: string;
}

/** The stay's own rows by status: the live ones first (confirmed, then pending), else the last word. */
const RANK: BookingStatus[] = ['confirmed', 'pending', 'expired', 'cancelled'];

/**
 * One stay by its reference, or null (not this tenant's, or not there). Staff
 * only: guest data. `userId` is the member asking, so its own notes say so.
 */
export async function stayDetail(tenant: BookingTenant, reference: string, userId: string | null): Promise<StayDetail | null> {
  const ref = reference.trim().toUpperCase();
  if (!/^[A-Z0-9-]{3,20}$/.test(ref)) return null;
  const config = await requireConfig(tenant);
  await expireDueStays(tenant);

  const { data: stay, error: stayError } = await tenant.db
    .from('stays')
    .select('group_id, reference, pay_by, review_by')
    .eq('tenant_id', tenant.id)
    .eq('reference', ref)
    .maybeSingle();
  if (stayError) throw new Error(`Could not load the stay: ${stayError.message}`);
  if (!stay) return null;
  const groupId = stay.group_id;

  const { data: all, error } = await tenant.db
    .from('bookings')
    .select('id, unit_id, room_id, slot_id, booked_date, during, held, held_until, status, source, guest_name, guest_phone, guest_email, guest_count, notes, decision_note, promo_id, discount, price, base_price, extra_guest_price, surcharge, created_at')
    .eq('tenant_id', tenant.id)
    .eq('group_id', groupId)
    .order('booked_date')
    .order('id');
  if (error) throw new Error(`Could not load the stay's nights: ${error.message}`);
  if (all.length === 0) return null;
  const status = RANK.find((s) => all.some((b) => b.status === s)) ?? (all[0]!.status as BookingStatus);
  const rows = all.filter((b) => b.status === status);
  const first = rows[0]!;
  const dates = [...new Set(rows.map((r) => r.booked_date))];
  const lastNight = dates[dates.length - 1]!;

  const [units, slots, promo, walkIns, calendar, payment, payments, changes, history, staffNotes, closed, roomRows, rooms] = await Promise.all([
    tenant.db.from('units').select('id, name').eq('tenant_id', tenant.id),
    listSlots(tenant, { retired: true }),
    first.promo_id === null
      ? Promise.resolve(null)
      : tenant.db.from('promos').select('name').eq('tenant_id', tenant.id).eq('id', first.promo_id).maybeSingle().then((r) => r.data?.name ?? null),
    walkInGroups(tenant, [groupId]),
    tenant.db.from('rate_calendar').select('day, label').eq('tenant_id', tenant.id).gte('day', dates[0]!).lte('day', lastNight),
    stayPayment(tenant, groupId),
    listPayments(tenant, 'all', groupId),
    listChanges(tenant, 'all', groupId),
    stayHistory(tenant, groupId),
    listStayNotes(tenant, groupId, userId),
    status === 'pending' ? closedDays(tenant, dates[0]!, lastNight) : Promise.resolve(new Map<string, string>()),
    tenant.db.from('unit_rooms').select('id, name').eq('tenant_id', tenant.id).in('id', [...new Set(rows.map((r) => r.room_id))]),
    roomCounts(tenant),
  ]);
  if (roomRows.error) throw new Error(`Could not load the rooms: ${roomRows.error.message}`);
  const roomName = new Map(roomRows.data.map((r) => [r.id, r.name]));
  if (units.error) throw new Error(`Could not load units: ${units.error.message}`);
  const unitName = new Map(units.data.map((u) => [u.id, u.name]));
  const holiday = new Map((calendar.data ?? []).map((c) => [c.day, c.label]));

  // A pending stay's clash, the Requests list's own test (requests.ts): the
  // rows that take a night now, from other stays on the same units, over the
  // window a stay overlapping this one can start in.
  let clash = false;
  if (status === 'pending') {
    const { data: near, error: nearError } = await tenant.db
      .from('bookings')
      .select('group_id, unit_id, room_id, during, status, held, held_until')
      .eq('tenant_id', tenant.id)
      .in(
        'unit_id',
        [...new Set(rows.map((r) => r.unit_id))],
      )
      .gte('booked_date', addDays(dates[0]!, -MAX_STAY_NIGHTS))
      .lte('booked_date', lastNight);
    if (nearError) throw new Error(`Could not check the nights: ${nearError.message}`);
    clash = clashes(rows.map((r) => ({ ...r, group_id: groupId })), groupId, takingRows(near, Date.now()), rooms);
  }

  const unitIds = [...new Set(rows.map((r) => r.unit_id))];
  const firstSpan = parseSpan(rows[0]!.during);
  const lastSpan = parseSpan(rows[rows.length - 1]!.during);
  const lastStatus = [...history].reverse().find((e) => e.kind === 'status' && e.to === status);
  const heldUntil = rows.find((r) => r.held && r.held_until)?.held_until ?? null;
  return {
    groupId,
    reference: stay.reference,
    status,
    source: first.source as 'staff' | 'web',
    walkIn: walkIns.has(groupId),
    guestName: first.guest_name,
    guestPhone: first.guest_phone,
    guestEmail: first.guest_email,
    notes: first.notes,
    decisionNote: first.decision_note,
    createdAt: all[0]!.created_at,
    slot: slots.find((s) => s.id === first.slot_id)?.name ?? '(unknown slot)',
    checkIn: dates[0]!,
    nights: dates.length,
    checkOut: addDays(lastNight, 1),
    startsAt: firstSpan ? new Date(firstSpan[0]).toISOString() : null,
    endsAt: lastSpan ? new Date(lastSpan[1]).toISOString() : null,
    declined: status === 'cancelled' && !history.some((e) => e.kind === 'status' && e.to === 'confirmed'),
    statusAt: lastStatus?.at ?? null,
    units: unitIds.map((unitId) => ({ unitId, unit: unitName.get(unitId) ?? '(unknown unit)', guests: rows.find((r) => r.unit_id === unitId)?.guest_count ?? null })),
    lines: rows.map((r) => ({
      date: r.booked_date,
      unitId: r.unit_id,
      unit: unitName.get(r.unit_id) ?? '(unknown unit)',
      bookingId: r.id,
      roomId: r.room_id,
      room: roomName.get(r.room_id) ?? null,
      guests: r.guest_count ?? 0,
      basePrice: r.base_price ?? r.price ?? 0,
      extraGuestPrice: r.extra_guest_price ?? 0,
      surcharge: r.surcharge ?? 0,
      discount: r.discount ?? 0,
      price: r.price ?? 0,
      holiday: holiday.get(r.booked_date) ?? null,
    })),
    total: rows.every((r) => r.price !== null) ? rows.reduce((sum, r) => sum + (r.price ?? 0), 0) : null,
    promoName: promo,
    payBy: stay.pay_by,
    reviewBy: stay.review_by,
    heldUntil,
    payment,
    payments,
    changes,
    history,
    staffNotes,
    clash,
    closed: status === 'pending' && dates.some((d) => closed.has(d)),
    currency: config.currency,
    timezone: config.timezone,
    today: localDate(config.timezone),
  };
}
