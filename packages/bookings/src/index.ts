// @rag/bookings — the bookings application's domain logic (D-032).
//
// Two callers, one set of functions: the admin Route Handlers in apps/web, and
// (from Phase 6) the chatbot's tool executor in @rag/pipeline. Neither one
// reaches the other over HTTP. Like @rag/pipeline, this package has no req, no
// res and no status codes of its own. It throws errors that CARRY a status, and
// apps/web/lib/route.ts maps them.
//
// Server-only through @rag/db, which imports `server-only`. A Client Component
// that imports this package is a build error, the same as for @rag/db
// (CLAUDE.md rule 2).
//
// Reading order:
//
//   constants.ts   the limits
//   validate.ts    pure input checks, and the tenant's "today"
//   errors.ts      400, 409, 404
//   bookings.ts    availability, the admin list, create, cancel

export {
  MAX_AVAILABILITY_DAYS,
  MAX_LIST_DAYS,
  MAX_GUEST_NAME,
  MAX_GUEST_PHONE,
  MAX_NOTES,
} from './constants.js';
export { BookingConflictError, BookingInputError, BookingsNotEnabledError } from './errors.js';
export {
  bookingsConfig,
  cancelBooking,
  checkAvailability,
  createBooking,
  listBookings,
  listSlots,
  listUnits,
} from './bookings.js';
export { isIsoDate, localDate, validateRange } from './validate.js';

export type {
  BookingStatus,
  BookingSummary,
  BookingTenant,
  BookingsConfig,
  NewBooking,
  SlotAvailability,
  SlotSummary,
  UnitSummary,
} from './types.js';
