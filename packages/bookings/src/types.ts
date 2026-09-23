// types.ts — what the two callers of this package code against.
//
// There are two shapes for "what is on a date", and keeping them apart is the
// point. SlotAvailability is what a stranger may see, and it is the ONLY
// shape the chatbot's tool executor imports. BookingSummary carries guest data
// and is returned only by listBookings, which the admin routes call behind
// requireAdmin().

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
  createdAt: string;
}

export interface UnitSummary {
  id: number;
  name: string;
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
  unitId: unknown;
  slotId: unknown;
  date: unknown;
  guestName: unknown;
  guestPhone?: unknown;
  guestCount?: unknown;
  notes?: unknown;
  /** Staff create confirmed bookings. 'pending' is for the future request_booking tool (§ 7). */
  status?: unknown;
}

export interface BookingsConfig {
  timezone: string;
}
