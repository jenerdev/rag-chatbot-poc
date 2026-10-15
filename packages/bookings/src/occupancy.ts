// occupancy.ts — the staff calendar's reads (plan/calendar.md, D-103).
//
// Not calendar.ts: that file is the HOLIDAY calendar, the rate_calendar rows
// staff type in. This one reads what the dates ARE: per (date, room, slot),
// and per date, from sql/schema-calendar.sql.
//
// No arithmetic here (plan Rule 1). Whether a date is full, partly booked,
// available, closed or has nothing to sell is decided by calendar_days() in
// Postgres; "taken" is check_availability()'s own answer, which the SQL calls;
// a pending stay is counted once, by group. This file validates the range,
// calls, and maps each row field by field.
//
// STAFF ONLY. The functions refuse a chat token themselves (42501), and the
// route asks requireAdmin(…, 'bookings:read') first. calendarDayBookings()
// carries the guest, as the staff list does (listBookings, the same rows);
// nothing here carries a price.

import { MAX_CALENDAR_DAYS } from './constants.js';
import { listBookings, requireConfig } from './bookings.js';
import type { BookingTenant, DaySlotBooking, OccupancyDay, OccupancySlot } from './types.js';
import { localDate, positiveInt, validateRange } from './validate.js';

interface Range {
  from: unknown;
  to?: unknown;
}

/** A room filter, as listBookings() takes it: another tenant's id matches nothing, the same as an empty room. */
function unitFilter(unitId: unknown): number | null {
  return unitId === undefined || unitId === null || unitId === '' ? null : positiveInt(unitId, 'Room');
}

async function checked(tenant: BookingTenant, range: Range): Promise<{ from: string; to: string; today: string }> {
  const { timezone } = await requireConfig(tenant);
  const today = localDate(timezone);
  // Past dates are allowed: the calendar is history as well as plans (§ 7 q2).
  const { from, to } = validateRange(range, { today, maxDays: MAX_CALENDAR_DAYS, allowPast: true });
  return { from, to, today };
}

/** One row per date from `from` to `to`, every date present, with its state, counts and rate kind. */
export async function calendarDays(
  tenant: BookingTenant,
  range: Range,
  filter: { unitId?: unknown } = {},
): Promise<{ from: string; to: string; today: string; days: OccupancyDay[] }> {
  const { from, to, today } = await checked(tenant, range);
  const unitId = unitFilter(filter.unitId);
  const { data, error } = await tenant.db.rpc('calendar_days', { p_tenant_id: tenant.id, p_from: from, p_to: to, p_unit_id: unitId });
  if (error) throw new Error(`Could not read the calendar: ${error.message}`);
  const days: OccupancyDay[] = data.map((r) => ({
    day: r.day,
    state: r.state,
    taken: r.taken,
    sellable: r.sellable,
    pending: r.pending,
    rateKind: r.rate_kind,
    label: r.label,
    bookable: r.bookable,
  }));
  const by = (state: OccupancyDay['state']) => days.filter((d) => d.state === state).length;
  console.log(
    `[bookings] ${tenant.slug} calendar ${from}..${to}${unitId ? ` room ${unitId}` : ''}: ` +
      `${by('available')} available, ${by('partial')} partly, ${by('full')} full, ${by('closed')} closed, ${by('none')} none`,
  );
  return { from, to, today, days };
}

/** One row per (date, active room, active slot): closed, taken or open, and its pending stays. */
export async function calendarSlots(tenant: BookingTenant, range: Range, filter: { unitId?: unknown } = {}): Promise<OccupancySlot[]> {
  const { from, to } = await checked(tenant, range);
  const { data, error } = await tenant.db.rpc('calendar_slots', { p_tenant_id: tenant.id, p_from: from, p_to: to, p_unit_id: unitFilter(filter.unitId) });
  if (error) throw new Error(`Could not read the calendar's slots: ${error.message}`);
  return data.map((r) => ({
    day: r.day,
    unitId: r.unit_id,
    unit: r.unit,
    slotId: r.slot_id,
    slot: r.slot,
    state: r.state,
    pending: r.pending,
    roomsTaken: r.rooms_taken,
    roomsTotal: r.rooms_total,
  }));
}

/**
 * The Day view's bookings: every pending or confirmed booking that overlaps
 * each (room, slot) on `date`, with its guest. calendar_bookings() decides
 * the overlap (the test that makes the slot taken or pending); the details
 * are listBookings()'s, read from the earliest such booking's date, so a stay
 * that began the night before is in it. Mapped field by field, no price.
 */
export async function calendarDayBookings(tenant: BookingTenant, date: unknown, filter: { unitId?: unknown } = {}): Promise<DaySlotBooking[]> {
  const { from: day } = await checked(tenant, { from: date });
  const unitId = unitFilter(filter.unitId);
  const { data, error } = await tenant.db.rpc('calendar_bookings', { p_tenant_id: tenant.id, p_day: day, p_unit_id: unitId });
  if (error) throw new Error(`Could not read the day's bookings: ${error.message}`);
  if (data.length === 0) return [];

  const earliest = data.reduce((min, r) => (r.booked_date < min ? r.booked_date : min), day);
  const rows = await listBookings(tenant, { from: earliest, to: day }, { unitId: unitId ?? undefined });
  const byId = new Map(rows.map((b) => [b.id, b]));
  const out: DaySlotBooking[] = [];
  for (const r of data) {
    const b = byId.get(r.booking_id);
    if (!b || (b.status !== 'pending' && b.status !== 'confirmed')) continue;
    out.push({
      unitId: r.unit_id,
      slotId: r.slot_id,
      booking: {
        id: b.id,
        date: b.date,
        slot: b.slot,
        status: b.status,
        clash: b.clash,
        guestName: b.guestName,
        guestPhone: b.guestPhone,
        guestEmail: b.guestEmail,
        guestCount: b.guestCount,
        notes: b.notes,
        reference: b.reference,
        source: b.source,
      },
    });
  }
  return out;
}
