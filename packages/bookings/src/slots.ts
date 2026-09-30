// slots.ts — a tenant's booking slots, managed by its owners and admins (D-090).
//
// A slot is a named period that starts at a wall-clock time and lasts a
// while ("Overnight, from 14:00, 22 hours"). Until D-090 they were seeded by
// SQL and no token could write one; now owners and admins can, under the
// policies and triggers of schema-slots.sql, which hold whatever this file
// does (wall 2). This file is wall 1: it says why BEFORE Postgres refuses,
// and every query filters on tenant_id (CLAUDE.md rule 6).
//
// Two rules, chosen by the user (2026-09-30):
//   * TIMES are fixed while an upcoming booking uses the slot. A booking
//     stores its span when it is made, and nothing moves it later.
//   * A slot with booking history is RETIRED (`active = false`), not deleted:
//     it takes no new booking, and its past bookings keep it. Only a slot
//     never booked can be deleted, and its rates go with it.

import { MAX_SLOT_NAME, MAX_SLOT_MINUTES } from './constants.js';
import { requireConfig } from './bookings.js';
import { BookingInputError } from './errors.js';
import type { BookingTenant, SlotAdmin } from './types.js';
import { positiveInt, requireText } from './validate.js';

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "08:00" → itself; anything else is refused in words. */
function startTimeOf(value: unknown): string {
  if (typeof value !== 'string' || !TIME.test(value.trim())) throw new BookingInputError('Start time is HH:MM, from 00:00 to 23:59.');
  return value.trim();
}

/** Minutes → a Postgres interval, "22:00:00" or "30:30:00" (an interval may pass 24 hours). */
function durationOf(value: unknown): string {
  const minutes = positiveInt(value, 'Length in minutes');
  if (minutes > MAX_SLOT_MINUTES) throw new BookingInputError(`A slot is at most ${MAX_SLOT_MINUTES / 60} hours long.`);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
}

/** An interval as PostgREST renders it ("22:00:00", "1 day 06:00:00") → minutes. */
export function minutesOf(duration: string): number {
  const days = /(\d+)\s+days?/.exec(duration);
  const hms = /(\d+):(\d{2}):(\d{2})/.exec(duration);
  return (days ? Number(days[1]) * 1440 : 0) + (hms ? Number(hms[1]) * 60 + Number(hms[2]) : 0);
}

function flagOf(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new BookingInputError(`${label} is true or false.`);
  return value;
}

/**
 * Every slot of the tenant, retired ones included, with what the screen needs
 * to offer the right action: how many upcoming bookings fix its times, and
 * whether it was ever booked (retire, not delete). Staff only: the counts read
 * bookings, which a chat token cannot (RLS returns 0 rows there, trap 12).
 */
export async function listSlotsAdmin(tenant: BookingTenant): Promise<SlotAdmin[]> {
  const { timezone } = await requireConfig(tenant);
  const [slots, bookings] = await Promise.all([
    tenant.db.from('slots').select('id, name, start_time, duration, nightly, active').eq('tenant_id', tenant.id).order('start_time').order('name'),
    tenant.db.from('bookings').select('slot_id, status, during').eq('tenant_id', tenant.id),
  ]);
  if (slots.error) throw new Error(`Could not load slots: ${slots.error.message}`);
  if (bookings.error) throw new Error(`Could not load bookings: ${bookings.error.message}`);
  const now = Date.now();
  // The span's end, from the tstzrange text '["2026-10-10 06:00:00+00","2026-10-11 04:00:00+00")'.
  // The offset may be any "+HH" (the session's timezone), so it is made "+HH:00" for Date.parse.
  const endOf = (during: string) => {
    const end = /,\s*"?([^")\]]+)"?[)\]]$/.exec(during)?.[1] ?? '';
    return Date.parse(end.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  };
  return slots.data.map((s) => {
    const mine = bookings.data.filter((b) => b.slot_id === s.id);
    return {
      id: s.id,
      name: s.name,
      startTime: s.start_time.slice(0, 5),
      duration: s.duration,
      minutes: minutesOf(s.duration),
      nightly: s.nightly,
      active: s.active,
      upcoming: mine.filter((b) => (b.status === 'pending' || b.status === 'confirmed') && endOf(b.during) > now).length,
      booked: mine.length > 0,
      timezone,
    };
  });
}

/** A new slot, active. The name is unique per tenant (slots_tenant_name_key). */
export async function createSlot(
  tenant: BookingTenant,
  input: { name?: unknown; startTime?: unknown; minutes?: unknown; nightly?: unknown },
): Promise<{ id: number }> {
  await requireConfig(tenant);
  const row = {
    tenant_id: tenant.id,
    name: requireText(input.name, 'Name', MAX_SLOT_NAME),
    start_time: startTimeOf(input.startTime),
    duration: durationOf(input.minutes),
    nightly: input.nightly === undefined ? false : flagOf(input.nightly, 'Nightly'),
    active: true,
  };
  const { data, error } = await tenant.db.from('slots').insert(row).select('id').single();
  if (error) throw slotError(error, row.name);
  console.log(`[bookings] ${tenant.slug} slot #${data.id} "${row.name}" created, ${row.start_time} + ${row.duration}${row.nightly ? ', nightly' : ''}`);
  return { id: data.id };
}

/**
 * Change a slot: its name, times, nightly, or active (retire / bring back).
 * `null` = not this tenant's, or not there (one answer for both).
 *
 * The times are checked here first, with the same rule as the trigger
 * (slots_times_fixed), so the refusal names the count; the trigger still
 * decides.
 */
export async function updateSlot(
  tenant: BookingTenant,
  slotId: number,
  input: { name?: unknown; startTime?: unknown; minutes?: unknown; nightly?: unknown; active?: unknown },
): Promise<{ id: number } | null> {
  await requireConfig(tenant);
  const patch: { name?: string; start_time?: string; duration?: string; nightly?: boolean; active?: boolean } = {};
  if (input.name !== undefined) patch.name = requireText(input.name, 'Name', MAX_SLOT_NAME);
  if (input.startTime !== undefined) patch.start_time = startTimeOf(input.startTime);
  if (input.minutes !== undefined) patch.duration = durationOf(input.minutes);
  if (input.nightly !== undefined) patch.nightly = flagOf(input.nightly, 'Nightly');
  if (input.active !== undefined) patch.active = flagOf(input.active, 'Active');
  if (Object.keys(patch).length === 0) throw new BookingInputError('Nothing to change.');

  if (patch.start_time !== undefined || patch.duration !== undefined) {
    const current = (await listSlotsAdmin(tenant)).find((s) => s.id === slotId);
    if (!current) return null;
    const moved = (patch.start_time !== undefined && patch.start_time !== current.startTime) || (patch.duration !== undefined && minutesOf(patch.duration) !== current.minutes);
    if (moved && current.upcoming > 0) throw timesFixed(current.upcoming, current.name);
    // Unchanged times are not a change: the trigger fires on the column
    // being SET, and would compare equal values anyway.
    if (!moved) {
      delete patch.start_time;
      delete patch.duration;
      if (Object.keys(patch).length === 0) return { id: slotId };
    }
  }

  const { data, error } = await tenant.db.from('slots').update(patch).eq('tenant_id', tenant.id).eq('id', slotId).select('id');
  if (error) throw slotError(error, patch.name ?? `#${slotId}`);
  if (data.length === 0) return null;
  console.log(`[bookings] ${tenant.slug} slot #${slotId} updated: ${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  return { id: slotId };
}

/**
 * Delete a slot that was never booked; its rates go with it. A slot with any
 * booking, cancelled ones included, is refused in words: retire it instead.
 * `false` = not this tenant's, or not there. Counted, not trusted (trap 17).
 */
export async function deleteSlot(tenant: BookingTenant, slotId: number): Promise<boolean> {
  await requireConfig(tenant);
  const { data, error } = await tenant.db.from('slots').delete().eq('tenant_id', tenant.id).eq('id', slotId).select('id');
  if (error) throw slotError(error, `#${slotId}`);
  if (data.length > 0) console.log(`[bookings] ${tenant.slug} slot #${slotId} deleted`);
  return data.length > 0;
}

function timesFixed(count: number, name: string): BookingInputError {
  return new BookingInputError(
    `"${name}" has ${count} upcoming booking${count === 1 ? '' : 's'}, so its start time and length cannot change. ` +
      'Its name and nightly can. For new times, add a new slot and retire this one.',
  );
}

/** Postgres's refusals, in words. Anything else propagates as itself. */
function slotError(error: { code?: string; message: string }, name: string): Error {
  if (error.code === '23505') return new BookingInputError(`A slot named "${name}" already exists.`);
  if (error.code === '23503') return new BookingInputError('This slot has bookings, so it cannot be deleted. Retire it instead: it then takes no new bookings, and its past bookings keep it.');
  if (error.code === '23514' && /slot times fixed/.test(error.message)) {
    const match = /(\d+) upcoming booking\(s\) use "(.*)"$/.exec(error.message);
    return match ? timesFixed(Number(match[1]), match[2]!) : new BookingInputError(error.message);
  }
  if (error.code === '23514') return new BookingInputError('A slot lasts longer than zero minutes.');
  return new Error(`Could not save the slot: ${error.message}`);
}
