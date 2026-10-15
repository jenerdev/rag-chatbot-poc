// validate.ts — the input checks, pure and I/O-free so they can be tested alone.
//
// Validation lives in this package, not only at the route (plan/bookings.md
// Phase 2). There are two callers, the admin Route Handlers and the chatbot's
// tool executor, and only one of them has a zod schema in front of it. The
// other one's arguments were written by a model.

import {
  MAX_BOOKING_ADVANCE_DAYS,
  MAX_PRICE,
  MAX_REQUEST_EMAIL,
  MAX_REQUEST_NAME,
  MAX_REQUEST_NOTES,
  MAX_REQUEST_ROWS,
  MAX_STAY_NIGHTS,
  MAX_UNITS_PER_BOOKING,
  MIN_REQUEST_NAME,
} from './constants.js';
import { BookingInputError } from './errors.js';
import type { BookingType, BookingsConfig, PaymentFlow } from './types.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Is this a real calendar date written as YYYY-MM-DD?
 *
 * The shape check alone would accept "2026-02-30". `Date` would then roll it
 * over to 2 March without complaint, so the parsed date is written back out and
 * must match the input. That round trip is what rejects impossible dates.
 */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Whole days from `from` to `to`. Both are YYYY-MM-DD, compared as UTC midnights, so no DST. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Today's date in a timezone, as YYYY-MM-DD.
 *
 * The TENANT'S today, not the server's (plan/bookings.md § 2.3). A server in
 * UTC at 23:30 Manila time is still on the previous day. That is enough to
 * reject a booking for "today" as being in the past, or to accept yesterday.
 *
 * This is formatting an instant into a zone, which Intl does correctly. The
 * reverse, turning a wall-clock time into an instant, is the error-prone
 * direction, and that one is done in SQL (slot_range).
 */
export function localDate(timezone: string, now: Date = new Date()): string {
  // en-CA formats a date as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Check a date range, and fill in `to` when it is missing (a single day).
 *
 * `allowPast` is true for the admin list, where staff look back at who came,
 * and false for availability, where a past date has no useful answer.
 *
 * The messages are written to be read by a person AND by a model. When the
 * tool executor gets one of these, it hands it back to the model as the tool
 * result so the model can ask the user for a proper date. So the message says
 * what was wrong and what would be right.
 */
export function validateRange(
  range: { from: unknown; to?: unknown },
  { today, maxDays, allowPast }: { today: string; maxDays: number; allowPast: boolean },
): { from: string; to: string } {
  const { from } = range;
  const to = range.to ?? from;
  if (!isIsoDate(from)) throw new BookingInputError(`"${String(from)}" is not a date. Use YYYY-MM-DD.`);
  if (!isIsoDate(to)) throw new BookingInputError(`"${String(to)}" is not a date. Use YYYY-MM-DD.`);
  if (to < from) throw new BookingInputError(`The end date ${to} is before the start date ${from}.`);
  if (!allowPast && from < today) {
    throw new BookingInputError(`${from} is in the past. Today is ${today}.`);
  }
  const days = daysBetween(from, to) + 1;
  if (days > maxDays) {
    throw new BookingInputError(`${days} days is too long a range. The limit is ${maxDays} days.`);
  }
  return { from, to };
}

/** A required, trimmed, bounded string, such as a guest name. */
export function requireText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '') throw new BookingInputError(`${label} is required.`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new BookingInputError(`${label} is longer than ${maxLength} characters.`);
  return trimmed;
}

/** An optional, trimmed, bounded string. Empty becomes null, so the column holds NULL, never "". */
export function optionalText(value: unknown, label: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new BookingInputError(`${label} must be text.`);
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > maxLength) throw new BookingInputError(`${label} is longer than ${maxLength} characters.`);
  return trimmed;
}

/** A positive whole number, from a number or a numeric string. */
export function positiveInt(value: unknown, label: string): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
    throw new BookingInputError(`${label} must be a positive whole number.`);
  }
  return n;
}

/** Optional positive whole number: undefined, null and "" are null. */
export function optionalPositiveInt(value: unknown, label: string): number | null {
  return value === undefined || value === null || value === '' ? null : positiveInt(value, label);
}

/**
 * A price in CENTAVOS: a whole number from 0 to MAX_PRICE. Never a float peso
 * (plan/booking-types.md § 2.3), so 16000.10 is refused here, not rounded.
 */
export function parsePrice(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_PRICE) {
    throw new BookingInputError(`${label} must be a whole number of centavos from 0 to ${MAX_PRICE}.`);
  }
  return value;
}

const ISO_WEEKDAY = /^[1-7]$/;
const DEFAULT_WEEKEND = [5, 6, 7];

/**
 * The bookings config row, read into its defaults. The SQL trigger validated
 * every key on write (schema-booking-types.sql § 1), so a value that fails
 * here is a row written around it, and is an error, not a default.
 *
 *   booking_type absent  → 'whole_resort' (every existing tenant, D-050)
 *   weekend_days absent  → [5, 6, 7], Friday to Sunday
 *   currency absent      → 'PHP'
 *   max_stay_nights absent → MAX_STAY_NIGHTS (14), the number request_booking() defaults to
 *   max_advance_days absent → MAX_BOOKING_ADVANCE_DAYS (365), the same
 */
export function parseConfig(raw: unknown, slug: string): BookingsConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  const { timezone } = config;
  if (typeof timezone !== 'string') throw new Error(`The bookings configuration for "${slug}" has no timezone`);

  const type = config.booking_type ?? 'whole_resort';
  if (type !== 'whole_resort' && type !== 'per_room') {
    throw new Error(`The bookings configuration for "${slug}" has booking_type ${JSON.stringify(type)}`);
  }

  const days = config.weekend_days ?? DEFAULT_WEEKEND;
  if (!Array.isArray(days) || !days.every((d) => ISO_WEEKDAY.test(String(d)) && typeof d === 'number')) {
    throw new Error(`The bookings configuration for "${slug}" has weekend_days ${JSON.stringify(days)}`);
  }

  const currency = config.currency ?? 'PHP';
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`The bookings configuration for "${slug}" has currency ${JSON.stringify(currency)}`);
  }

  // The trigger allows 1 to 60 (schema-roles.sql); request_booking() reads
  // the same key with the same default, so the page and the wall agree.
  const maxStay = config.max_stay_nights ?? MAX_STAY_NIGHTS;
  if (typeof maxStay !== 'number' || !Number.isInteger(maxStay) || maxStay < 1 || maxStay > 60) {
    throw new Error(`The bookings configuration for "${slug}" has max_stay_nights ${JSON.stringify(maxStay)}`);
  }

  // 1 to 730, like the trigger; request_booking() counts it from the tenant's today.
  const maxAdvance = config.max_advance_days ?? MAX_BOOKING_ADVANCE_DAYS;
  if (typeof maxAdvance !== 'number' || !Number.isInteger(maxAdvance) || maxAdvance < 1 || maxAdvance > 730) {
    throw new Error(`The bookings configuration for "${slug}" has max_advance_days ${JSON.stringify(maxAdvance)}`);
  }

  return {
    timezone,
    bookingType: type as BookingType,
    weekendDays: days as number[],
    currency,
    maxStayNights: maxStay,
    maxAdvanceDays: maxAdvance,
  };
}

/** One room of a booking, as createBookings inserts it. */
export interface RoomChoice {
  unitId: number;
  guestCount: number | null;
}

/**
 * The rooms of a booking: `unitId` (+ `guestCount`) for one, as the staff form
 * has always sent, or `rooms: [{ unitId, guestCount? }, …]` for several.
 * Exactly one of the two. Distinct rooms: the same room twice would be a
 * guaranteed 23P01 against itself, which is a bad request, not a conflict.
 *
 * Guest count is per ROOM, because capacity is (the insert trigger checks each
 * row against its own room).
 */
export function parseRooms(input: { unitId?: unknown; rooms?: unknown; guestCount?: unknown }): RoomChoice[] {
  const hasOne = input.unitId !== undefined && input.unitId !== null;
  const hasMany = input.rooms !== undefined && input.rooms !== null;
  if (hasOne === hasMany) throw new BookingInputError('Send either one unit or a list of rooms.');

  if (hasOne) {
    return [{ unitId: positiveInt(input.unitId, 'Unit'), guestCount: optionalPositiveInt(input.guestCount, 'Guest count') }];
  }

  if (!Array.isArray(input.rooms) || input.rooms.length === 0) throw new BookingInputError('Choose at least one room.');
  if (input.rooms.length > MAX_UNITS_PER_BOOKING) {
    throw new BookingInputError(`One booking holds at most ${MAX_UNITS_PER_BOOKING} rooms.`);
  }
  const rooms = input.rooms.map((room: unknown) => {
    const r = (room ?? {}) as { unitId?: unknown; guestCount?: unknown };
    return { unitId: positiveInt(r.unitId, 'Room'), guestCount: optionalPositiveInt(r.guestCount, 'Guest count') };
  });
  if (new Set(rooms.map((r) => r.unitId)).size !== rooms.length) {
    throw new BookingInputError('The same room is listed twice.');
  }
  return rooms;
}

/** YYYY-MM-DD plus `days`, as UTC midnights, so no DST. */
/**
 * The last date a stay may START on: the tenant's today plus its
 * max_advance_days (D-078). ONE definition, for the booking page, the
 * request check and the chatbot (D-086), so the three cannot drift.
 */
export function lastBookingDate(today: string, maxAdvanceDays: number): string {
  return addDays(today, maxAdvanceDays);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * A Philippine mobile number, normalised to 09XXXXXXXXX, or null.
 *
 * Spaces, dashes, dots and brackets are dropped, and +63 becomes 0: the same
 * normalisation as request_booking(), so the per-contact limit counts
 * "+63 917 123 4567" and "0917-123-4567" as one contact. FORMAT only: whether
 * the number is real, a form cannot know (plan § 2.7).
 */
export function normalisePhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let phone = value.replace(/[\s().-]/g, '');
  if (phone.startsWith('+63')) phone = `0${phone.slice(3)}`;
  return /^09\d{9}$/.test(phone) ? phone : null;
}

/** An email of the usual shape, lower-cased, or null. Shape only, as above. */
export function normaliseEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= MAX_REQUEST_EMAIL && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
}

/** A customer's request, checked. What request_booking() receives. */
export interface ParsedRequest {
  slotId: number;
  rooms: { unitId: number; guests: number }[];
  checkIn: string;
  nights: number;
  name: string;
  phone: string;
  email: string;
  notes: string | null;
}

/**
 * Check a customer's booking request before it reaches the database.
 *
 * request_booking() checks all of this again, and is the wall (plan Rule 2).
 * This copy exists so a person gets a clear message in the page's words, and
 * so the rules can be unit-tested without a database. `today` is the TENANT'S
 * (CLAUDE.md trap 9). The first night starting later today is allowed here;
 * whether it has already started is the function's call, from the slot time.
 *
 * `rooms` is `[{ unitId, guests }]`; a whole-resort tenant sends one.
 */
export function parseRequest(
  input: {
    slotId?: unknown;
    rooms?: unknown;
    checkIn?: unknown;
    nights?: unknown;
    name?: unknown;
    phone?: unknown;
    email?: unknown;
    notes?: unknown;
  },
  {
    today,
    bookingType,
    maxNights,
    maxAdvanceDays,
    byStaff = false,
  }: {
    today: string;
    bookingType: BookingType;
    maxNights: number;
    maxAdvanceDays: number;
    /** D-111: the staff form, the same rules in a staff member's words ("The guest's name") */
    byStaff?: boolean;
  },
): ParsedRequest {
  const slotId = positiveInt(input.slotId, 'Slot');

  if (!Array.isArray(input.rooms) || input.rooms.length === 0) {
    throw new BookingInputError(bookingType === 'per_room' ? 'Choose at least one room.' : 'Choose what to book.');
  }
  if (bookingType === 'whole_resort' && input.rooms.length !== 1) {
    throw new BookingInputError('This business is booked as a whole, one booking at a time.');
  }
  if (input.rooms.length > MAX_UNITS_PER_BOOKING) {
    throw new BookingInputError(`One request holds at most ${MAX_UNITS_PER_BOOKING} rooms.`);
  }
  const rooms = input.rooms.map((room: unknown) => {
    const r = (room ?? {}) as { unitId?: unknown; guests?: unknown };
    return { unitId: positiveInt(r.unitId, 'Room'), guests: positiveInt(r.guests, 'Guests') };
  });
  // D-133: a room TYPE may be listed once per room wanted ("Casa Uno ×2");
  // the database caps it at the type's free rooms, in words.

  if (!isIsoDate(input.checkIn)) throw new BookingInputError(`"${String(input.checkIn)}" is not a date. Use YYYY-MM-DD.`);
  const checkIn = input.checkIn;
  if (checkIn < today) throw new BookingInputError(`${checkIn} is in the past. Today is ${today}.`);
  const lastDate = lastBookingDate(today, maxAdvanceDays);
  if (checkIn > lastDate) {
    throw new BookingInputError(`Bookings open ${maxAdvanceDays} day${maxAdvanceDays === 1 ? '' : 's'} ahead, so the latest date is ${lastDate}.`);
  }

  const nights = input.nights === undefined || input.nights === null || input.nights === '' ? 1 : positiveInt(input.nights, 'Nights');
  if (nights > maxNights) throw new BookingInputError(`A stay is at most ${maxNights} night${maxNights === 1 ? '' : 's'}.`);
  if (rooms.length * nights > MAX_REQUEST_ROWS) {
    throw new BookingInputError(`That is ${rooms.length * nights} room-nights; one request holds at most ${MAX_REQUEST_ROWS}.`);
  }

  const whose = byStaff ? "The guest's" : 'Your';
  if (typeof input.name !== 'string') throw new BookingInputError(`${whose} name is required.`);
  const name = input.name.trim();
  if (name.length < MIN_REQUEST_NAME || name.length > MAX_REQUEST_NAME) {
    throw new BookingInputError(`${whose} name must be ${MIN_REQUEST_NAME} to ${MAX_REQUEST_NAME} characters.`);
  }
  const phone = normalisePhone(input.phone);
  if (!phone) throw new BookingInputError('Enter a mobile number like 0917 123 4567.');
  const email = normaliseEmail(input.email);
  if (!email) throw new BookingInputError('Enter a valid email address.');
  const notes = optionalText(input.notes, 'Notes', MAX_REQUEST_NOTES);

  return { slotId, rooms, checkIn, nights, name, phone, email, notes };
}

/**
 * The booking page's text from the bookings config: `booking_page.instructions`
 * and `booking_page.guest_hint`, validated on write by the
 * tenant_applications_booking_page trigger. Absent is null.
 */
export function pageSettings(raw: unknown): { instructions: string | null; guestHint: string | null } {
  const page = ((raw ?? {}) as Record<string, unknown>).booking_page as Record<string, unknown> | undefined;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  return { instructions: text(page?.instructions), guestHint: text(page?.guest_hint) };
}

/**
 * How a request gets paid and confirmed, for the booking page's receipt to
 * explain (manage-booking D-105 to D-107): null when the tenant takes no
 * payment on the page. Policy only, no amount: what is owed is the
 * database's (stay_required()), shown on Manage booking. The shape was
 * checked when it was stored (tenant_applications_validate), so this only
 * reads it; anything unexpected reads as absent.
 */
export function paymentFlow(raw: unknown): PaymentFlow | null {
  const pay = ((raw ?? {}) as Record<string, unknown>).payments as Record<string, unknown> | undefined;
  if (!pay || typeof pay !== 'object') return null;
  const hours = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 168 ? v : null);
  const fee = pay.fee as { kind?: unknown } | undefined;
  return {
    deposit: fee?.kind === 'fixed' || fee?.kind === 'percent',
    payWithinHours: hours(pay.pay_within_hours),
    reviewWithinHours: hours(pay.review_within_hours),
    hold: pay.hold === 'on_proof' || pay.hold === 'on_request' ? pay.hold : 'none',
  };
}

/** What a stored photo is, by its first bytes. Its name and Content-Type are only what the sender typed. */
export interface ImageType {
  ext: 'jpg' | 'png' | 'webp';
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
}

/**
 * JPEG, PNG or WebP, decided by magic bytes, or null (plan/booking-types.md
 * § 2.8). Everything else is refused, SVG above all: it is XML that can carry
 * script, and it has no magic bytes to check.
 *
 *   JPEG  FF D8 FF
 *   PNG   89 50 4E 47 0D 0A 1A 0A
 *   WebP  "RIFF" <4 bytes size> "WEBP"
 */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  const at = (i: number, values: number[]) => values.every((v, j) => bytes[i + j] === v);
  if (bytes.length >= 3 && at(0, [0xff, 0xd8, 0xff])) return { ext: 'jpg', contentType: 'image/jpeg' };
  if (bytes.length >= 8 && at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: 'png', contentType: 'image/png' };
  if (bytes.length >= 12 && at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) {
    return { ext: 'webp', contentType: 'image/webp' };
  }
  return null;
}
