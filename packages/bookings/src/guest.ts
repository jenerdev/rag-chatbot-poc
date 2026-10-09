// guest.ts — the guest's own stay, for the Manage booking page (plan/manage-booking.md).
//
// ONE read, on a CHAT token: guest_stay(), security definer, takes the
// reference and the email or phone the guest typed and returns this stay's
// guest-facing columns, or null (plan Rule 4). This file only calls it and
// gives the JSON a type. It never reads `bookings` itself: a chat token has
// no read policy there, and the column list that may leave the database is
// the function's, not ours.
//
// A miss is null, whatever the reason (no such reference, the wrong contact,
// a stay with no contact on file, a reference locked after 5 misses), and
// the route turns every null into the same 404 sentence. Telling the reasons
// apart would tell a stranger which references exist.

import { BookingInputError } from './errors.js';
import type { BookingStatus, BookingTenant } from './types.js';

/** What the guest may see of their stay. Money in centavos, as everywhere. */
export interface GuestStay {
  reference: string;
  status: BookingStatus;
  /** 'web' from the booking page, 'staff' typed in by the resort */
  source: 'web' | 'staff';
  guestName: string;
  /** the first night's date, YYYY-MM-DD, in the tenant's day */
  checkIn: string;
  startsAt: string;
  endsAt: string;
  /** the last night has ended (now(), in SQL): a confirmed stay is then "completed" (plan § 2.6) */
  ended: boolean;
  nights: number;
  createdAt: string;
  rooms: { unit: string; slot: string; guests: number }[];
  /** sums of the stored rows; null for rows priced before prices were stored */
  price: { base: number | null; extraGuests: number | null; surcharge: number | null; discount: number | null; total: number | null };
  timezone: string;
  currency: string;
}

/** The word a guest reads: `completed` is derived, never stored (plan § 2.6). */
export type GuestStatus = BookingStatus | 'completed';

export function guestStatus(stay: Pick<GuestStay, 'status' | 'ended'>): GuestStatus {
  return stay.status === 'confirmed' && stay.ended ? 'completed' : stay.status;
}

/** Longest reference and contact accepted before the database is asked. */
export const MAX_GUEST_REFERENCE = 20;
export const MAX_GUEST_CONTACT = 254;

const STATUSES: readonly BookingStatus[] = ['pending', 'confirmed', 'cancelled', 'expired'];

const text = (v: unknown, name: string): string => {
  if (typeof v !== 'string') throw new Error(`guest_stay: ${name} is not text`);
  return v;
};
const count = (v: unknown, name: string): number => {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`guest_stay: ${name} is not a whole number`);
  return v;
};
const amount = (v: unknown, name: string): number | null => (v === null || v === undefined ? null : count(v, name));

/**
 * guest_stay()'s JSON → a GuestStay, or null for a miss. Anything else the
 * function never returns is an Error (a 500), not a guess: a renamed column
 * must fail here, loudly, not show the guest "undefined".
 */
export function parseGuestStay(raw: unknown): GuestStay | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('guest_stay: not an object');
  const r = raw as Record<string, unknown>;
  const status = text(r.status, 'status') as BookingStatus;
  if (!STATUSES.includes(status)) throw new Error(`guest_stay: unknown status "${status}"`);
  const source = text(r.source, 'source');
  if (source !== 'web' && source !== 'staff') throw new Error(`guest_stay: unknown source "${source}"`);
  if (typeof r.ended !== 'boolean') throw new Error('guest_stay: ended is not a boolean');
  const price = (r.price ?? {}) as Record<string, unknown>;
  const rooms = Array.isArray(r.rooms) ? r.rooms : [];
  return {
    reference: text(r.reference, 'reference'),
    status,
    source,
    guestName: text(r.guest_name, 'guest_name'),
    checkIn: text(r.check_in, 'check_in'),
    startsAt: text(r.starts_at, 'starts_at'),
    endsAt: text(r.ends_at, 'ends_at'),
    ended: r.ended,
    nights: count(r.nights, 'nights'),
    createdAt: text(r.created_at, 'created_at'),
    rooms: rooms.map((room, i) => {
      const x = room as Record<string, unknown>;
      return { unit: text(x.unit, `rooms[${i}].unit`), slot: text(x.slot, `rooms[${i}].slot`), guests: count(x.guests, `rooms[${i}].guests`) };
    }),
    price: {
      base: amount(price.base, 'price.base'),
      extraGuests: amount(price.extra_guests, 'price.extra_guests'),
      surcharge: amount(price.surcharge, 'price.surcharge'),
      discount: amount(price.discount, 'price.discount'),
      total: amount(price.total, 'price.total'),
    },
    timezone: text(r.timezone, 'timezone'),
    currency: text(r.currency, 'currency'),
  };
}

/**
 * The guest's stay, or null. Blank or oversized input is a 400 in words
 * before the database is asked; everything else is guest_stay()'s to decide,
 * including the normalising (case, spaces, +63) and the lockout.
 */
export async function guestStay(tenant: BookingTenant, reference: string, contact: string): Promise<GuestStay | null> {
  const ref = reference.trim();
  const who = contact.trim();
  if (!ref) throw new BookingInputError('Enter your booking reference.');
  if (!who) throw new BookingInputError('Enter the email address or mobile number you booked with.');
  if (ref.length > MAX_GUEST_REFERENCE || who.length > MAX_GUEST_CONTACT) {
    throw new BookingInputError('That reference or contact is too long.');
  }
  const { data, error } = await tenant.db.rpc('guest_stay', { p_tenant_id: tenant.id, p_reference: ref, p_contact: who });
  if (error) throw new Error(`Could not look up the booking: ${error.message}`);
  return parseGuestStay(data);
}
