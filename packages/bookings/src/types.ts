// types.ts — what the two callers of this package code against.
//
// There are two shapes for "what is on a date", and keeping them apart is the
// point. SlotAvailability is what a stranger may see, and it is the ONLY
// shape the chatbot's tool executor imports. BookingSummary carries guest data
// and is returned only by listBookings, which the admin routes call behind
// requireAdmin().

import type { DbClient } from '@rag/db';

/**
 * The part of a tenant this package needs.
 *
 * Not `TenantContext` from @rag/pipeline, because the dependency points the
 * other way: pipeline → bookings → db (D-032). Pipeline's TenantContext has
 * both fields, so it is accepted here as-is, structurally.
 *
 * REQUIRED as the first argument of every function (D-027). No default, no
 * ambient tenant.
 */
export interface BookingTenant {
  id: number;
  slug: string;
  /**
   * The database as this tenant (auth-rls Phase 3). Pipeline's TenantContext
   * carries the same field. RLS behind every tenant_id filter here: a chat
   * token reads no `bookings` row at all, and check_availability, which is
   * security definer, checks the token's tenant itself.
   */
  db: DbClient;
}

/**
 * One (date, unit, slot) and whether it can be booked.
 *
 * No guest name, phone, count, notes or booking id, and no field that could
 * hold one (plan/bookings.md Rule 3). Whatever this contains goes into the
 * chatbot's prompt, and a prompt-injected model can recite it.
 */
export interface SlotAvailability {
  date: string;
  unit: string;
  slot: string;
  status: 'open' | 'taken';
}

export type BookingStatus = 'pending' | 'confirmed' | 'cancelled';

/** One booking as the admin screen shows it. Guest data, so admin-only. */
export interface BookingSummary {
  id: number;
  date: string;
  unitId: number;
  unit: string;
  slotId: number;
  slot: string;
  status: BookingStatus;
  guestName: string;
  guestPhone: string | null;
  guestCount: number | null;
  notes: string | null;
  /** centavos, set by the database; null for whole_resort and for bookings made before prices existed */
  price: number | null;
  /** shared by every room of one multi-room booking; null for a single room */
  groupId: string | null;
  createdAt: string;
}

export interface UnitSummary {
  id: number;
  name: string;
  /** false once staff deactivate a room; its old bookings still name it */
  active: boolean;
}

export interface SlotSummary {
  id: number;
  name: string;
  /** "HH:MM", wall-clock time in the tenant's timezone */
  startTime: string;
  /** Postgres interval text, e.g. "22:00:00" */
  duration: string;
}

/** What createBooking accepts. Loose types on purpose: this package validates them itself. */
export interface NewBooking {
  /**
   * One unit, as before. For several rooms at once, send `rooms` instead;
   * exactly one of the two.
   */
  unitId?: unknown;
  /** Several rooms, one booking group (per_room only): `[{ unitId, guestCount? }, …]` */
  rooms?: unknown;
  slotId: unknown;
  date: unknown;
  guestName: unknown;
  guestPhone?: unknown;
  guestCount?: unknown;
  notes?: unknown;
  /** Staff create confirmed bookings. 'pending' is for the future request_booking tool (§ 7). */
  status?: unknown;
}

export type BookingType = 'whole_resort' | 'per_room';

export interface BookingsConfig {
  timezone: string;
  /** absent in config means 'whole_resort' (plan/booking-types.md § 2.1) */
  bookingType: BookingType;
  /** ISO weekdays, 1 = Monday … 7 = Sunday, priced at the weekend rate */
  weekendDays: number[];
  /** three letters, for formatting only; every amount is centavos */
  currency: string;
}

/**
 * One (date, room, slot) for a per_room tenant: SlotAvailability plus what a
 * resort publishes anyway (plan/booking-types.md Rule 4). No guest data, and
 * no description: tenant-written free text is not put into a prompt.
 */
export interface RoomAvailability {
  date: string;
  unit: string;
  capacity: number | null;
  slot: string;
  status: 'open' | 'taken';
  /** centavos, the base rate for that date: weekday or weekend, nothing else (R-24) */
  price: number;
}

/** A booking group as createBookings returns it. */
export interface BookingGroup {
  /** null when the group is one room */
  groupId: string | null;
  bookings: BookingSummary[];
  /** centavos, the sum of the stored prices; null for whole_resort */
  total: number | null;
}

/** What a price preview returns. The same unit_price() the insert trigger uses. */
export interface Quote {
  date: string;
  slotId: number;
  slot: string;
  lines: { unitId: number; unit: string; price: number }[];
  /** centavos */
  total: number;
  currency: string;
}

export interface RateSummary {
  slotId: number;
  slot: string;
  /** centavos */
  weekdayPrice: number;
  weekendPrice: number;
}

export interface ImageSummary {
  id: number;
  unitId: number;
  /** the object name in the bucket */
  path: string;
  /** public, no token needed (the bucket is public for reads, plan § 2.8) */
  url: string;
  sortOrder: number;
}

/** A room as the staff screen shows it. Staff only. */
export interface Accommodation {
  id: number;
  name: string;
  description: string | null;
  capacity: number | null;
  active: boolean;
  sortOrder: number;
  rates: RateSummary[];
  images: ImageSummary[];
}

/** What createAccommodation / updateAccommodation accept. Loose, validated here. */
export interface AccommodationInput {
  name?: unknown;
  description?: unknown;
  capacity?: unknown;
  active?: unknown;
  sortOrder?: unknown;
}
