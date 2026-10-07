// The search on the staff lists that grow (plan/ui-components.md Phase 4):
// Unanswered's questions and the knowledge base's titles. Client-side, over
// the rows already loaded: no route, no query (Rule 3). Pure, so tested.

/** Lower case, accents off ("Paraná" → "parana"), runs of space as one. */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Whether `text` has every word of `query`, in any order, as the start of a
 * word or inside one ("check" finds "check-in"; "in check" finds it too).
 * An empty query matches everything.
 */
export function matches(text: string, query: string): boolean {
  const words = fold(query).split(' ').filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fold(text);
  return words.every((word) => haystack.includes(word));
}

/** How many rows a list shows at first, and how many each "Show more" adds. */
export const PAGE_SIZE = 25;
