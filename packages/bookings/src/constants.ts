// The bookings knobs, in one place. `CLAUDE.md` § Conventions: SCREAMING_SNAKE_CASE,
// findable, one file to read when asking "what can I change?".
//
// Unlike the retrieval constants, none of these have been measured yet. They
// are provisional limits, and each says what it bounds.

// The longest range check_availability accepts, in days, both ends included.
// Every row becomes part of the tool result, and so part of the prompt: Villa
// has 3 slots, so 31 days is 93 rows. Also the answer to "is anything free in
// October?". Plan/bookings.md put this in @rag/pipeline's constants. It lives
// here instead, because this package is the one that enforces it, and both
// callers get the same limit.
export const MAX_AVAILABILITY_DAYS = 31;

// The longest range the admin list returns. A quarter, so a staff member can
// see a season at once without an unbounded query.
export const MAX_LIST_DAYS = 92;

// Free-text bounds. A guest name is not an essay, and notes are not a document.
export const MAX_GUEST_NAME = 200;
export const MAX_GUEST_PHONE = 40;
export const MAX_NOTES = 2000;

// --- booking types (plan/booking-types.md) -----------------------------------
// Provisional too, and each says which phase measures it.

// The most rooms one booking (one group, one insert) may hold. A group is one
// statement, so this bounds how much a single mistake can hold.
export const MAX_UNITS_PER_BOOKING = 10;

// The most rows check_room_availability may hand back in one call. Rooms ×
// slots × days grows fast (plan § 2.6), and every row becomes prompt text.
// MEASURED in Phase 6 (plan/booking-types-phase6-rows.mjs): 36.3 input tokens
// a row, so 150 rows ≈ 5,400 tokens. That keeps a whole month of harbor's
// four rooms (31 × 4 = 124 rows, 4,500 tokens) inside the cap, and a question
// that would exceed it gets a message saying how to narrow it.
export const MAX_AVAILABILITY_ROWS = 150;

// The same bounds as the SQL checks on `units`, so the message is ours and not
// Postgres's. Change both together.
export const MAX_UNIT_NAME = 100;
export const MAX_UNIT_DESCRIPTION = 2000;

// The highest price, in CENTAVOS (₱1,000,000). Not a business rule: a guard
// against a typo that adds three zeros.
export const MAX_PRICE = 100_000_000;

// Photos. MAX_IMAGE_BYTES matches the bucket's file_size_limit and
// MAX_IMAGES_PER_UNIT matches the unit_images_cap trigger (schema-booking-types.sql
// § 10, § 11): change them together. MEASURED 2026-09-28 with a real phone
// photo (plan/baseline/photo-measurement-2026-09-28.txt): 14,509 KB in the
// browser became a 1600×1067 WebP of 88,902 bytes (86.8 KB), with no EXIF or
// GPS. So 1600 px keeps a room photo sharp at under 100 KB, and 2 MiB leaves
// ~24× headroom for busier scenes and for the JPEG fallback of a browser that
// cannot encode WebP; an unresized phone photo is still refused.
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGES_PER_UNIT = 6;
export const MAX_IMAGE_EDGE = 1600;
export const IMAGE_BUCKET = 'unit-images';

// --- extra guests (plan/extra-guests.md) --------------------------------------
// The request's numbers, as the DEFAULTS for a new room, not one rule for
// every room: they are "configurable room properties" (§ 1). A room created
// without them gets these; an existing room keeps whatever it has, so no
// price changes by accident (§ 2.1). The arithmetic is NOT here: it is SQL's
// unit_quote(), the one place a price is made.
export const DEFAULT_STANDARD_CAPACITY = 2;
export const DEFAULT_MAX_CAPACITY = 4;
export const DEFAULT_EXTRA_PERSON_RATE = 25_000; // centavos: ₱250 per extra guest, per booking

// --- customer booking (plan/customer-booking.md) ------------------------------
// POLICY, not measurements (plan § 8 q8, agreed 2026-09-28). The SQL function
// request_booking() enforces the same four numbers, and it is the wall: these
// copies let the page and this package say so first, in their own words.
// verify.mjs checks 14 nights accepted and 15 refused, so a change on one side
// only shows up. Change both together (schema-customer-booking.sql § 11).
export const MAX_STAY_NIGHTS = 14;
export const MAX_BOOKING_ADVANCE_DAYS = 365;
export const MAX_OPEN_REQUESTS_PER_CONTACT = 3;
/** units × nights in one request: 5 rooms × 14 nights */
export const MAX_REQUEST_ROWS = 70;
// The contact fields' bounds, the same as the SQL function's.
export const MAX_REQUEST_NAME = 100;
export const MIN_REQUEST_NAME = 2;
export const MAX_REQUEST_EMAIL = 254;
export const MAX_REQUEST_NOTES = 1000;
// A holiday's label, as rate_calendar_label_length.
export const MAX_CALENDAR_LABEL = 100;
