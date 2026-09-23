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
