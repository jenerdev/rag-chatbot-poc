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

import { MAX_UNIT_DESCRIPTION, MAX_UNIT_NAME } from './constants.js';
import { requirePerRoom } from './bookings.js';
import { listImagesFor } from './images.js';
import { BookingInputError } from './errors.js';
import type { Accommodation, AccommodationInput, BookingTenant, RateSummary } from './types.js';
import { optionalText, parsePrice, positiveInt, requireText } from './validate.js';

const UNIT_COLUMNS = 'id, name, description, capacity, active, sort_order';

/**
 * Every room of this tenant, active or not, in the order staff set, with its
 * rates and photos. Staff only.
 */
export async function listAccommodations(tenant: BookingTenant): Promise<Accommodation[]> {
  await requirePerRoom(tenant);
  const [units, rates, slots] = await Promise.all([
    tenant.db.from('units').select(UNIT_COLUMNS).eq('tenant_id', tenant.id).order('sort_order').order('name'),
    tenant.db.from('unit_rates').select('unit_id, slot_id, weekday_price, weekend_price').eq('tenant_id', tenant.id),
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

/** Add a room. It starts active, and cannot be booked until it has a rate. */
export async function createAccommodation(tenant: BookingTenant, input: AccommodationInput): Promise<Accommodation> {
  await requirePerRoom(tenant);
  const row = {
    tenant_id: tenant.id,
    name: requireText(input.name, 'Room name', MAX_UNIT_NAME),
    description: optionalText(input.description, 'Description', MAX_UNIT_DESCRIPTION),
    capacity: input.capacity === undefined || input.capacity === null || input.capacity === '' ? null : positiveInt(input.capacity, 'Capacity'),
    active: true,
    sort_order: input.sortOrder === undefined ? 0 : nonNegativeInt(input.sortOrder, 'Order'),
  };
  const { data, error } = await tenant.db.from('units').insert(row).select('id').single();
  if (error?.code === '23505') throw new BookingInputError(`There is already a room called "${row.name}".`);
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
  const patch: { name?: string; description?: string | null; capacity?: number | null; active?: boolean; sort_order?: number } = {};
  if (input.name !== undefined) patch.name = requireText(input.name, 'Room name', MAX_UNIT_NAME);
  if (input.description !== undefined) patch.description = optionalText(input.description, 'Description', MAX_UNIT_DESCRIPTION);
  if (input.capacity !== undefined) {
    patch.capacity = input.capacity === null || input.capacity === '' ? null : positiveInt(input.capacity, 'Capacity');
  }
  if (input.active !== undefined) {
    if (typeof input.active !== 'boolean') throw new BookingInputError('Active must be true or false.');
    patch.active = input.active;
  }
  if (input.sortOrder !== undefined) patch.sort_order = nonNegativeInt(input.sortOrder, 'Order');
  if (Object.keys(patch).length === 0) throw new BookingInputError('Nothing to change.');

  const { data, error } = await tenant.db.from('units').update(patch).eq('tenant_id', tenant.id).eq('id', unitId).select('id');
  if (error?.code === '23505') throw new BookingInputError(`There is already a room called "${patch.name}".`);
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

  const rows = rates.map((rate: unknown) => {
    const r = (rate ?? {}) as { slotId?: unknown; weekdayPrice?: unknown; weekendPrice?: unknown };
    return {
      tenant_id: tenant.id,
      unit_id: unitId,
      slot_id: positiveInt(r.slotId, 'Slot'),
      weekday_price: parsePrice(r.weekdayPrice, 'Weekday price'),
      weekend_price: parsePrice(r.weekendPrice, 'Weekend price'),
      updated_at: new Date().toISOString(),
    };
  });
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
