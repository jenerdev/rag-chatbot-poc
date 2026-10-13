// attention.ts — what the staff frame does with the attention poll
// (plan/notifications.md § 8): the Notifications item's badge, the tab
// title's "(n)", and the words a new arrival is announced in. Pure and
// browser-safe, like nav-items.ts, so it is tested without a browser.
//
// Phase 1 counted what WAITS (requests, proofs, changes) and badged Bookings
// and Payments with it, so opening a notification never cleared a number.
// The number is now what this member has not READ, on one item of its own.
//
// A count shown here is a courtesy, like a nav link: every page behind it
// asks requireAdmin() for its permission again.

/** One notification, as the poll and the Notifications page carry it (@rag/bookings NotificationItem). */
export interface AttentionItem {
  id: number;
  kind: 'request' | 'proof' | 'change';
  reference: string;
  title: string;
  body: string;
  path: string;
  at: string;
  read: boolean;
}

/** The attention route's body: GET /api/t/<slug>/admin/attention. */
export interface Attention {
  /** unread for this member, the last 30 days */
  unread: number;
  /** the newest few, read or not, newest first */
  latest: AttentionItem[];
}

/** How often an open staff tab asks (§ 7 q1: polling, not Realtime). A push asks at once. */
export const ATTENTION_POLL_MS = 30_000;

/** The window event a screen sends after it marks notifications read, so the badge follows at once. */
export const NOTIFICATIONS_CHANGED = 'rag:notifications-changed';

/** "(3) Bookings · Villa" while 3 are unread; the title as it was when none are. Never stacks a second "(n)". */
export function titleWithCount(title: string, n: number): string {
  const bare = title.replace(/^\(\d+\) /, '');
  return n > 0 ? `(${n}) ${bare}` : bare;
}

/**
 * What ARRIVED between two reads, in words, for the toast: the unread rows
 * newer than anything the last read had. The first read (prev null)
 * announces nothing: what was there when the page opened is not news.
 */
export function risen(prev: Attention | null, next: Attention): string[] {
  if (prev === null) return [];
  const seen = Math.max(0, ...prev.latest.map((item) => item.id));
  return next.latest
    .filter((item) => item.id > seen && !item.read)
    .sort((a, b) => a.id - b.id)
    .map((item) => `${item.title} · ${item.body}`);
}
