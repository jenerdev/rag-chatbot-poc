// party-words.ts — D-147 (plan/free-guests.md): the party of a stay as every
// screen prints it, and a tenant's free-guest rule in words.
//
// Browser-safe and pure, like money.ts. The booking page, the staff form, the
// stay page and Manage booking are Client Components and cannot import
// @rag/bookings (server-only), so the two functions the package has
// (validate.ts: partyWords, freeGuestsWords) are written here as well; the
// two test files pin the same strings, so the wording cannot drift.

/** "4 guests + 1 child (free)": the paying guests, then the children who stay free. */
export function partyWords(guests: number, free: number): string {
  const paying = `${guests} ${guests === 1 ? 'guest' : 'guests'}`;
  if (free <= 0) return paying;
  return `${paying} + ${free} ${free === 1 ? 'child' : 'children'} (free)`;
}

/** The rule, one sentence; null when the tenant has none. */
export function freeGuestsWords(freeUpToAge: number | null): string | null {
  if (freeUpToAge === null) return null;
  if (freeUpToAge === 0) return 'Infants under 1 stay free.';
  return `Children aged ${freeUpToAge} and below stay free.`;
}

/** The second count field's label: "Children aged 3 and below", or "Infants under 1". */
export function freeFieldLabel(freeUpToAge: number): string {
  return freeUpToAge === 0 ? 'Infants under 1' : `Children aged ${freeUpToAge} and below`;
}

/** The most free guests one unit may carry: parseRequest() and request_booking() refuse more (0 to 50). */
export const MAX_FREE_GUESTS = 50;
