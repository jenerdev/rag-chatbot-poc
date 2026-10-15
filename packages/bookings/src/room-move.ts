// room-move.ts — staff move a stay to another room of the same type (D-133,
// plan/room-types.md Phase 3, Rule 4).
//
// A room type (a unit) has rooms (unit_rooms), and every booking row names
// one. The database picks it (bookings_room_assign) and re-picks it at
// Confirm when it has to (bookings_room_repick); staff may still want a stay
// elsewhere. What moves is every live, not-yet-ended night of that stay that
// sits in the same room, in one statement, through move_room(): the ONE door,
// which checks its caller, writes the event with its note, and meets
// bookings_room_move_guard, which refuses a retired or taken room in words.
// A move never changes the price (unit, slot, date, guests and promo stay).
//
// moveOptions() is the courtesy for the stay's page: which rooms of the type
// are free for every one of those nights. The server stays the guard (trap
// 21); nothing here checks and then writes (trap 8).
//
// Every query filters on tenant_id (CLAUDE.md rule 6). A booking that is not
// this tenant's is "not there", the same as one that does not exist.

import { BookingConflictError, BookingInputError } from './errors.js';
import { parseSpan } from './requests.js';
import { takenError } from './taken.js';
import type { BookingTenant } from './types.js';
import { addDays } from './validate.js';

/** The move's note, move_room()'s own bound (and decision_note's). */
export const MAX_MOVE_NOTE = 500;

export interface MoveRoom {
  id: number;
  name: string;
  /** the room the stay is in now */
  current: boolean;
  /** no confirmed or held booking of another stay on any of the nights that would move, and this stay not already in it */
  free: boolean;
}

export interface MoveOptions {
  /** the room type */
  unit: string;
  /** the room the stay is in now */
  room: string;
  /** the nights that would move: live and not yet ended */
  nights: string[];
  /** the type's active rooms, current one included, in the Rooms screen's order */
  rooms: MoveRoom[];
}

interface Row {
  id: number;
  room_id: number;
  group_id: string | null;
  booked_date: string;
  during: string | null;
  status: string;
  held: boolean | null;
}

/** Which rooms of its type the stay of booking `bookingId` could move to; null when it is not this tenant's. */
export async function moveOptions(tenant: BookingTenant, bookingId: number): Promise<MoveOptions | null> {
  const { data: booking, error } = await tenant.db
    .from('bookings')
    .select('id, unit_id, room_id, group_id')
    .eq('tenant_id', tenant.id)
    .eq('id', bookingId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the booking: ${error.message}`);
  if (!booking) return null;

  const [unit, rooms, own] = await Promise.all([
    tenant.db.from('units').select('name').eq('tenant_id', tenant.id).eq('id', booking.unit_id).single(),
    tenant.db.from('unit_rooms').select('id, name').eq('tenant_id', tenant.id).eq('unit_id', booking.unit_id).eq('active', true).order('sort_order').order('id'),
    tenant.db
      .from('bookings')
      .select('id, room_id, group_id, booked_date, during, status, held')
      .eq('tenant_id', tenant.id)
      .eq('group_id', booking.group_id ?? '')
      .eq('room_id', booking.room_id)
      .in('status', ['pending', 'confirmed']),
  ]);
  for (const r of [unit, rooms, own]) if (r.error) throw new Error(`Could not read the rooms: ${r.error.message}`);

  // The nights that would move: the same filter move_room() uses.
  const now = Date.now();
  const moving = ((own.data ?? []) as Row[]).filter((r) => (parseSpan(r.during)?.[1] ?? 0) > now);
  const nights = [...new Set(moving.map((r) => r.booked_date))].sort();
  const current = rooms.data?.find((r) => r.id === booking.room_id)?.name ?? '';

  let others: Row[] = [];
  if (nights.length > 0) {
    // A slot can run past midnight, so a day either side may overlap.
    const { data, error: readError } = await tenant.db
      .from('bookings')
      .select('id, room_id, group_id, booked_date, during, status, held')
      .eq('tenant_id', tenant.id)
      .eq('unit_id', booking.unit_id)
      .in('status', ['pending', 'confirmed'])
      .gte('booked_date', addDays(nights[0]!, -1))
      .lte('booked_date', addDays(nights[nights.length - 1]!, 1));
    if (readError) throw new Error(`Could not read the rooms' bookings: ${readError.message}`);
    const movingIds = new Set(moving.map((r) => r.id));
    others = ((data ?? []) as Row[]).filter((r) => !movingIds.has(r.id));
  }

  const free = (roomId: number): boolean =>
    roomId !== booking.room_id &&
    nights.length > 0 &&
    moving.every((m) => {
      const span = parseSpan(m.during);
      return !others.some((o) => {
        if (o.room_id !== roomId) return false;
        // bookings_room_move_guard's two refusals: this stay already there that night, or someone holds the span.
        if (o.group_id === booking.group_id) return o.booked_date === m.booked_date;
        const theirs = parseSpan(o.during);
        return (o.status === 'confirmed' || o.held === true) && !!span && !!theirs && theirs[0] < span[1] && span[0] < theirs[1];
      });
    });

  return {
    unit: unit.data!.name,
    room: current,
    nights,
    rooms: (rooms.data ?? []).map((r) => ({ id: r.id, name: r.name, current: r.id === booking.room_id, free: free(r.id) })),
  };
}

/** Move the stay of booking `bookingId` (its live nights in that room) to `roomId`, with why. Rows moved; null when not this tenant's. */
export async function moveStay(tenant: BookingTenant, bookingId: number, roomId: number, note: string): Promise<number | null> {
  const trimmed = note.trim();
  if (!trimmed) throw new BookingInputError('Write why the booking moves');
  if (trimmed.length > MAX_MOVE_NOTE) throw new BookingInputError(`A note is at most ${MAX_MOVE_NOTE} characters`);

  const { data, error } = await tenant.db.rpc('move_room', { p_tenant_id: tenant.id, p_booking_id: bookingId, p_room_id: roomId, p_note: trimmed });
  if (error) {
    // The guard's words ("taken on 2027-03-01: Casa Uno 2 is already confirmed for that slot") pass through.
    if (error.code === '23P01') throw takenError(error) ?? new BookingConflictError('That room is taken on one of those nights.');
    if (error.code === '22023' || error.code === '23514') throw new BookingInputError(error.message);
    throw new Error(`Could not move the booking: ${error.message}`);
  }
  return data;
}
