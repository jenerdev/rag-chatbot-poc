import type { TenantContext } from '@rag/pipeline';

// The per-IP limit on the open routes: the booking request, the Manage
// booking doors, the two voice routes and the chat (plan/rate-limit.md,
// D-137).
//
// The count is POSTGRES'S, not this process's. It used to be a Map in here,
// which on Vercel meant one count per instance, so a sender spread across
// instances got several allowances (R-39, "the weak limit"). Now every call
// is one statement, rate_allow() (schema-rate-limit.sql): bump this key's
// current window and say whether the call is inside the limit. Every
// instance sees the same row, the row lock serialises two bumps at once, and
// there is no "read the count, then write it" (trap 8). The table has no
// policy for any token; the function is the only way to it, and it refuses
// a tenant id that is not the token's (Rule 2: two walls).
//
// The database unreachable means the call THROWS, and the route answers 500
// through the one error map (Rule 4). There is no catch → true: every route
// this guards needs the database a line later anyway, and an opened limit
// under strain is the worst moment to have one.
//
// Fixed windows, keyed by tenant and IP (and by scope, so a Manage lookup
// does not spend the booking page's allowance). The function sweeps the
// tenant's stale windows itself, so the table cannot grow without bound from
// one-off visitors.
//
// No `server-only` import, on purpose: this file holds no secret and no
// client. It is handed the tenant's own token client by a Route Handler, and
// does nothing without one; leaving the marker off is what lets vitest load
// it (rate-limit.test.ts), as it does the other pure lib files.

/** The window every key is counted in. The function builds the bin from it, so every instance bins alike. */
export const WINDOW_SECONDS = 10 * 60;
/** Requests per IP per tenant per 10 minutes, on a booking or Manage request. Policy, not a measurement. */
export const MAX_REQUESTS_PER_WINDOW = 10;
/** Chat turns per IP per tenant per 10 minutes: one every twenty seconds, more than a person types (§ 7 q1). Policy. */
export const CHAT_REQUESTS_PER_WINDOW = 30;
/**
 * Calls per TENANT per 10 minutes across every address, on the routes that
 * spend OpenAI money (the chat and the two voice routes): one a second, more
 * than a small resort's visitors send together, and the ceiling a caller
 * rotating addresses meets (R-53, § 7 q2). Policy.
 */
export const TENANT_CEILING_PER_WINDOW = 600;

/**
 * The caller's IP: the first X-Forwarded-For entry, which Vercel sets, or
 * "local" when there is none (pnpm dev). A client can send its own
 * X-Forwarded-For; behind Vercel the platform's value comes first. Locally it
 * is trusted as sent, which only matters for testing this limit: a walk
 * sends a fresh address per run, because the count now outlives the process.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || 'local';
}

/** The one thing allow() needs from a tenant: its id (wall 1) and its token's client (wall 2). */
type Limited = Pick<TenantContext, 'id' | 'db'>;

/**
 * true if this call is inside the limit (and counts it), false if it is over.
 * `max` is per key's own policy (voice allows more, D-134). Throws when the
 * database does not answer (Rule 4).
 */
export async function allow(tenant: Limited, key: string, max: number = MAX_REQUESTS_PER_WINDOW): Promise<boolean> {
  const { data, error } = await tenant.db.rpc('rate_allow', {
    p_tenant_id: tenant.id,
    p_key: key,
    p_max: max,
    p_window_seconds: WINDOW_SECONDS,
  });
  if (error) throw new Error(`rate_allow: ${error.message}`);
  return data === true;
}

/**
 * The two limits on a route that spends OpenAI money: this address's window
 * under `scope`, then the tenant's ceiling across every address. The ceiling
 * is bumped only when the address was inside, so a refused address does not
 * eat the tenant's allowance. One sentence for both: the visitor is told to
 * wait either way.
 */
export async function allowSpend(tenant: Limited, scope: string, ip: string, max: number): Promise<boolean> {
  if (!(await allow(tenant, `${scope}|${tenant.id}|${ip}`, max))) return false;
  return allow(tenant, `${scope}|${tenant.id}|*`, TENANT_CEILING_PER_WINDOW);
}
