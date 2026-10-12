// conversation-words.ts — the words and links of S-16 Conversations (D-115).
//
// Pure, so both screens and the server pages share it and the tests pin it.
// The list's filters live in the URL (days, q, refused): a transcript's Back
// link carries them, so returning to the list finds it as it was left.

/** The windows the list offers; the SQL function says 30 for anything else. */
export const LIST_DAYS = [7, 30, 90] as const;
export type ListDays = (typeof LIST_DAYS)[number];

export interface ListFilters {
  days: ListDays;
  q: string;
  refused: boolean;
}

type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));

/** The filters from a page's searchParams; anything odd is the default. */
export function parseListFilters(params: Params): ListFilters {
  const days = Number(first(params.days));
  return {
    days: (LIST_DAYS as readonly number[]).includes(days) ? (days as ListDays) : 30,
    q: first(params.q).slice(0, 200),
    refused: first(params.refused) === '1',
  };
}

/** The filters as a query string, defaults left out: '' or '?days=7&q=pool'. */
export function listQuery(f: ListFilters): string {
  const p = new URLSearchParams();
  if (f.days !== 30) p.set('days', String(f.days));
  if (f.q.trim() !== '') p.set('q', f.q.trim());
  if (f.refused) p.set('refused', '1');
  const s = p.toString();
  return s ? `?${s}` : '';
}

/**
 * "13 Oct 2026, 14:05" in the TENANT's zone (trap 9), not the browser's: a
 * staff member abroad reads the time the guest wrote at the resort.
 */
export function whenLabel(iso: string, timezone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: timezone });
}

/** "14:05" in the tenant's zone, for a message inside a transcript. */
export function timeLabel(iso: string, timezone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: timezone });
}

/** "1 question" / "3 questions". */
export function questionsLabel(n: number): string {
  return `${n} question${n === 1 ? '' : 's'}`;
}

/** "1 not answered" / "2 not answered". */
export function refusalsLabel(n: number): string {
  return `${n} not answered`;
}
