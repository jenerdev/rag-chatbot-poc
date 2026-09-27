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
// § 10, § 11): change them together. Phase 4 sets MAX_IMAGE_BYTES and
// MAX_IMAGE_EDGE from a real phone photo after the browser resize.
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGES_PER_UNIT = 6;
export const MAX_IMAGE_EDGE = 1600;
export const IMAGE_BUCKET = 'unit-images';
