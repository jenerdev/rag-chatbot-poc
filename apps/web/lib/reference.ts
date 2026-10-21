// reference.ts — a booking reference's two halves, for the Manage booking
// lookup (D-144). Pure, browser-safe, tested.
//
// The shape is written ONCE, in SQL: `booking_reference()` makes
// "<PREFIX>-<CODE>", the prefix the first three letters of the tenant's slug
// in upper case padded with X, the code six characters from an alphabet
// with no 0, O, 1, I, L or 8 (schema-staff-requests.sql, D-100). The lookup
// shows the prefix and takes only the code, so a guest types six characters,
// never "ALT-". These two functions mirror that rule for the page; if the
// SQL rule changes, they change with it, and the test says so.

/** "ALT" for "alteza", "VIL" for "villa", "AXX" for "a-1". */
export function referencePrefix(slug: string): string {
  return (slug.replace(/[^a-zA-Z]/g, '') + 'XXX').slice(0, 3).toUpperCase();
}

/**
 * The six-character code a guest meant, from whatever they typed or pasted:
 * upper-cased, the tenant's own prefix and its dash dropped when the text
 * starts with them (a whole reference pasted from the receipt), anything
 * but letters and digits dropped, at most six characters.
 */
export function referenceCode(text: string, prefix: string): string {
  let s = text.toUpperCase();
  if (s.startsWith(`${prefix}-`)) s = s.slice(prefix.length + 1);
  else if (s.startsWith(prefix) && s.length > prefix.length) s = s.slice(prefix.length);
  return s.replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

/** The whole reference the server is asked for, or '' while the code is empty. */
export function fullReference(prefix: string, code: string): string {
  return code ? `${prefix}-${code}` : '';
}
