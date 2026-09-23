// bookings.ts — availability and bookings, for ONE tenant per call.
//
// Every query below filters on tenant_id, and the one .rpc() sends p_tenant_id
// (CLAUDE.md rule 6). The composite foreign keys stop a cross-tenant WRITE;
// only these filters stop a cross-tenant READ.
//
// What this module does NOT decide: whether two bookings overlap. That is the
// bookings_no_overlap exclusion constraint, and check_availability applies the
// same test (schema-bookings.sql § 5, § 7). There is deliberately no
// "is it free?" read before an insert here. That pattern double-books when two
// requests race (plan/bookings.md § 2.2). The insert is attempted, and
// Postgres says no.

import { supabase } from '@rag/db';
import {
  MAX_AVAILABILITY_DAYS,
  MAX_GUEST_NAME,
  MAX_GUEST_PHONE,
  MAX_LIST_DAYS,
  MAX_NOTES,
} from './constants.js';
import { BookingConflictError, BookingInputError, BookingsNotEnabledError } from './errors.js';
import type {
  BookingStatus,
  BookingSummary,
  BookingTenant,
  BookingsConfig,
  NewBooking,
  SlotAvailability,
  SlotSummary,
  UnitSummary,
} from './types.js';
import { isIsoDate, localDate, optionalText, requireText, validateRange } from './validate.js';

/**
 * This tenant's bookings configuration, or null if the application is off.
 *
 * Having a row means the application is enabled (D-033). The timezone is
 * required by a trigger in SQL, so a row without one cannot exist. It is
 * checked again here anyway, because a null timezone would silently become
 * "today in UTC" below.
 */
export async function bookingsConfig(tenant: BookingTenant): Promise<BookingsConfig | null> {
  const { data, error } = await supabase
    .from('tenant_applications')
    .select('config')
    .eq('tenant_id', tenant.id)
    .eq('application_key', 'bookings')
    .maybeSingle();
  if (error) throw new Error(`Could not load the bookings configuration: ${error.message}`);
  if (!data) return null;

  const timezone = (data.config as { timezone?: unknown } | null)?.timezone;
  if (typeof timezone !== 'string') {
    throw new Error(`The bookings configuration for "${tenant.slug}" has no timezone`);
  }
  return { timezone };
}

/** The config, or a 404-shaped error. Every public function below starts here. */
async function requireConfig(tenant: BookingTenant): Promise<BookingsConfig> {
  const config = await bookingsConfig(tenant);
  if (!config) throw new BookingsNotEnabledError(tenant.slug);
  return config;
}

/**
 * Open or taken, for every (date, unit, slot) from `from` to `to`.
 *
 * `to` is optional: one date is the common question ("is the 12th free?").
 * Past dates are refused, measured against the TENANT'S today (§ 2.3).
 *
 * Returns SlotAvailability, which has no guest data, and the SQL function it
 * calls never selects any. This is the only function the chatbot's tool
 * executor calls (plan/bookings.md Rule 3).
 */
export async function checkAvailability(
  tenant: BookingTenant,
  range: { from: unknown; to?: unknown },
): Promise<SlotAvailability[]> {
  const { timezone } = await requireConfig(tenant);
  const { from, to } = validateRange(range, {
    today: localDate(timezone),
    maxDays: MAX_AVAILABILITY_DAYS,
    allowPast: false,
  });

  const { data, error } = await supabase.rpc('check_availability', {
    p_tenant_id: tenant.id,
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error(`Could not check availability: ${error.message}`);

  const open = data.filter((r) => r.status === 'open').length;
  console.log(`[bookings] ${tenant.slug} availability ${from}..${to}: ${open} open of ${data.length}`);

  // Mapped field by field, not spread. Spreading a row is how a column added
  // to the SQL function later would reach the prompt without anyone deciding
  // that it should.
  return data.map((r) => ({ date: r.booked_date, unit: r.unit, slot: r.slot, status: r.status }));
}

/** This tenant's units, by name. */
export async function listUnits(tenant: BookingTenant): Promise<UnitSummary[]> {
  await requireConfig(tenant);
  const { data, error } = await supabase
    .from('units')
    .select('id, name')
    .eq('tenant_id', tenant.id)
    .order('name');
  if (error) throw new Error(`Could not load units: ${error.message}`);
  return data;
}

/** This tenant's slots, in the order they start in a day. */
export async function listSlots(tenant: BookingTenant): Promise<SlotSummary[]> {
  await requireConfig(tenant);
  const { data, error } = await supabase
    .from('slots')
    .select('id, name, start_time, duration')
    .eq('tenant_id', tenant.id)
    .order('start_time')
    .order('name');
  if (error) throw new Error(`Could not load slots: ${error.message}`);
  return data.map((s) => ({
    id: s.id,
    name: s.name,
    startTime: s.start_time.slice(0, 5),
    duration: s.duration,
  }));
}

/**
 * Every booking from `from` to `to`, cancelled ones included, with guest data.
 *
 * ADMIN ONLY. Its callers must have passed requireAdmin(). The chatbot never
 * calls it, and must not: BookingSummary is exactly the data Rule 3 keeps out
 * of prompts.
 *
 * Past dates are allowed, because this is how staff look back at who came.
 */
export async function listBookings(
  tenant: BookingTenant,
  range: { from: unknown; to?: unknown },
): Promise<BookingSummary[]> {
  const { timezone } = await requireConfig(tenant);
  const { from, to } = validateRange(range, {
    today: localDate(timezone),
    maxDays: MAX_LIST_DAYS,
    allowPast: true,
  });

  const { data, error } = await supabase
    .from('bookings')
    .select('id, unit_id, slot_id, booked_date, status, guest_name, guest_phone, guest_count, notes, created_at')
    .eq('tenant_id', tenant.id)
    .gte('booked_date', from)
    .lte('booked_date', to)
    .order('booked_date')
    .order('id');
  if (error) throw new Error(`Could not load bookings: ${error.message}`);

  // Names are joined here rather than embedded in the select. Both lookups
  // are tenant-scoped, so a unit name can only come from this tenant.
  const [units, slots] = await Promise.all([listUnits(tenant), listSlots(tenant)]);
  const unitName = new Map(units.map((u) => [u.id, u.name]));
  const slotName = new Map(slots.map((s) => [s.id, s.name]));

  return data.map((b) => ({
    id: b.id,
    date: b.booked_date,
    unitId: b.unit_id,
    unit: unitName.get(b.unit_id) ?? '(unknown unit)',
    slotId: b.slot_id,
    slot: slotName.get(b.slot_id) ?? '(unknown slot)',
    status: b.status,
    guestName: b.guest_name,
    guestPhone: b.guest_phone,
    guestCount: b.guest_count,
    notes: b.notes,
    createdAt: b.created_at,
  }));
}

/**
 * Book a slot.
 *
 * No availability check first (see the top of this file). The insert either
 * lands or Postgres refuses it:
 *
 *   23P01  the span overlaps a live booking  → BookingConflictError (409)
 *   23503  the unit or slot is not this tenant's, or does not exist
 *                                             → BookingInputError (400)
 *
 * For 23503 the message is the same whether the id belongs to another tenant
 * or to nobody. "Not yours" and "not there" must be indistinguishable, or unit
 * ids could be enumerated across tenants.
 *
 * `during` is not sent. The bookings_compute_during trigger computes it, and it
 * would overwrite anything that was sent.
 */
export async function createBooking(tenant: BookingTenant, input: NewBooking): Promise<BookingSummary> {
  const { timezone } = await requireConfig(tenant);

  const unitId = positiveInt(input.unitId, 'Unit');
  const slotId = positiveInt(input.slotId, 'Slot');
  if (!isIsoDate(input.date)) throw new BookingInputError(`"${String(input.date)}" is not a date. Use YYYY-MM-DD.`);
  const date = input.date;
  const today = localDate(timezone);
  if (date < today) throw new BookingInputError(`${date} is in the past. Today is ${today}.`);

  const guestName = requireText(input.guestName, 'Guest name', MAX_GUEST_NAME);
  const guestPhone = optionalText(input.guestPhone, 'Guest phone', MAX_GUEST_PHONE);
  const notes = optionalText(input.notes, 'Notes', MAX_NOTES);
  const guestCount =
    input.guestCount === undefined || input.guestCount === null || input.guestCount === ''
      ? null
      : positiveInt(input.guestCount, 'Guest count');
  const status = input.status === undefined ? 'confirmed' : bookableStatus(input.status);

  const { data, error } = await supabase
    .from('bookings')
    .insert({
      tenant_id: tenant.id,
      unit_id: unitId,
      slot_id: slotId,
      booked_date: date,
      status,
      guest_name: guestName,
      guest_phone: guestPhone,
      guest_count: guestCount,
      notes,
    })
    .select('id')
    .single();

  if (error?.code === '23P01') {
    throw new BookingConflictError(`That slot on ${date} overlaps an existing booking.`);
  }
  if (error?.code === '23503') {
    throw new BookingInputError('No such unit or slot.');
  }
  if (error) throw new Error(`Could not save the booking: ${error.message}`);

  console.log(`[bookings] ${tenant.slug} booked #${data.id}: ${date}, unit ${unitId}, slot ${slotId}, ${status}`);
  const [created] = (await listBookings(tenant, { from: date })).filter((b) => b.id === data.id);
  if (!created) throw new Error(`Booking #${data.id} was saved but could not be read back`);
  return created;
}

/**
 * Cancel a booking. Never deletes it: the history of who booked is the
 * tenant's record, and a cancelled row frees its span anyway (the exclusion
 * constraint ignores 'cancelled').
 *
 * `false` means "not yours OR not there". Deliberately indistinguishable
 * (plan.md Phase 3, step 6). Cancelling an already-cancelled booking is `true`:
 * the outcome the caller asked for is true.
 */
export async function cancelBooking(tenant: BookingTenant, id: unknown): Promise<boolean> {
  await requireConfig(tenant);
  const bookingId = positiveInt(id, 'Booking id');

  const { data, error } = await supabase
    .from('bookings')
    .update({ status: 'cancelled' })
    .eq('tenant_id', tenant.id)
    .eq('id', bookingId)
    .select('id');
  if (error) throw new Error(`Could not cancel the booking: ${error.message}`);

  if (data.length > 0) console.log(`[bookings] ${tenant.slug} cancelled #${bookingId}`);
  return data.length > 0;
}

function positiveInt(value: unknown, label: string): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
    throw new BookingInputError(`${label} must be a positive whole number.`);
  }
  return n;
}

/** 'cancelled' is not a status you create a booking in. */
function bookableStatus(value: unknown): Exclude<BookingStatus, 'cancelled'> {
  if (value === 'pending' || value === 'confirmed') return value;
  throw new BookingInputError('Status must be "pending" or "confirmed".');
}
