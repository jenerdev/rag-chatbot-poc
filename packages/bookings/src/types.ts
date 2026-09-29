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
  /** 'closed': the business is closed that day (D-080), whatever the bookings */
  status: 'open' | 'taken' | 'closed';
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
  /** centavos, the TOTAL, set by the database; null for whole_resort and for bookings made before prices existed */
  price: number | null;
  /** its parts (extra-guests D-068): the rate, the extra-guest fee, and the holiday surcharge. Null likewise */
  basePrice: number | null;
  extraGuestPrice: number | null;
  surcharge: number | null;
  /** shared by every room of one multi-room booking, and by every night of a web request; null for a single staff booking */
  groupId: string | null;
  /** 'web' for a customer's request (request_booking), 'staff' otherwise */
  source: 'staff' | 'web';
  /** a web request's reference, for people; null for staff bookings */
  reference: string | null;
  guestEmail: string | null;
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
  /** a stay of several nights is several rows of this slot (customer booking § 2.2) */
  nightly: boolean;
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
  /** the longest stay one request may be, in nights (D-078); absent in config means MAX_STAY_NIGHTS */
  maxStayNights: number;
  /** how many days after the tenant's today a stay may start (D-078); absent in config means MAX_BOOKING_ADVANCE_DAYS */
  maxAdvanceDays: number;
}

/**
 * One (date, room, slot) for a per_room tenant: SlotAvailability plus what a
 * resort publishes anyway (plan/booking-types.md Rule 4). No guest data, and
 * no description: tenant-written free text is not put into a prompt.
 */
export interface RoomAvailability {
  date: string;
  unit: string;
  /** the MAXIMUM guests */
  capacity: number | null;
  /** guests the base price covers, and the fee per guest above it (null = no fee) */
  standardCapacity: number | null;
  extraPersonRate: number | null;
  slot: string;
  /** 'closed': the business is closed that day (D-080) */
  status: 'open' | 'taken' | 'closed';
  /** centavos, the base rate for that date: weekday, weekend or holiday (R-24 closed by customer booking § 2.3) */
  price: number;
  /** for the guests asked about (0 when none were): the fee, and base + fee + that day's surcharge */
  extraGuestPrice: number;
  total: number;
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
  /** one line per room: the rate, the guests above standard and their fee, and the room's total */
  lines: {
    unitId: number;
    unit: string;
    guests: number | null;
    basePrice: number;
    extraGuests: number;
    extraGuestPrice: number;
    surcharge: number;
    price: number;
  }[];
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
  /** on a rate_calendar day; null means the weekend price (customer booking § 2.3) */
  holidayPrice: number | null;
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
  /** the MAXIMUM guests (the request's maxCapacity; the column kept its name, D-065) */
  capacity: number | null;
  standardCapacity: number | null;
  /** centavos per guest above standard, per booking */
  extraPersonRate: number | null;
  active: boolean;
  sortOrder: number;
  rates: RateSummary[];
  images: ImageSummary[];
}

/** What createAccommodation / updateAccommodation accept. Loose, validated here. */
export interface AccommodationInput {
  name?: unknown;
  description?: unknown;
  /** the maximum; `maxCapacity` is accepted as the same thing */
  capacity?: unknown;
  maxCapacity?: unknown;
  standardCapacity?: unknown;
  extraPersonRate?: unknown;
  active?: unknown;
  sortOrder?: unknown;
}

// --- customer booking (plan/customer-booking.md) ------------------------------

/** A holiday or peak day, per tenant. Readable by the tenant's chat token (the page shows it). */
export interface CalendarDay {
  /** YYYY-MM-DD */
  day: string;
  /** 'closed' (D-080): nothing may be booked on it, and its surcharge is 0 */
  kind: 'holiday' | 'peak' | 'closed';
  label: string;
  /** centavos, added once per night per unit on this day */
  surcharge: number;
}

/**
 * What the public booking page may show, and nothing else: the business's
 * bookable units and slots, their public prices, and the page's own text.
 * No bookings, no guest data (plan Rule 4). For a chat token.
 */
export interface BookingPage {
  bookingType: BookingType;
  timezone: string;
  currency: string;
  /** the tenant's today, where the date picker starts */
  today: string;
  /** the last date a stay may start on: the tenant's today plus its max_advance_days */
  lastDate: string;
  maxNights: number;
  instructions: string | null;
  guestHint: string | null;
  slots: SlotSummary[];
  units: {
    id: number;
    name: string;
    description: string | null;
    capacity: number | null;
    standardCapacity: number | null;
    extraPersonRate: number | null;
    /** only the slots this unit has a price for */
    rates: RateSummary[];
  }[];
  /** holiday and peak days from today to lastDate */
  calendar: CalendarDay[];
}

/** One unit on one night of a request or a quote. */
export interface RequestLine {
  date: string;
  unitId: number;
  unit: string;
  guests: number;
  basePrice: number;
  extraGuestPrice: number;
  surcharge: number;
  /** centavos: base + extra + surcharge */
  price: number;
  /** a holiday or peak label for this date, or null */
  holiday: string | null;
}

/** A price for a stay before it is requested. Read-only; nothing is held. */
export interface RequestQuote {
  slotId: number;
  slot: string;
  checkIn: string;
  nights: number;
  lines: RequestLine[];
  /** centavos, the sum of the lines */
  total: number;
  currency: string;
  /** false when a night is already CONFIRMED for one of the units; a request would be refused */
  available: boolean;
}

/** What a customer gets back after sending a request: the stored rows, never recomputed. */
export interface RequestReceipt {
  reference: string;
  slot: string;
  checkIn: string;
  nights: number;
  /** ISO instants of the first night's start and the last night's end */
  startsAt: string;
  endsAt: string;
  lines: RequestLine[];
  /** centavos, the sum of the STORED prices */
  total: number;
  currency: string;
  instructions: string | null;
}

/** A web request as staff see it: one group, all its nights. Guest data, so staff only. */
export interface BookingRequest {
  groupId: string;
  reference: string;
  /** every row of a group has the same status (confirm and decline are one statement) */
  status: BookingStatus;
  guestName: string;
  guestPhone: string | null;
  guestEmail: string | null;
  notes: string | null;
  createdAt: string;
  slotId: number;
  slot: string;
  checkIn: string;
  nights: number;
  units: { unitId: number; unit: string; guests: number | null }[];
  bookingIds: number[];
  /** centavos, the sum of the stored prices */
  total: number | null;
  /** true when a night is now CONFIRMED for another booking of one of these units: confirming would be refused */
  clash: boolean;
  /** a night of it is on a closed date (D-080); Postgres refuses the confirm, so decline it */
  closed: boolean;
}
