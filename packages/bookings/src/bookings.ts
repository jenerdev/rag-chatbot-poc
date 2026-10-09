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
import { discountLines } from './promos.js';
import { BookingConflictError, BookingInputError, BookingsNotEnabledError, PerRoomOnlyError } from './errors.js';
import { takenError } from './taken.js';
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
  optionalPositiveInt,
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
  // A retired slot (D-090) is not offered, so its rows are left out; its
  // bookings still make the slots they overlap 'taken' (the SQL checks
  // every booking of the unit, whatever its slot).
  const [closed, offered] = await Promise.all([closedDays(tenant, from, to), activeSlotNames(tenant)]);

  const rows = data
    .filter((r) => offered.has(r.slot))
    .map((r) => ({ date: r.booked_date, unit: r.unit, slot: r.slot, status: statusOn(r.booked_date, r.status, closed) }));
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

  const { data: every, error } = await tenant.db.rpc('check_room_availability', {
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
  // A retired slot (D-090) is not offered: its rows are left out, as in checkAvailability.
  const [closed, kinds, offered] = await Promise.all([closedDays(tenant, from, to), rateKinds(tenant, from, to), activeSlotNames(tenant)]);
  const data = every.filter((r) => offered.has(r.slot));

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
    dayPrice: r.day_price,
    extraGuestPrice: r.extra_guest_price,
    total: r.total,
  }));
}

/** Refuse a retired slot in words (D-090). A missing one is the trigger's "No such unit or slot.". */
async function refuseRetiredSlot(tenant: BookingTenant, slotId: number): Promise<void> {
  const { data, error } = await tenant.db.from('slots').select('active').eq('tenant_id', tenant.id).eq('id', slotId).maybeSingle();
  if (error) throw new Error(`Could not load the slot: ${error.message}`);
  if (data && !data.active) throw new BookingInputError(RETIRED);
}

/** The names of the slots offered (active, D-090). Names are unique per tenant. */
async function activeSlotNames(tenant: BookingTenant): Promise<Set<string>> {
  return new Set((await listSlots(tenant)).map((s) => s.name));
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
export async function listSlots(tenant: BookingTenant, options: { retired?: boolean } = {}): Promise<SlotSummary[]> {
  await requireConfig(tenant);
  // Active only, by default: every caller that OFFERS a slot (the booking
  // page, the chatbot's tool, the staff booking form, the rate grid) must
  // not offer a retired one (D-090). The history lists pass `retired: true`,
  // because an old booking keeps its retired slot's name.
  let query = tenant.db.from('slots').select('id, name, start_time, duration, nightly, active').eq('tenant_id', tenant.id);
  if (!options.retired) query = query.eq('active', true);
  const { data, error } = await query.order('start_time').order('name');
  if (error) throw new Error(`Could not load slots: ${error.message}`);
  return data.map((s) => ({
    id: s.id,
    name: s.name,
    startTime: s.start_time.slice(0, 5),
    duration: s.duration,
    nightly: s.nightly,
    active: s.active,
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
      'id, unit_id, slot_id, booked_date, status, guest_name, guest_phone, guest_count, notes, decision_note, promo_id, discount, price, base_price, extra_guest_price, surcharge, group_id, source, reference, guest_email, created_at',
    )
    .eq('tenant_id', tenant.id)
    .gte('booked_date', from)
    .lte('booked_date', to);
  if (unitId !== null) query = query.eq('unit_id', unitId);
  const { data, error } = await query.order('booked_date').order('id');
  if (error) throw new Error(`Could not load bookings: ${error.message}`);

  // Names are joined here rather than embedded in the select. All three
  // lookups are tenant-scoped, so a name can only come from this tenant.
  // The promo names (D-097) include retired promos: a booking keeps its name.
  const [units, slots, promos] = await Promise.all([
    listUnits(tenant),
    listSlots(tenant, { retired: true }),
    tenant.db.from('promos').select('id, name').eq('tenant_id', tenant.id),
  ]);
  if (promos.error) throw new Error(`Could not load promos: ${promos.error.message}`);
  const unitName = new Map(units.map((u) => [u.id, u.name]));
  const slotName = new Map(slots.map((s) => [s.id, s.name]));
  const promoName = new Map(promos.data.map((p) => [p.id, p.name]));

  // D-099: a pending row whose (date, unit, slot) is CONFIRMED for another
  // booking would be the 409 at Confirm. The Requests section's definition
  // (requests.ts), over the rows already loaded: the window and the room
  // filter are the same for both sides of the comparison. The trigger
  // stops such a row being born; this names the ones that were born before
  // it, or in the one-statement window it leaves (plan Rule 4). A warning,
  // never the guard (trap 21): the server still answers at Confirm.
  const taken = new Set(data.filter((b) => b.status === 'confirmed').map((b) => `${b.booked_date}|${b.unit_id}|${b.slot_id}`));
  // D-100: every row has a group now, so "has a group" no longer means
  // "several rooms"; the screen asks the size instead, over the loaded rows.
  const groupSize = new Map<string, number>();
  for (const b of data) if (b.group_id) groupSize.set(b.group_id, (groupSize.get(b.group_id) ?? 0) + 1);

  return data.map((b) => ({
    id: b.id,
    date: b.booked_date,
    unitId: b.unit_id,
    unit: unitName.get(b.unit_id) ?? '(unknown unit)',
    slotId: b.slot_id,
    slot: slotName.get(b.slot_id) ?? '(unknown slot)',
    status: b.status,
    clash: b.status === 'pending' && taken.has(`${b.booked_date}|${b.unit_id}|${b.slot_id}`),
    guestName: b.guest_name,
    guestPhone: b.guest_phone,
    guestCount: b.guest_count,
    notes: b.notes,
    decisionNote: b.decision_note,
    promoId: b.promo_id,
    promoName: b.promo_id === null ? null : (promoName.get(b.promo_id) ?? null),
    discount: b.discount,
    price: b.price,
    basePrice: b.base_price,
    extraGuestPrice: b.extra_guest_price,
    surcharge: b.surcharge,
    groupId: b.group_id,
    groupSize: b.group_id ? (groupSize.get(b.group_id) ?? 1) : 1,
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
  // A retired slot (D-090), said first too: with no pre-check, the price
  // trigger fires before bookings_slot_active (triggers run in name order)
  // and the refusal read "no price for that slot" instead of "retired".
  await refuseRetiredSlot(tenant, slotId);

  const guestName = requireText(input.guestName, 'Guest name', MAX_GUEST_NAME);
  const guestPhone = optionalText(input.guestPhone, 'Guest phone', MAX_GUEST_PHONE);
  const notes = optionalText(input.notes, 'Notes', MAX_NOTES);
  // D-095: a booking is born PENDING unless the caller says otherwise. The
  // staff route never says (its schema has no status), so a staff booking
  // holds nothing until someone presses Confirm, exactly like a customer's
  // request (D-070). The tools that seed test bookings pass 'confirmed'.
  const status = input.status === undefined ? 'pending' : bookableStatus(input.status);
  // D-097: a promo the staff member picked. The trigger checks it (this
  // tenant's, offered, covering the date, uses left) and stores the discount.
  // A booking with a promo always has a group id, so promo_uses() counts it
  // as one use however many rooms it has.
  const promoId = optionalPositiveInt(input.promoId, 'Promo');
  const groupId = rooms.length > 1 || promoId !== null ? randomUUID() : null;

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
        promo_id: promoId,
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
  input: { unitId?: unknown; rooms?: unknown; guestCount?: unknown; slotId: unknown; date: unknown; promoId?: unknown },
): Promise<Quote> {
  const { currency } = await requirePerRoom(tenant);
  const rooms = parseRooms(input);
  const slotId = positiveInt(input.slotId, 'Slot');
  const promoId = optionalPositiveInt(input.promoId, 'Promo');
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
    tenant.db.from('slots').select('id, name, active').eq('tenant_id', tenant.id).eq('id', slotId).maybeSingle(),
  ]);
  if (units.error) throw new Error(`Could not load rooms: ${units.error.message}`);
  if (slot.error) throw new Error(`Could not load the slot: ${slot.error.message}`);
  if (!slot.data || units.data.length !== rooms.length) throw new BookingInputError('No such unit or slot.');
  if (!slot.data.active) throw new BookingInputError(RETIRED);
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
        discount: 0,
        price: q.price,
      };
    }),
  );
  // D-097: the promo the staff member picked, previewed by promo_discount(),
  // the same function the trigger will store from, on the same rows in the
  // same order (the first room carries a fixed amount). The promo must be
  // this tenant's and offered; the trigger refuses the rest at insert, and
  // the preview says so first, in words.
  let promo: Quote['promo'] = null;
  if (promoId !== null) {
    const { data: p, error } = await tenant.db.from('promos').select('id, name, kind, value, active, valid_from, valid_to').eq('tenant_id', tenant.id).eq('id', promoId).maybeSingle();
    if (error) throw new Error(`Could not read the promo: ${error.message}`);
    if (!p) throw new BookingInputError('No such promo.');
    if (!p.active) throw new BookingInputError(`The promo "${p.name}" is no longer offered.`);
    if (date < p.valid_from || date > p.valid_to) throw new BookingInputError(`The promo "${p.name}" covers stays from ${p.valid_from} to ${p.valid_to}.`);
    promo = { id: p.id, name: p.name, kind: p.kind, value: p.value };
    const discounts = await discountLines(tenant, p.id, lines.map((l) => l.price));
    lines.forEach((line, i) => {
      line.discount = discounts[i] ?? 0;
      line.price -= line.discount;
    });
  }
  return {
    date,
    slotId,
    slot: slotName,
    lines,
    total: lines.reduce((sum, l) => sum + l.price, 0),
    currency,
    promo,
    discount: lines.reduce((sum, l) => sum + l.discount, 0),
  };
}

/** A retired slot's refusal (D-090), in the code's words and for the trigger's (bookings_slot_active). */
export const RETIRED = 'That slot is no longer offered. Choose another.';

/**
 * The one place a failed booking write becomes what the caller sees. Only the
 * codes the schema raises on purpose are translated; anything else propagates
 * as a plain Error, so a real fault is never dressed up as bad input.
 */
function writeError(error: { code?: string; message: string }, date: string): Error {
  const closed = closedError(error);
  if (closed) return closed;
  if (error.code === '23514' && /slot retired/.test(error.message)) return new BookingInputError(RETIRED);
  // D-099: the trigger's words ("taken on <date>: <unit> is already confirmed
  // for that slot") pass through; the constraint's own 23P01 gets the sentence.
  const taken = takenError(error);
  if (taken) return taken;
  if (error.code === '23P01') return new BookingConflictError(`That slot on ${date} overlaps an existing booking.`);
  // D-097: a promo's limit is a conflict (someone else took the last use); an
  // ended, retired or wrong-dated promo is bad input, in the trigger's words.
  if (error.code === '23514' && /reached its limit/.test(error.message)) return new BookingConflictError(error.message);
  if (error.code === '23514' && /promo/.test(error.message)) return new BookingInputError(error.message);
  if (error.code === '23503' && /Promo/.test(error.message)) return new BookingInputError('No such promo.');
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
export async function cancelBooking(tenant: BookingTenant, id: unknown, note?: unknown): Promise<boolean> {
  await requireConfig(tenant);
  const bookingId = positiveInt(id, 'Booking id');

  const { data, error } = await tenant.db
    .from('bookings')
    .update({ status: 'cancelled', decision_note: decisionNote(note) })
    .eq('tenant_id', tenant.id)
    .eq('id', bookingId)
    .select('id');
  if (error) throw new Error(`Could not cancel the booking: ${error.message}`);

  if (data.length > 0) console.log(`[bookings] ${tenant.slug} cancelled #${bookingId}`);
  return data.length > 0;
}

/**
 * Confirm a staff booking (D-095): pending → confirmed, and for a group
 * booking (several rooms, one group_id) the WHOLE group in one statement,
 * so a stay can never end up half confirmed, the same rule as a request
 * (plan/customer-booking.md § 2.6). Confirming is the moment the span is
 * taken: if another confirmed booking holds it, bookings_no_overlap refuses
 * the statement (23P01) and nothing changes; a closed date is refused in
 * words. Confirming a confirmed booking is `true`; a cancelled one, or a
 * booking that is not this tenant's, is `false`, one answer on purpose.
 */
export async function confirmBooking(tenant: BookingTenant, id: unknown, note?: unknown): Promise<boolean> {
  await requireConfig(tenant);
  const bookingId = positiveInt(id, 'Booking id');
  const decision = decisionNote(note);

  const { data: row, error: readError } = await tenant.db
    .from('bookings')
    .select('id, group_id, status')
    .eq('tenant_id', tenant.id)
    .eq('id', bookingId)
    .maybeSingle();
  if (readError) throw new Error(`Could not read the booking: ${readError.message}`);
  if (!row || row.status === 'cancelled') return false;

  let update = tenant.db.from('bookings').update({ status: 'confirmed', decision_note: decision }).eq('tenant_id', tenant.id).in('status', ['pending', 'confirmed']);
  update = row.group_id ? update.eq('group_id', row.group_id) : update.eq('id', bookingId);
  const { data, error } = await update.select('id');
  if (error?.code === '23P01') {
    throw new BookingConflictError('That span is already confirmed for another booking. Cancel the other booking first, or cancel this one.');
  }
  const closedNight = error ? closedError(error) : null;
  if (closedNight) throw new BookingInputError(`${closedNight.message.replace(' Choose another date.', '')} Cancel this booking, or reopen the date first.`);
  // manage-booking § 9 q3: a tracked stay with nothing verified needs a note.
  if (error?.code === '23514' && /No payment has been verified/.test(error.message)) throw new BookingInputError(error.message);
  if (error) throw new Error(`Could not confirm the booking: ${error.message}`);

  if (data.length > 0) console.log(`[bookings] ${tenant.slug} confirmed #${bookingId}${row.group_id ? ` (group ${row.group_id}, ${data.length} row(s))` : ''}`);
  return data.length > 0;
}

/**
 * The note staff may leave when they confirm, cancel or decline (D-096):
 * trimmed, at most 500 characters, empty means none. Bounded here AND by
 * `bookings_decision_note_length` in Postgres.
 */
export function decisionNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new BookingInputError('The note must be text.');
  const text = value.trim();
  if (text === '') return null;
  if (text.length > 500) throw new BookingInputError('The note is too long (500 characters at most).');
  return text;
}

/** 'cancelled' is not a status you create a booking in. */
function bookableStatus(value: unknown): Exclude<BookingStatus, 'cancelled'> {
  if (value === 'pending' || value === 'confirmed') return value;
  throw new BookingInputError('Status must be "pending" or "confirmed".');
}
