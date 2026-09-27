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
//   bookings.ts    availability, the admin list, create, cancel; room
//                  availability, several rooms at once, quotes
//   accommodations.ts   rooms and their rates, for staff (per_room)
//   images.ts      room photos in Storage, for staff (per_room)

export {
  MAX_AVAILABILITY_DAYS,
  MAX_AVAILABILITY_ROWS,
  MAX_LIST_DAYS,
  MAX_GUEST_NAME,
  MAX_GUEST_PHONE,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE,
  MAX_IMAGES_PER_UNIT,
  MAX_NOTES,
  MAX_PRICE,
  MAX_UNIT_DESCRIPTION,
  MAX_UNIT_NAME,
  MAX_UNITS_PER_BOOKING,
  DEFAULT_EXTRA_PERSON_RATE,
  DEFAULT_MAX_CAPACITY,
  DEFAULT_STANDARD_CAPACITY,
} from './constants.js';
export { BookingConflictError, BookingInputError, BookingsNotEnabledError, PerRoomOnlyError } from './errors.js';
export {
  bookingsConfig,
  cancelBooking,
  checkAvailability,
  checkRoomAvailability,
  createBooking,
  createBookings,
  listBookings,
  listRooms,
  listSlots,
  listUnits,
  quote,
  requirePerRoom,
} from './bookings.js';
export {
  createAccommodation,
  getAccommodation,
  listAccommodations,
  setRates,
  updateAccommodation,
} from './accommodations.js';
export { addImage, listImages, removeImage, setImageOrder } from './images.js';
export { isIsoDate, localDate, sniffImageType, validateRange } from './validate.js';

export type {
  Accommodation,
  AccommodationInput,
  BookingGroup,
  BookingStatus,
  BookingSummary,
  BookingTenant,
  BookingType,
  BookingsConfig,
  ImageSummary,
  NewBooking,
  Quote,
  RateSummary,
  RoomAvailability,
  SlotAvailability,
  SlotSummary,
  UnitSummary,
} from './types.js';
