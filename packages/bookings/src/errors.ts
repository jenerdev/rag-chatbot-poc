// errors.ts — the three ways a booking call fails on purpose.
//
// Each carries `status`, because that is the one property the web app's error
// map reads (apps/web/lib/route.ts), exactly as OpenAIError and AdminAuthError
// do. The mapping itself stays in that one place. This package only says what
// kind of failure it was.
//
// Anything else, such as a network error or an unexpected Postgres error,
// propagates as itself. No swallowing (architecture.md § 9).

/** Bad input: an impossible date, a range that is too long, a missing guest name. HTTP 400. */
export class BookingInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'BookingInputError';
  }
}

/**
 * The slot overlaps a live booking. HTTP 409.
 *
 * Raised for Postgres 23P01 (exclusion_violation) and for nothing else.
 * `bookings_no_overlap` is the only exclusion constraint in the schema, so this
 * code means exactly "that span is taken". Catching more than that would turn
 * unrelated failures into a misleading "already booked".
 */
export class BookingConflictError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'BookingConflictError';
  }
}

/**
 * This tenant does not have the bookings application. HTTP 404, not 403.
 *
 * "Not enabled here" must look the same as "no such route". A 403 would tell a
 * stranger that the feature exists for this tenant and is merely locked.
 */
export class BookingsNotEnabledError extends Error {
  readonly status = 404;
  constructor(slug: string) {
    super(`Bookings are not enabled for "${slug}"`);
    this.name = 'BookingsNotEnabledError';
  }
}
