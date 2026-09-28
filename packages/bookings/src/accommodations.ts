// accommodations.ts — rooms and their prices, for a per_room tenant's STAFF.
//
// A room is a `units` row (D-051). This file adds what staff need to manage
// one: name, description, capacity, active, order, and a rate per slot. Every
// function is staff-only: its callers must have passed requireAdmin(), and RLS
// refuses a chat token's writes anyway (schema-booking-types.sql § 9).
//
// Every query filters on tenant_id (CLAUDE.md rule 6). Composite foreign keys
// stop a rate naming another tenant's room or slot, and the error for that is
// the same "No such unit or slot." as for one that does not exist.
//
// Rooms are never deleted, only deactivated: the bookings that name a room
// keep it, and there is no delete policy for a token to use.

import {
  DEFAULT_EXTRA_PERSON_RATE,
  DEFAULT_MAX_CAPACITY,
  DEFAULT_STANDARD_CAPACITY,
  MAX_UNIT_DESCRIPTION,
  MAX_UNIT_NAME,
} from './constants.js';
import { requirePerRoom } from './bookings.js';
import { listImagesFor } from './images.js';
import { BookingInputError } from './errors.js';
import type { Accommodation, AccommodationInput, BookingTenant, RateSummary } from './types.js';
import { optionalText, parsePrice, positiveInt, requireText } from './validate.js';

const UNIT_COLUMNS = 'id, name, description, capacity, standard_capacity, extra_person_rate, active, sort_order';

/** `maxCapacity` (the request's name) or `capacity` (the column's): the same thing, the maximum. */
function maximumOf(input: AccommodationInput): unknown {
  return input.maxCapacity !== undefined ? input.maxCapacity : input.capacity;
}

const blank = (value: unknown) => value === null || value === '';

/**
 * Every room of this tenant, active or not, in the order staff set, with its
 * rates and photos. Staff only.
 */
export async function listAccommodations(tenant: BookingTenant): Promise<Accommodation[]> {
  await requirePerRoom(tenant);
  const [units, rates, slots] = await Promise.all([
    tenant.db.from('units').select(UNIT_COLUMNS).eq('tenant_id', tenant.id).order('sort_order').order('name'),
    tenant.db.from('unit_rates').select('unit_id, slot_id, weekday_price, weekend_price, holiday_price').eq('tenant_id', tenant.id),
    tenant.db.from('slots').select('id, name, start_time').eq('tenant_id', tenant.id).order('start_time').order('name'),
  ]);
  if (units.error) throw new Error(`Could not load rooms: ${units.error.message}`);
  if (rates.error) throw new Error(`Could not load rates: ${rates.error.message}`);
  if (slots.error) throw new Error(`Could not load slots: ${slots.error.message}`);
  const images = await listImagesFor(tenant, null);

  // Rates in slot order, so every room's grid reads the same way.
  const slotOrder = new Map(slots.data.map((s, i) => [s.id, i]));
  const slotName = new Map(slots.data.map((s) => [s.id, s.name]));
  return units.data.map((u) => ({
    id: u.id,
    name: u.name,
    description: u.description,
    capacity: u.capacity,
    standardCapacity: u.standard_capacity,
    extraPersonRate: u.extra_person_rate,
    active: u.active,
    sortOrder: u.sort_order,
    rates: rates.data
      .filter((r) => r.unit_id === u.id)
      .sort((a, b) => (slotOrder.get(a.slot_id) ?? 0) - (slotOrder.get(b.slot_id) ?? 0))
      .map(
        (r): RateSummary => ({
          slotId: r.slot_id,
          slot: slotName.get(r.slot_id) ?? '(unknown slot)',
          weekdayPrice: r.weekday_price,
          weekendPrice: r.weekend_price,
          holidayPrice: r.holiday_price,
        }),
      ),
    images: images.filter((i) => i.unitId === u.id),
  }));
}

/** One room, or null for "not yours or not there". */
export async function getAccommodation(tenant: BookingTenant, id: unknown): Promise<Accommodation | null> {
  const unitId = positiveInt(id, 'Room');
  return (await listAccommodations(tenant)).find((a) => a.id === unitId) ?? null;
}

/**
 * Add a room. It starts active, and cannot be booked until it has a rate.
 *
 * Anything left out gets the request's defaults (plan/extra-guests.md):
 * standard 2, maximum 4, ₱250 per extra guest. A standard above the maximum
 * is refused by the database (units_standard_capacity_range).
 */
export async function createAccommodation(tenant: BookingTenant, input: AccommodationInput): Promise<Accommodation> {
  await requirePerRoom(tenant);
  const maximum = maximumOf(input);
  const row = {
    tenant_id: tenant.id,
    name: requireText(input.name, 'Room name', MAX_UNIT_NAME),
    description: optionalText(input.description, 'Description', MAX_UNIT_DESCRIPTION),
    capacity: maximum === undefined ? DEFAULT_MAX_CAPACITY : blank(maximum) ? null : positiveInt(maximum, 'Maximum guests'),
    standard_capacity:
      input.standardCapacity === undefined
        ? DEFAULT_STANDARD_CAPACITY
        : blank(input.standardCapacity)
          ? null
          : positiveInt(input.standardCapacity, 'Standard guests'),
    extra_person_rate:
      input.extraPersonRate === undefined
        ? DEFAULT_EXTRA_PERSON_RATE
        : blank(input.extraPersonRate)
          ? null
          : parsePrice(input.extraPersonRate, 'Extra guest rate'),
    active: true,
    sort_order: input.sortOrder === undefined ? 0 : nonNegativeInt(input.sortOrder, 'Order'),
  };
  // A default standard of 2 in a room whose maximum is 1 would be refused;
  // the standard can never exceed the maximum, so it is lowered to it.
  if (row.capacity !== null && row.standard_capacity !== null && input.standardCapacity === undefined) {
    row.standard_capacity = Math.min(row.standard_capacity, row.capacity);
  }
  const { data, error } = await tenant.db.from('units').insert(row).select('id').single();
  if (error?.code === '23505') throw new BookingInputError(`There is already a room called "${row.name}".`);
  if (error?.code === '23514') throw new BookingInputError('Standard guests cannot be more than the maximum.');
  if (error) throw new Error(`Could not add the room: ${error.message}`);
  console.log(`[bookings] ${tenant.slug} added room #${data.id} "${row.name}"`);
  return (await getAccommodation(tenant, data.id))!;
}

/**
 * Change a room: any of name, description, capacity, active, order. `null`
 * means "not yours or not there", the same for both (plan.md Phase 3).
 *
 * Deactivating a room with future bookings is allowed: they stay valid and
 * keep their room, and the room is simply not offered again (R-25). The
 * screen warns about them; this function does not cancel anything.
 */
export async function updateAccommodation(
  tenant: BookingTenant,
  id: unknown,
  input: AccommodationInput,
): Promise<Accommodation | null> {
  await requirePerRoom(tenant);
  const unitId = positiveInt(id, 'Room');
  const patch: {
    name?: string;
    description?: string | null;
    capacity?: number | null;
    standard_capacity?: number | null;
    extra_person_rate?: number | null;
    active?: boolean;
    sort_order?: number;
  } = {};
  if (input.name !== undefined) patch.name = requireText(input.name, 'Room name', MAX_UNIT_NAME);
  if (input.description !== undefined) patch.description = optionalText(input.description, 'Description', MAX_UNIT_DESCRIPTION);
  const maximum = maximumOf(input);
  if (maximum !== undefined) patch.capacity = blank(maximum) ? null : positiveInt(maximum, 'Maximum guests');
  if (input.standardCapacity !== undefined) {
    patch.standard_capacity = blank(input.standardCapacity) ? null : positiveInt(input.standardCapacity, 'Standard guests');
  }
  if (input.extraPersonRate !== undefined) {
    patch.extra_person_rate = blank(input.extraPersonRate) ? null : parsePrice(input.extraPersonRate, 'Extra guest rate');
  }
  if (input.active !== undefined) {
    if (typeof input.active !== 'boolean') throw new BookingInputError('Active must be true or false.');
    patch.active = input.active;
  }
  if (input.sortOrder !== undefined) patch.sort_order = nonNegativeInt(input.sortOrder, 'Order');
  if (Object.keys(patch).length === 0) throw new BookingInputError('Nothing to change.');

  const { data, error } = await tenant.db.from('units').update(patch).eq('tenant_id', tenant.id).eq('id', unitId).select('id');
  if (error?.code === '23505') throw new BookingInputError(`There is already a room called "${patch.name}".`);
  if (error?.code === '23514') throw new BookingInputError('Standard guests cannot be more than the maximum.');
  if (error) throw new Error(`Could not change the room: ${error.message}`);
  if (data.length === 0) return null;
  console.log(`[bookings] ${tenant.slug} changed room #${unitId}: ${Object.keys(patch).join(', ')}`);
  return getAccommodation(tenant, unitId);
}

/**
 * Set a room's rate for one or more slots, in CENTAVOS. An upsert: a slot with
 * a rate is repriced, a slot without one gets one. A slot left out is left as
 * it is. Existing bookings keep the price they were booked at (plan Rule 2),
 * because the trigger stored it on the booking.
 *
 * `null` means the room is not this tenant's or not there.
 */
export async function setRates(
  tenant: BookingTenant,
  id: unknown,
  rates: unknown,
): Promise<Accommodation | null> {
  await requirePerRoom(tenant);
  const unitId = positiveInt(id, 'Room');
  if (!Array.isArray(rates) || rates.length === 0) throw new BookingInputError('Send at least one rate.');

  // The holiday price is optional (null = the weekend price on a calendar
  // day). Sent for all rates or for none: a key some rows lack would reach
  // PostgREST as NULL for those rows (CLAUDE.md trap 15), silently clearing a
  // holiday price nobody meant to touch. Left out entirely, an upsert leaves
  // the stored holiday prices as they are.
  const typed = rates.map((rate: unknown) => (rate ?? {}) as { slotId?: unknown; weekdayPrice?: unknown; weekendPrice?: unknown; holidayPrice?: unknown });
  const withHoliday = typed.filter((r) => r.holidayPrice !== undefined).length;
  if (withHoliday !== 0 && withHoliday !== typed.length) {
    throw new BookingInputError('Send a holiday price (or null) for every slot, or for none.');
  }
  const rows = typed.map((r) => ({
    tenant_id: tenant.id,
    unit_id: unitId,
    slot_id: positiveInt(r.slotId, 'Slot'),
    weekday_price: parsePrice(r.weekdayPrice, 'Weekday price'),
    weekend_price: parsePrice(r.weekendPrice, 'Weekend price'),
    ...(withHoliday ? { holiday_price: r.holidayPrice === null || r.holidayPrice === '' ? null : parsePrice(r.holidayPrice, 'Holiday price') } : {}),
    updated_at: new Date().toISOString(),
  }));
  if (new Set(rows.map((r) => r.slot_id)).size !== rows.length) throw new BookingInputError('The same slot is listed twice.');

  // Checked first, so "not yours" is null (a 404 at the route) and not the
  // 23503 of the composite FK, which would say "not yours" differently.
  const { data: unit, error: unitError } = await tenant.db.from('units').select('id').eq('tenant_id', tenant.id).eq('id', unitId).maybeSingle();
  if (unitError) throw new Error(`Could not load the room: ${unitError.message}`);
  if (!unit) return null;

  const { error } = await tenant.db.from('unit_rates').upsert(rows, { onConflict: 'tenant_id,unit_id,slot_id' });
  if (error?.code === '23503') throw new BookingInputError('No such unit or slot.');
  if (error) throw new Error(`Could not save the rates: ${error.message}`);
  console.log(`[bookings] ${tenant.slug} rates for room #${unitId}: ${rows.map((r) => `slot ${r.slot_id} ${r.weekday_price}/${r.weekend_price}`).join(', ')}`);
  return getAccommodation(tenant, unitId);
}

function nonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new BookingInputError(`${label} must be a whole number, 0 or more.`);
  }
  return value;
}
