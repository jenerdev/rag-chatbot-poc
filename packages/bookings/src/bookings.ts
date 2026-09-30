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

import { randomUUID } from 'node:crypto';
import {
  MAX_AVAILABILITY_DAYS,
  MAX_AVAILABILITY_ROWS,
  MAX_GUEST_NAME,
  MAX_GUEST_PHONE,
  MAX_LIST_DAYS,
  MAX_NOTES,
  MAX_UNIT_NAME,
} from './constants.js';
import { closedDays, closedError, refuseClosedDays } from './closed.js';
import { BookingConflictError, BookingInputError, BookingsNotEnabledError, PerRoomOnlyError } from './errors.js';
import type {
  BookingGroup,
  BookingStatus,
  BookingSummary,
  BookingTenant,
  BookingsConfig,
  NewBooking,
  Quote,
  RateKind,
  RoomAvailability,
  SlotAvailability,
  SlotSummary,
  UnitSummary,
} from './types.js';
import {
  isIsoDate,
  localDate,
  optionalText,
  parseConfig,
  parseRooms,
  positiveInt,
  requireText,
  validateRange,
} from './validate.js';

/** A row's status, with a closed date (D-080) winning over whatever its bookings say. */
function statusOn(date: string, status: 'open' | 'taken', closed: Map<string, string>): 'open' | 'taken' | 'closed' {
  return closed.has(date) ? 'closed' : status;
}

/**
 * This tenant's bookings configuration, or null if the application is off.
 *
 * Having a row means the application is enabled (D-033). The timezone is
 * required by a trigger in SQL, so a row without one cannot exist. It is
 * checked again here anyway, because a null timezone would silently become
 * "today in UTC" below.
 */
export async function bookingsConfig(tenant: BookingTenant): Promise<BookingsConfig | null> {
  const { data, error } = await tenant.db
    .from('tenant_applications')
    .select('config')
    .eq('tenant_id', tenant.id)
    .eq('application_key', 'bookings')
    .maybeSingle();
  if (error) throw new Error(`Could not load the bookings configuration: ${error.message}`);
  if (!data) return null;
  // Defaults for booking_type, weekend_days and currency are applied in ONE
  // place, parseConfig (validate.ts): the same defaults SQL applies.
  return parseConfig(data.config, tenant.slug);
}

/** The config, or a 404-shaped error. Every public function below starts here. */
export async function requireConfig(tenant: BookingTenant): Promise<BookingsConfig> {
  const config = await bookingsConfig(tenant);
  if (!config) throw new BookingsNotEnabledError(tenant.slug);
  return config;
}

/**
 * The config of a per_room tenant, or a 404-shaped error. Rooms, rates,
 * photos and quotes do not exist for a whole-resort tenant, and saying so must
 * look like "no such route" (PerRoomOnlyError).
 */
export async function requirePerRoom(tenant: BookingTenant): Promise<BookingsConfig> {
  const config = await requireConfig(tenant);
  if (config.bookingType !== 'per_room') throw new PerRoomOnlyError(tenant.slug);
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

  const { data, error } = await tenant.db.rpc('check_availability', {
    p_tenant_id: tenant.id,
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error(`Could not check availability: ${error.message}`);
  // A closed date (D-080) is 'closed' whatever its bookings say. Only the
  // status changes: the label staff typed is not put into a prompt.
  const closed = await closedDays(tenant, from, to);

  const rows = data.map((r) => ({ date: r.booked_date, unit: r.unit, slot: r.slot, status: statusOn(r.booked_date, r.status, closed) }));
  const open = rows.filter((r) => r.status === 'open').length;
  console.log(`[bookings] ${tenant.slug} availability ${from}..${to}: ${open} open of ${rows.length}${closed.size ? `, ${closed.size} day(s) closed` : ''}`);

  // Mapped field by field, not spread. Spreading a row is how a column added
  // to the SQL function later would reach the prompt without anyone deciding
  // that it should.
  return rows;
}

/**
 * Room availability for a per_room tenant: priced, active rooms only, with
 * capacity and the base price for each date (plan/booking-types.md § 3 step 8).
 *
 * `slot`, `unit` and `guests` narrow the result, and the result is capped at
 * MAX_AVAILABILITY_ROWS: rooms × slots × days grows fast, and every row is
 * prompt text when the chatbot asks (§ 2.6). A range that would exceed it is
 * refused with a message that says how to narrow it, so the model can.
 *
 * Like checkAvailability, the result has no guest data, and the chatbot's
 * executor may call it. It is mapped field by field, never spread.
 */
export async function checkRoomAvailability(
  tenant: BookingTenant,
  query: { from: unknown; to?: unknown; slot?: unknown; unit?: unknown; guests?: unknown },
): Promise<RoomAvailability[]> {
  const { timezone } = await requirePerRoom(tenant);
  return pricedAvailability(tenant, timezone, query);
}

/**
 * The same rows for ANY tenant with the bookings application: a whole-resort
 * tenant whose unit has rates (villa, since D-074) gets its one unit priced
 * per slot and date; one with no rates gets `[]`. The chatbot's executor
 * calls this for whole_resort tenants; checkRoomAvailability keeps its
 * per_room-only contract (404 otherwise) for the routes and the tool's
 * room branch.
 */
export async function checkPricedAvailability(
  tenant: BookingTenant,
  query: { from: unknown; to?: unknown; slot?: unknown; unit?: unknown; guests?: unknown },
): Promise<RoomAvailability[]> {
  const { timezone } = await requireConfig(tenant);
  return pricedAvailability(tenant, timezone, query);
}

async function pricedAvailability(
  tenant: BookingTenant,
  timezone: string,
  query: { from: unknown; to?: unknown; slot?: unknown; unit?: unknown; guests?: unknown },
): Promise<RoomAvailability[]> {
  const { from, to } = validateRange(query, {
    today: localDate(timezone),
    maxDays: MAX_AVAILABILITY_DAYS,
    allowPast: false,
  });
  const blank = (v: unknown) => v === undefined || v === null || v === '';
  const slot = blank(query.slot) ? null : requireText(query.slot, 'Slot', MAX_UNIT_NAME);
  const unit = blank(query.unit) ? null : requireText(query.unit, 'Room', MAX_UNIT_NAME);
  const guests = blank(query.guests) ? null : positiveInt(query.guests, 'Guests');

  const { data, error } = await tenant.db.rpc('check_room_availability', {
    p_tenant_id: tenant.id,
    p_from: from,
    p_to: to,
    p_slot: slot,
    p_unit: unit,
    p_guests: guests,
  });
  if (error) throw new Error(`Could not check room availability: ${error.message}`);
  // Which rate each date's price is, from the SAME branch unit_price() took
  // (rate_kind(), D-082), never decided a second time here.
  const [closed, kinds] = await Promise.all([closedDays(tenant, from, to), rateKinds(tenant, from, to)]);

  const open = data.filter((r) => statusOn(r.booked_date, r.status, closed) === 'open').length;
  console.log(
    `[bookings] ${tenant.slug} rooms ${from}..${to}${slot ? ` ${slot}` : ''}${unit ? ` ${unit}` : ''}` +
      `${guests ? ` ${guests} guests` : ''}: ${open} open of ${data.length}${closed.size ? `, ${closed.size} day(s) closed` : ''}`,
  );
  if (data.length > MAX_AVAILABILITY_ROWS) {
    throw new BookingInputError(
      `That is ${data.length} results, more than ${MAX_AVAILABILITY_ROWS}. Ask for fewer dates, one slot, or one room.`,
    );
  }

  return data.map((r) => ({
    date: r.booked_date,
    unit: r.unit,
    capacity: r.capacity,
    standardCapacity: r.standard_capacity,
    extraPersonRate: r.extra_person_rate,
    slot: r.slot,
    status: statusOn(r.booked_date, r.status, closed),
    price: r.price,
    rateKind: kindOn(kinds, r.booked_date),
    extraGuestPrice: r.extra_guest_price,
    total: r.total,
  }));
}

/** rate_kinds() returns every date in the range, so a miss is a bug, not a weekday. */
function kindOn(kinds: Map<string, RateKind>, date: string): RateKind {
  const kind = kinds.get(date);
  if (!kind) throw new Error(`No rate kind for ${date}`);
  return kind;
}

/** Each date from `from` to `to` → its rate kind (schema-rate-kind.sql). */
async function rateKinds(tenant: BookingTenant, from: string, to: string): Promise<Map<string, RateKind>> {
  const { data, error } = await tenant.db.rpc('rate_kinds', { p_tenant_id: tenant.id, p_from: from, p_to: to });
  if (error) throw new Error(`Could not load the rate kinds: ${error.message}`);
  return new Map(data.map((d) => [d.day, d.kind]));
}

/**
 * The rooms a per_room tenant offers: active ones, with their capacity, in
 * the order staff set. What the chatbot's tool description names (a resort
 * publishes its rooms), so a chat token may read it. No description (tenant
 * free text is kept out of prompts) and no ids (plan/bookings.md Rule 2).
 */
export async function listRooms(tenant: BookingTenant): Promise<{ name: string; capacity: number | null }[]> {
  await requirePerRoom(tenant);
  const { data, error } = await tenant.db
    .from('units')
    .select('name, capacity')
    .eq('tenant_id', tenant.id)
    .eq('active', true)
    .order('sort_order')
    .order('name');
  if (error) throw new Error(`Could not load rooms: ${error.message}`);
  return data.map((u) => ({ name: u.name, capacity: u.capacity }));
}

/**
 * This tenant's units, by name, inactive ones included: a booking list still
 * names a room that was retired after it was booked. Forms offer only the
 * `active` ones.
 */
export async function listUnits(tenant: BookingTenant): Promise<UnitSummary[]> {
  await requireConfig(tenant);
  const { data, error } = await tenant.db
    .from('units')
    .select('id, name, active')
    .eq('tenant_id', tenant.id)
    .order('name');
  if (error) throw new Error(`Could not load units: ${error.message}`);
  return data.map((u) => ({ id: u.id, name: u.name, active: u.active }));
}

/** This tenant's slots, in the order they start in a day. */
export async function listSlots(tenant: BookingTenant): Promise<SlotSummary[]> {
  await requireConfig(tenant);
  const { data, error } = await tenant.db
    .from('slots')
    .select('id, name, start_time, duration, nightly')
    .eq('tenant_id', tenant.id)
    .order('start_time')
    .order('name');
  if (error) throw new Error(`Could not load slots: ${error.message}`);
  return data.map((s) => ({
    id: s.id,
    name: s.name,
    startTime: s.start_time.slice(0, 5),
    duration: s.duration,
    nightly: s.nightly,
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
  filter: { unitId?: unknown } = {},
): Promise<BookingSummary[]> {
  const { timezone } = await requireConfig(tenant);
  const { from, to } = validateRange(range, {
    today: localDate(timezone),
    maxDays: MAX_LIST_DAYS,
    allowPast: true,
  });
  // The per_room screen's room filter. Another tenant's unit id is not an
  // error: the tenant_id filter makes it match nothing, which is the same `[]`
  // as a room with no bookings.
  const unitId =
    filter.unitId === undefined || filter.unitId === null || filter.unitId === '' ? null : positiveInt(filter.unitId, 'Room');

  let query = tenant.db
    .from('bookings')
    .select(
      'id, unit_id, slot_id, booked_date, status, guest_name, guest_phone, guest_count, notes, price, base_price, extra_guest_price, surcharge, group_id, source, reference, guest_email, created_at',
    )
    .eq('tenant_id', tenant.id)
    .gte('booked_date', from)
    .lte('booked_date', to);
  if (unitId !== null) query = query.eq('unit_id', unitId);
  const { data, error } = await query.order('booked_date').order('id');
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
    price: b.price,
    basePrice: b.base_price,
    extraGuestPrice: b.extra_guest_price,
    surcharge: b.surcharge,
    groupId: b.group_id,
    source: b.source,
    reference: b.reference,
    guestEmail: b.guest_email,
    createdAt: b.created_at,
  }));
}

/**
 * Book a slot, for one unit or several rooms at once.
 *
 * No availability check first (see the top of this file). The insert either
 * lands or Postgres refuses it:
 *
 *   23P01  the span overlaps a live booking  → BookingConflictError (409)
 *   23503  the unit or slot is not this tenant's, does not exist, or the
 *          room is inactive                  → BookingInputError (400)
 *   23514  too many guests for a room, a per_room room with no rate, or a
 *          per_room booking with no guest count  → BookingInputError (400)
 *
 * The guest count is NOT pre-checked here, on purpose: the trigger checks the
 * unit first, so another tenant's room still gets "No such unit or slot.",
 * not a guest-count message that would tell the two apart.
 *
 * For 23503 the message is the same whether the id belongs to another tenant,
 * to nobody, or to a retired room. "Not yours" and "not there" must be
 * indistinguishable, or unit ids could be enumerated across tenants.
 *
 * SEVERAL ROOMS ARE ONE INSERT, so one statement: if any room clashes, none is
 * saved (plan/booking-types.md § 2.5, D-053). Every row carries EVERY key: in a
 * multi-row insert PostgREST sends a key missing from one row as NULL, not as
 * the column default (observed in Phase 1, 23502).
 *
 * Neither `during` nor `price` is sent. The bookings_compute_during trigger
 * computes both and would overwrite anything that was sent (plan Rule 2).
 */
export async function createBookings(tenant: BookingTenant, input: NewBooking): Promise<BookingGroup> {
  const { timezone, bookingType } = await requireConfig(tenant);

  const rooms = parseRooms(input);
  // A whole-resort tenant has one active unit, so "several" can only be a
  // mistake. Refused here, clearly, rather than by the trigger with "No such
  // unit or slot." for the second one.
  if (rooms.length > 1 && bookingType !== 'per_room') {
    throw new BookingInputError('This business is booked as a whole, one unit at a time.');
  }
  const slotId = positiveInt(input.slotId, 'Slot');
  if (!isIsoDate(input.date)) throw new BookingInputError(`"${String(input.date)}" is not a date. Use YYYY-MM-DD.`);
  const date = input.date;
  const today = localDate(timezone);
  if (date < today) throw new BookingInputError(`${date} is in the past. Today is ${today}.`);

  // Said before the insert, in words; the trigger refuses it anyway (D-080).
  await refuseClosedDays(tenant, [date]);

  const guestName = requireText(input.guestName, 'Guest name', MAX_GUEST_NAME);
  const guestPhone = optionalText(input.guestPhone, 'Guest phone', MAX_GUEST_PHONE);
  const notes = optionalText(input.notes, 'Notes', MAX_NOTES);
  const status = input.status === undefined ? 'confirmed' : bookableStatus(input.status);
  const groupId = rooms.length > 1 ? randomUUID() : null;

  const { data, error } = await tenant.db
    .from('bookings')
    .insert(
      rooms.map((room) => ({
        tenant_id: tenant.id,
        unit_id: room.unitId,
        slot_id: slotId,
        booked_date: date,
        status,
        guest_name: guestName,
        guest_phone: guestPhone,
        guest_count: room.guestCount,
        notes,
        group_id: groupId,
      })),
    )
    .select('id');

  if (error) throw writeError(error, date);

  const ids = new Set(data.map((row) => row.id));
  console.log(
    `[bookings] ${tenant.slug} booked ${[...ids].map((id) => `#${id}`).join(', ')}: ${date}, ` +
      `unit ${rooms.map((r) => r.unitId).join('+')}, slot ${slotId}, ${status}${groupId ? `, group ${groupId}` : ''}`,
  );
  const bookings = (await listBookings(tenant, { from: date })).filter((b) => ids.has(b.id));
  if (bookings.length !== ids.size) throw new Error(`Bookings ${[...ids].join(', ')} were saved but could not be read back`);

  // The total is read back from what was STORED, never computed here: the
  // trigger's price is the only price (plan Rule 2). A whole_resort tenant is
  // priced too once its unit has a rate (customer booking § 2.4), so the
  // total is null only when a row has no price.
  const total = bookings.every((b) => b.price !== null) ? bookings.reduce((sum, b) => sum + (b.price ?? 0), 0) : null;
  return { groupId, bookings, total };
}

/** One unit, one booking: what the staff form has always sent. */
export async function createBooking(tenant: BookingTenant, input: NewBooking): Promise<BookingSummary> {
  const { bookings } = await createBookings(tenant, input);
  const [created] = bookings;
  if (!created || bookings.length !== 1) throw new BookingInputError('Use createBookings for several rooms.');
  return created;
}

/**
 * The price of booking these rooms, before booking them. per_room only.
 *
 * Calls unit_price(), the same SQL function the insert trigger calls, so the
 * preview and the stored price cannot drift (plan Rule 2). A room that is not
 * this tenant's, not there, or retired gives "No such unit or slot.", exactly
 * as createBookings does; a room with no rate for the slot says so.
 */
export async function quote(
  tenant: BookingTenant,
  input: { unitId?: unknown; rooms?: unknown; guestCount?: unknown; slotId: unknown; date: unknown },
): Promise<Quote> {
  const { currency } = await requirePerRoom(tenant);
  const rooms = parseRooms(input);
  const slotId = positiveInt(input.slotId, 'Slot');
  if (!isIsoDate(input.date)) throw new BookingInputError(`"${String(input.date)}" is not a date. Use YYYY-MM-DD.`);
  const date = input.date;

  const [units, slot] = await Promise.all([
    tenant.db
      .from('units')
      .select('id, name, capacity')
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .in(
        'id',
        rooms.map((r) => r.unitId),
      ),
    tenant.db.from('slots').select('id, name').eq('tenant_id', tenant.id).eq('id', slotId).maybeSingle(),
  ]);
  if (units.error) throw new Error(`Could not load rooms: ${units.error.message}`);
  if (slot.error) throw new Error(`Could not load the slot: ${slot.error.message}`);
  if (!slot.data || units.data.length !== rooms.length) throw new BookingInputError('No such unit or slot.');
  const slotName = slot.data.name;
  await refuseClosedDays(tenant, [date]);

  const byId = new Map(units.data.map((u) => [u.id, u]));
  const lines = await Promise.all(
    rooms.map(async ({ unitId, guestCount }) => {
      const room = byId.get(unitId);
      const unit = room?.name ?? `Room ${unitId}`;
      // The maximum, said BEFORE a booking is tried (request § 4). The
      // trigger refuses it anyway, whatever path the insert takes.
      if (guestCount !== null && room?.capacity != null && guestCount > room.capacity) {
        throw new BookingInputError(`${unit} holds at most ${room.capacity} guests.`);
      }
      // unit_quote(): the same arithmetic the trigger stores (extra-guests Rule 1).
      const { data, error } = await tenant.db.rpc('unit_quote', {
        p_tenant_id: tenant.id,
        p_unit_id: unitId,
        p_slot_id: slotId,
        p_date: date,
        p_guests: guestCount,
      });
      if (error) throw new Error(`Could not price room ${unitId}: ${error.message}`);
      const [q] = data;
      if (!q) throw new BookingInputError(`${unit} has no price for ${slotName} yet.`);
      return {
        unitId,
        unit,
        guests: guestCount,
        basePrice: q.base_price,
        extraGuests: q.extra_guests,
        extraGuestPrice: q.extra_guest_price,
        surcharge: q.surcharge,
        price: q.price,
      };
    }),
  );
  return { date, slotId, slot: slotName, lines, total: lines.reduce((sum, l) => sum + l.price, 0), currency };
}

/**
 * The one place a failed booking write becomes what the caller sees. Only the
 * codes the schema raises on purpose are translated; anything else propagates
 * as a plain Error, so a real fault is never dressed up as bad input.
 */
function writeError(error: { code?: string; message: string }, date: string): Error {
  const closed = closedError(error);
  if (closed) return closed;
  if (error.code === '23P01') return new BookingConflictError(`That slot on ${date} overlaps an existing booking.`);
  if (error.code === '23503') return new BookingInputError('No such unit or slot.');
  if (error.code === '23514' && /holds at most/.test(error.message)) {
    return new BookingInputError('That is more guests than the room holds.');
  }
  if (error.code === '23514' && /no rate/.test(error.message)) {
    return new BookingInputError('That room has no price for that slot yet.');
  }
  if (error.code === '23514' && /guest count/.test(error.message)) {
    return new BookingInputError('Enter the number of guests for each room.');
  }
  return new Error(`Could not save the booking: ${error.message}`);
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

  const { data, error } = await tenant.db
    .from('bookings')
    .update({ status: 'cancelled' })
    .eq('tenant_id', tenant.id)
    .eq('id', bookingId)
    .select('id');
  if (error) throw new Error(`Could not cancel the booking: ${error.message}`);

  if (data.length > 0) console.log(`[bookings] ${tenant.slug} cancelled #${bookingId}`);
  return data.length > 0;
}

/** 'cancelled' is not a status you create a booking in. */
function bookableStatus(value: unknown): Exclude<BookingStatus, 'cancelled'> {
  if (value === 'pending' || value === 'confirmed') return value;
  throw new BookingInputError('Status must be "pending" or "confirmed".');
}
