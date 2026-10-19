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

export type BookingStatus = 'pending' | 'confirmed' | 'cancelled' | 'expired';

/** One booking as the admin screen shows it. Guest data, so admin-only. */
export interface BookingSummary {
  id: number;
  date: string;
  unitId: number;
  unit: string;
  slotId: number;
  slot: string;
  status: BookingStatus;
  /** D-099: pending, and its night is already CONFIRMED for another booking of the same unit and slot, so Confirm would be a 409. False for any other status */
  clash: boolean;
  guestName: string;
  guestPhone: string | null;
  guestCount: number | null;
  notes: string | null;
  /** what staff wrote when they confirmed or cancelled it (D-096); null until then */
  decisionNote: string | null;
  /** the promo it got (D-097), by id and name; null without one */
  promoId: number | null;
  promoName: string | null;
  /** centavos, part of `price`; null without a promo and for old rows */
  discount: number | null;
  /** centavos, the TOTAL (net of the discount), set by the database; null for whole_resort and for bookings made before prices existed */
  price: number | null;
  /** its parts (extra-guests D-068): the rate, the extra-guest fee, and the holiday surcharge. Null likewise */
  basePrice: number | null;
  extraGuestPrice: number | null;
  surcharge: number | null;
  /** shared by every room of one multi-room booking and by every night of a web request; since D-100 every row has one (a single booking is a group of one). Null only on a row older than the backfill, which there are none of */
  groupId: string | null;
  /** D-100: how many rows the loaded window holds for this group; > 1 means several rooms or nights */
  groupSize: number;
  /** 'web' for a customer's request (request_booking), 'staff' otherwise */
  source: 'staff' | 'web';
  /** the stay's reference, for people (D-100: every stay has one; null only on a row older than the backfill) */
  reference: string | null;
  guestEmail: string | null;
  /** D-111: the staff member ticked Walk in; read from the stay. A label only */
  walkIn: boolean;
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
  /** false = retired (D-090): takes no new booking; its past bookings keep it */
  active: boolean;
}

/** A slot as the Slots screen shows it (D-090): what decides which actions it offers. */
export interface SlotAdmin extends SlotSummary {
  /** the duration in minutes, for the form */
  minutes: number;
  /** pending or confirmed bookings not yet ended: while > 0 the times are fixed */
  upcoming: number;
  /** any booking ever, cancelled included: then it is retired, not deleted */
  booked: boolean;
  timezone: string;
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
  /** Born pending unless named (D-095); the tools that seed bookings pass 'confirmed'. */
  status?: unknown;
  /** A promo the staff member picked (D-097). The trigger checks it and stores the discount. */
  promoId?: unknown;
}

// --- promos (plan/promos.md, D-097) -------------------------------------------

export type PromoKind = 'fixed' | 'percent';

/** A promo as the Promos screen shows it. Members read; owners and admins write. */
export interface Promo {
  id: number;
  name: string;
  kind: PromoKind;
  /** centavos for fixed; hundredths of a percent for percent (1250 = 12.50 %) */
  value: number;
  /** the STAY dates it covers, inclusive */
  validFrom: string;
  validTo: string;
  /** null = automatic: applies by itself to every eligible stay */
  code: string | null;
  /** null = unlimited */
  maxUses: number | null;
  active: boolean;
  /** distinct pending or confirmed requests that used it, counted now */
  uses: number;
  createdAt: string;
}

/** What createPromo accepts. Loose types on purpose: this package validates them itself. */
export interface NewPromo {
  name: unknown;
  kind: unknown;
  value: unknown;
  validFrom: unknown;
  validTo: unknown;
  code?: unknown;
  maxUses?: unknown;
}

/** promo_for_request()'s answer for one stay. `reason` says why it does not apply, or null. */
export interface PromoForStay {
  id: number;
  name: string;
  kind: PromoKind;
  value: number;
  validFrom: string;
  validTo: string;
  reason: 'dates' | 'exhausted' | null;
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
/** A date's rate: the calendar's kind, or the tenant's weekend days, or neither (D-082). */
export type RateKind = 'weekday' | 'weekend' | 'holiday' | 'peak' | 'closed';

/**
 * One date on the staff calendar (D-103), as calendar_days() decides it:
 * closed overrides everything; `none` is 0 sellable pairs (never "available");
 * full is every (active room, active slot) taken; partial is some.
 */
export type OccupancyState = 'closed' | 'none' | 'full' | 'partial' | 'available';

export interface OccupancyDay {
  day: string;
  state: OccupancyState;
  taken: number;
  sellable: number;
  /** Distinct pending stays on the date: a three-room request is 1. */
  pending: number;
  rateKind: RateKind;
  /** The holiday, peak or closed date's label, as staff typed it. */
  label: string | null;
  /** Not past, not beyond max_advance_days, not closed: what the booking page would take. */
  bookable: boolean;
}

/**
 * A booking on the Day view (D-103): what staff need at the front desk, from
 * the staff list (BookingSummary), field by field. No price: the calendar
 * shows none (plan § 6). `date` and `slot` are the booking's OWN, which differ
 * from the cell's when the stay began earlier and runs into this date.
 */
export interface DayBooking {
  id: number;
  date: string;
  slot: string;
  status: 'pending' | 'confirmed';
  clash: boolean;
  guestName: string;
  guestPhone: string | null;
  guestEmail: string | null;
  guestCount: number | null;
  notes: string | null;
  reference: string | null;
  source: 'staff' | 'web';
}

/** Which booking overlaps which (room, slot) on the Day view's date. */
export interface DaySlotBooking {
  unitId: number;
  slotId: number;
  booking: DayBooking;
}

export interface OccupancySlot {
  day: string;
  unitId: number;
  unit: string;
  slotId: number;
  slot: string;
  state: 'closed' | 'taken' | 'open';
  pending: number;
  /** D-133: rooms of the type confirmed or held on the slot's span, of its active rooms; `taken` when they are equal */
  roomsTaken: number;
  roomsTotal: number;
}

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
  /** WHICH of those rates `price` is: rate_kind(), the branch unit_price() took (D-082) */
  rateKind: RateKind;
  /**
   * centavos, what the slot costs that date for its included guests, the
   * calendar's surcharge IN: unit_quote()'s price with no guest count (D-083).
   * What a person is quoted; `price` alone misses a holiday's surcharge.
   */
  dayPrice: number;
  /** for the guests asked about (0 when none were): the fee, and base + fee + that day's surcharge */
  extraGuestPrice: number;
  total: number;
  /** D-133: the type's active rooms free that date and slot (0 when taken), of its active rooms */
  roomsFree: number;
  roomsTotal: number;
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
    /** centavos, this room's share of the promo (D-097): a fixed amount on the first line; 0 without one */
    discount: number;
    /** centavos, net of the discount */
    price: number;
  }[];
  /** centavos, net of the discount */
  total: number;
  currency: string;
  /** the promo applied (D-097), or null */
  promo: { id: number; name: string; kind: PromoKind; value: number } | null;
  /** centavos, the sum of the lines' discounts */
  discount: number;
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
  /** D-133: the type's physical rooms, retired ones included, in order; how many it has is how many are active */
  rooms: UnitRoom[];
}

/** One physical room of a room type (unit_rooms, D-133). */
export interface UnitRoom {
  id: number;
  name: string;
  /** a retired room takes no new booking; a booked room is retired, never deleted */
  active: boolean;
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
  /** how a request is paid and confirmed (policy, no amounts); null when the tenant takes no payment on the page */
  payment: PaymentFlow | null;
  slots: SlotSummary[];
  units: {
    id: number;
    name: string;
    description: string | null;
    capacity: number | null;
    standardCapacity: number | null;
    extraPersonRate: number | null;
    /** D-133: the type's active rooms, the most one request may take */
    rooms: number;
    /** only the slots this unit has a price for */
    rates: RateSummary[];
  }[];
  /** holiday and peak days from today to lastDate */
  calendar: CalendarDay[];
}

/** How a request gets paid and confirmed (manage-booking D-105 to D-107): policy only, never an amount. */
export interface PaymentFlow {
  /** true when a deposit (a fixed amount or a percentage) confirms the stay, false when the full price does */
  deposit: boolean;
  /** pay within this many hours of the request, or it expires; null = no deadline */
  payWithinHours: number | null;
  /** staff check a proof within this many hours; null = not stated */
  reviewWithinHours: number | null;
  /** D-106: when the dates are held for the guest */
  hold: 'none' | 'on_proof' | 'on_request';
}

/** One unit on one night of a request or a quote. */
export interface RequestLine {
  date: string;
  unitId: number;
  unit: string;
  /** D-133, a stored row only (the stay's page): the row and its physical room; absent on a quote */
  bookingId?: number;
  roomId?: number;
  room?: string | null;
  guests: number;
  basePrice: number;
  extraGuestPrice: number;
  surcharge: number;
  /** centavos, this night's share of the promo (D-097): a fixed amount on the first line, a percentage on each; 0 without one */
  discount: number;
  /** centavos: base + extra + surcharge − discount */
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
  /** centavos, the sum of the lines (net of the discount) */
  total: number;
  currency: string;
  /** false when a night is already CONFIRMED for one of the units; a request would be refused */
  available: boolean;
  /** D-133: each requested type's fewest free rooms over the stay, the page's cap */
  free: { unitId: number; rooms: number }[];
  /** the promo applied (D-097): a typed code that applies, or the automatic one; null otherwise */
  promo: { id: number; name: string; kind: PromoKind; value: number } | null;
  /** centavos, the sum of the lines' discounts; 0 without a promo */
  discount: number;
  /** why a TYPED code did not apply, in words; null when it did or none was typed */
  promoMessage: string | null;
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
  /** centavos, the sum of the STORED prices (net of the discount) */
  total: number;
  /** centavos, the sum of the STORED discounts (D-097); 0 without a promo */
  discount: number;
  currency: string;
  instructions: string | null;
}

/** A stay waiting for a decision, or decided, as staff see it: one group, all its nights. Guest data, so staff only. */
export interface BookingRequest {
  groupId: string;
  reference: string;
  /** D-100: 'web' from the booking page (request_booking), 'staff' made on the Bookings screen; both are decided here */
  source: 'staff' | 'web';
  /** D-111: a staff stay for a guest who walked in; a label only */
  walkIn: boolean;
  /** every row of a group has the same status (confirm and decline are one statement) */
  status: BookingStatus;
  guestName: string;
  guestPhone: string | null;
  guestEmail: string | null;
  notes: string | null;
  /** what staff wrote when they confirmed or declined it (D-096); null while pending */
  decisionNote: string | null;
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
  /** manage booking (plan § 4): the stay's payment as stay_payment() derives it, and its deadline; null = not tracked */
  payment: { status: string; payBy: string | null; enough: boolean } | null;
}
