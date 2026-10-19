import 'server-only';

// A per-IP limit on the one open write, POST /api/t/<slug>/book/request
// (plan/customer-booking.md § 2.1).
//
// IN MEMORY, so it is per server process. On Vercel that means per instance,
// and a determined sender who lands on several instances gets several
// allowances (R-39). It is the weak limit on purpose: the real one is in SQL,
// request_booking()'s MAX_OPEN_REQUESTS_PER_CONTACT, which holds whoever
// calls. This one only slows a script hammering one instance, before any
// database work.
//
// Fixed windows, keyed by tenant and IP. Entries are dropped once their window
// has passed, so the map cannot grow without bound from one-off visitors.

const WINDOW_MS = 10 * 60 * 1000;
/** Requests per IP per tenant per 10 minutes. Policy, not a measurement. */
export const MAX_REQUESTS_PER_WINDOW = 10;

const windows = new Map<string, { start: number; count: number }>();

/**
 * The caller's IP: the first X-Forwarded-For entry, which Vercel sets, or
 * "local" when there is none (pnpm dev). A client can send its own
 * X-Forwarded-For; behind Vercel the platform's value comes first. Locally it
 * is trusted as sent, which only matters for testing this limit.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || 'local';
}

/** true if this call is inside the limit (and counts it), false if it is over. `max` is per key's own policy (voice allows more, D-134). */
export function allow(key: string, now: number = Date.now(), max: number = MAX_REQUESTS_PER_WINDOW): boolean {
  if (windows.size > 10_000) {
    for (const [k, w] of windows) if (now - w.start >= WINDOW_MS) windows.delete(k);
  }
  const current = windows.get(key);
  if (!current || now - current.start >= WINDOW_MS) {
    windows.set(key, { start: now, count: 1 });
    return true;
  }
  if (current.count >= max) return false;
  current.count++;
  return true;
}
