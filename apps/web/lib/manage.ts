// manage.ts — what the Manage booking routes say, in one place
// (plan/manage-booking.md). Browser-safe: no imports.

/**
 * Every miss on a guest route, whatever its reason (no such reference, the
 * wrong contact, a stay with no contact on file, a locked reference), in
 * the same words (plan Rule 4): telling them apart would tell a stranger
 * which references exist.
 */
export const MANAGE_NOT_FOUND =
  'We could not find that booking. Check the reference and the email or mobile number you booked with.';
