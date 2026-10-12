// attention.ts — what the staff frame does with the three counts that wait
// on staff (plan/notifications.md Phase 1): the sidebar's badges, the tab
// title's "(n)", and the words a rise is announced in. Pure and
// browser-safe, like nav-items.ts, so it is tested without a browser.
//
// A count shown here is a courtesy, like a nav link: every page behind it
// asks requireAdmin() for its permission again.

import { can, type Role } from './permissions';

/** The attention route's body: GET /api/t/<slug>/admin/attention. */
export interface Attention {
  requests: number;
  proofs: number;
  changes: number;
}

/** How often an open, visible staff tab asks (§ 7 q1: polling, not Realtime). */
export const ATTENTION_POLL_MS = 30_000;

/**
 * The counts a role is told about, by page: requests and change requests on
 * Bookings (anyone who reads bookings), proofs on Payments (anyone who
 * reads payments). `total` is what the tab title shows.
 */
export function attentionFor(counts: Attention, role: Role | null): { bookings: number; payments: number; total: number } {
  const bookings = role && can(role, 'bookings:read') ? counts.requests + counts.changes : 0;
  const payments = role && can(role, 'payments:read') ? counts.proofs : 0;
  return { bookings, payments, total: bookings + payments };
}

/** "(3) Bookings · Villa" while 3 wait; the title as it was when none do. Never stacks a second "(n)". */
export function titleWithCount(title: string, n: number): string {
  const bare = title.replace(/^\(\d+\) /, '');
  return n > 0 ? `(${n}) ${bare}` : bare;
}

/**
 * What ROSE between two reads, in words, for the toast. The first read
 * (prev null) announces nothing: a count that was already there when the
 * page opened is not news. A fall (a request decided in another tab) says
 * nothing either.
 */
export function risen(prev: Attention | null, next: Attention, role: Role | null): string[] {
  if (prev === null || role === null) return [];
  const out: string[] = [];
  const up = (key: keyof Attention) => Math.max(0, next[key] - prev[key]);
  if (can(role, 'bookings:read')) {
    const r = up('requests');
    if (r > 0) out.push(r === 1 ? 'New booking request' : `${r} new booking requests`);
    const c = up('changes');
    if (c > 0) out.push(c === 1 ? 'A guest asks to change a stay' : `${c} guests ask to change a stay`);
  }
  if (can(role, 'payments:read')) {
    const p = up('proofs');
    if (p > 0) out.push(p === 1 ? 'A proof of payment to verify' : `${p} proofs of payment to verify`);
  }
  return out;
}
