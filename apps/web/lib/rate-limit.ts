import { createHash } from 'node:crypto';
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
 * Audit S-5 (D-162): price quotes per IP per tenant per 10 minutes on the
 * booking page (`book/quote`). The page re-asks 300 ms after each change, so
 * a guest choosing dates, rooms and typing a promo code letter by letter
 * makes 20 to 40; 60 leaves room for a second try. It also caps guessing
 * promo codes by dictionary, with TENANT_CEILING_PER_WINDOW across
 * addresses (allowSpend()), and each quote is up to 70 unit_quote() calls.
 * Policy.
 */
export const QUOTE_REQUESTS_PER_WINDOW = 60;

/**
 * Audit S-2 (D-157): the sign-in and "Forgot password?" doors, staff and
 * platform. Two counts per call, both in the same window: this ADDRESS, and
 * this ACCOUNT (the email, hashed), so a guesser spread over many addresses
 * still meets the account's ceiling. The account count is also a lockout an
 * attacker can cause, for one email at a time and ten minutes at most; that
 * is the price of the ceiling, and the person can still reset. Policy.
 */
export const LOGIN_PER_ADDRESS = 10;
export const LOGIN_PER_ACCOUNT = 10;
/** A reset sends an email: fewer, because each one spends the sender's quota (R-21). */
export const RESET_PER_ADDRESS = 5;
export const RESET_PER_ACCOUNT = 3;

/** The one sentence a refused sign-in or reset gets. It says nothing about whether the account exists. */
export const AUTH_LIMITED = 'Too many attempts. Please wait a few minutes and try again.';

export type AuthScope = 'login' | 'reset';

const AUTH_LIMITS: Record<AuthScope, { address: number; account: number }> = {
  login: { address: LOGIN_PER_ADDRESS, account: LOGIN_PER_ACCOUNT },
  reset: { address: RESET_PER_ADDRESS, account: RESET_PER_ACCOUNT },
};

/**
 * sha256 hex of a value: an email (or, on the platform, an address) is
 * counted, never stored. The email is trimmed and lower-cased first, so
 * "Ann@x.com" and "ann@x.com " are one account, as Supabase Auth treats them.
 */
export function hashed(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

/** The two keys of one tenant sign-in or reset: the address, then the account. */
export function tenantAuthKeys(tenantId: number, scope: AuthScope, ip: string, email: string): [string, string] {
  return [`${scope}|${tenantId}|ip|${ip}`, `${scope}|${tenantId}|acct|${hashed(email)}`];
}

/**
 * The two keys of one platform sign-in or reset. Only hashes, in the shape
 * platform_rate_allow() accepts (schema-platform-rate-limit.sql): that
 * function is callable with the publishable key, so the table holds nothing
 * a caller could read back as an address or an email.
 */
export function platformAuthKeys(scope: AuthScope, ip: string, email: string): [string, string] {
  return [`platform-${scope}|${hashed(`ip|${ip}`)}`, `platform-${scope}|${hashed(`acct|${email}`)}`];
}

/** The limits of a scope, for both doors. */
export function authLimits(scope: AuthScope): { address: number; account: number } {
  return AUTH_LIMITS[scope];
}

/**
 * A tenant's sign-in or reset: the address first, then the account, on the
 * tenant's chat token (rate_allow(), wall 2 as everywhere). The account is
 * counted only when the address was inside, so one noisy address does not
 * spend a real person's allowance. Throws when the database does not answer.
 */
export async function allowAuth(tenant: Limited, scope: AuthScope, ip: string, email: string): Promise<boolean> {
  const [address, account] = tenantAuthKeys(tenant.id, scope, ip, email);
  const limits = authLimits(scope);
  if (!(await allow(tenant, address, limits.address))) return false;
  return allow(tenant, account, limits.account);
}

/**
 * The caller's IP, for every per-IP limit (audit S-8, D-165). Which header
 * may be believed depends on what stands in front of the app, because a
 * client can send ANY header it likes:
 *
 *   - on Vercel (VERCEL=1): the first X-Forwarded-For entry. Vercel fills
 *     that header from the TCP connection and drops what the client sent,
 *     when Vercel is the outermost edge (its "Request headers" docs).
 *   - in development (NODE_ENV not production): the same header, trusted as
 *     sent, because the walks send a fresh address per run (the counts
 *     outlive the process, D-137); "local" with none.
 *   - anywhere else in production (a self-hosted `next start`): ONLY the
 *     header named by CLIENT_IP_HEADER, which the proxy in front sets (e.g.
 *     nginx's x-real-ip). Without it, every caller is "unknown": one shared
 *     count. That fails CLOSED (the limits are stricter, never bypassed);
 *     trusting X-Forwarded-For there would let anyone dodge every limit by
 *     changing the header on each request.
 */
export function clientIpFrom(
  headers: Headers,
  where: { onVercel: boolean; production: boolean; trustedHeader?: string | undefined },
): string {
  const first = (value: string | null) => value?.split(',')[0]?.trim() || null;
  if (where.onVercel || !where.production) return first(headers.get('x-forwarded-for')) ?? 'local';
  if (where.trustedHeader) return first(headers.get(where.trustedHeader)) ?? 'unknown';
  return 'unknown';
}

let warnedUntrusted = false;

/** clientIpFrom() for this request, on this deployment's own environment. */
export function clientIp(request: Request): string {
  const where = {
    onVercel: process.env.VERCEL === '1',
    production: process.env.NODE_ENV === 'production',
    trustedHeader: process.env.CLIENT_IP_HEADER?.trim().toLowerCase() || undefined,
  };
  if (where.production && !where.onVercel && !where.trustedHeader && !warnedUntrusted) {
    warnedUntrusted = true;
    console.warn('[rate-limit] not on Vercel and CLIENT_IP_HEADER is unset: every caller shares ONE per-IP count. Set it to the header your proxy writes (e.g. x-real-ip).');
  }
  return clientIpFrom(request.headers, where);
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
 * The two limits on a route that spends OpenAI money (or, since D-162, the
 * booking page's price quote, which is expensive and probes promo codes): this address's window
 * under `scope`, then the tenant's ceiling across every address. The ceiling
 * is bumped only when the address was inside, so a refused address does not
 * eat the tenant's allowance. One sentence for both: the visitor is told to
 * wait either way.
 */
export async function allowSpend(tenant: Limited, scope: string, ip: string, max: number): Promise<boolean> {
  if (!(await allow(tenant, `${scope}|${tenant.id}|${ip}`, max))) return false;
  return allow(tenant, `${scope}|${tenant.id}|*`, TENANT_CEILING_PER_WINDOW);
}
