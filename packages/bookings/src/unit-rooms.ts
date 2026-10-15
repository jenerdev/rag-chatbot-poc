// unit-rooms.ts — the PHYSICAL rooms of a room type, for a per_room tenant's
// staff (D-133, plan/room-types.md Phase 4).
//
// A room type is a `units` row: its name, guests, rates and photos are what a
// guest sees. Its rooms are `unit_rooms` rows: "Casa Uno 1", "Casa Uno 2".
// How many a type has is how many are active, never a number typed beside
// them (Rule 2). Every unit got one room named like it, so a type with one
// room behaves exactly as before; adding a second is what lets two guests
// book Casa Uno on the same night.
//
// The database decides what may change (sql/schema-room-inventory.sql § 7):
// a room with an upcoming booking is not retired, a type keeps one active
// room, a booked room is never deleted, a whole-resort property has one room.
// Those refusals come back here in their own words, as 400s. Staff only: the
// routes pass requireAdmin(…, 'rooms:write'), and RLS asks rooms:write again.
//
// Every query filters on tenant_id (CLAUDE.md rule 6); a room or type that is
// not this tenant's is "not there", the same as one that does not exist.

import { requirePerRoom } from './bookings.js';
import { BookingInputError } from './errors.js';
import type { BookingTenant } from './types.js';
import { positiveInt, requireText } from './validate.js';

/** A room's name, the SQL check's own bound (unit_rooms_name_shape). */
export const MAX_ROOM_NAME = 80;

/** The words a refused write gets: the database's own where it wrote some. */
function writeError(error: { code?: string; message: string }, name: string): Error {
  if (error.code === '23505') return new BookingInputError(`There is already a room called "${name}" in this type.`);
  if (error.code === '23503') return new BookingInputError(`${name} has bookings, so it is kept; retire it instead.`);
  if (error.code === '23514') return new BookingInputError(error.message);
  return new Error(`Could not save the room: ${error.message}`);
}

/** The type's id if it is this tenant's, else null. */
async function typeOf(tenant: BookingTenant, unitId: unknown): Promise<number | null> {
  const id = positiveInt(unitId, 'Room type');
  const { data, error } = await tenant.db.from('units').select('id').eq('tenant_id', tenant.id).eq('id', id).maybeSingle();
  if (error) throw new Error(`Could not read the room type: ${error.message}`);
  return data?.id ?? null;
}

/** Add a room to a type, last in its order. The new room's id; null when the type is not this tenant's. */
export async function addUnitRoom(tenant: BookingTenant, unitId: unknown, name: unknown): Promise<number | null> {
  await requirePerRoom(tenant);
  const unit = await typeOf(tenant, unitId);
  if (unit === null) return null;
  const label = requireText(name, 'Room name', MAX_ROOM_NAME);
  const { data: last } = await tenant.db
    .from('unit_rooms')
    .select('sort_order')
    .eq('tenant_id', tenant.id)
    .eq('unit_id', unit)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();
  const { data, error } = await tenant.db
    .from('unit_rooms')
    .insert({ tenant_id: tenant.id, unit_id: unit, name: label, sort_order: (last?.sort_order ?? -1) + 1 })
    .select('id')
    .single();
  if (error) throw writeError(error, label);
  console.log(`[bookings] ${tenant.slug} added room #${data.id} "${label}" to type #${unit}`);
  return data.id;
}

/** Rename a room, or retire it (`active: false`) or offer it again. False when it is not this tenant's type's. */
export async function updateUnitRoom(
  tenant: BookingTenant,
  unitId: unknown,
  roomId: unknown,
  change: { name?: unknown; active?: unknown },
): Promise<boolean> {
  await requirePerRoom(tenant);
  const unit = positiveInt(unitId, 'Room type');
  const room = positiveInt(roomId, 'Room');
  const patch: { name?: string; active?: boolean } = {};
  if (change.name !== undefined) patch.name = requireText(change.name, 'Room name', MAX_ROOM_NAME);
  if (change.active !== undefined) {
    if (typeof change.active !== 'boolean') throw new BookingInputError('active must be true or false.');
    patch.active = change.active;
  }
  if (Object.keys(patch).length === 0) throw new BookingInputError('Nothing to change.');
  const { data, error } = await tenant.db
    .from('unit_rooms')
    .update(patch)
    .eq('tenant_id', tenant.id)
    .eq('unit_id', unit)
    .eq('id', room)
    .select('id, name');
  if (error) throw writeError(error, patch.name ?? 'That room');
  if (data.length === 0) return false;
  console.log(`[bookings] ${tenant.slug} room #${room}${patch.name ? ` named "${patch.name}"` : ''}${patch.active === undefined ? '' : patch.active ? ' offered' : ' retired'}`);
  return true;
}

/**
 * Delete a room that was never booked. A booked one is kept by its bookings'
 * foreign key, and the words say to retire it. False when it is not there. A
 * refused delete under RLS is silent (trap 17), so the rows deleted are counted.
 */
export async function deleteUnitRoom(tenant: BookingTenant, unitId: unknown, roomId: unknown): Promise<boolean> {
  await requirePerRoom(tenant);
  const unit = positiveInt(unitId, 'Room type');
  const room = positiveInt(roomId, 'Room');
  const { data: row } = await tenant.db.from('unit_rooms').select('name').eq('tenant_id', tenant.id).eq('unit_id', unit).eq('id', room).maybeSingle();
  if (!row) return false;
  const { data, error } = await tenant.db.from('unit_rooms').delete().eq('tenant_id', tenant.id).eq('unit_id', unit).eq('id', room).select('id');
  if (error) throw writeError(error, row.name);
  if (data.length === 0) throw new Error(`Could not delete ${row.name}: the database removed nothing.`);
  console.log(`[bookings] ${tenant.slug} deleted room #${room} "${row.name}"`);
  return true;
}
