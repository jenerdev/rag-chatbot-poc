import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { signInStaff, staffClient } from '@rag/db';
import type { TenantContext } from '@rag/pipeline';

// Staff sessions (auth-rls Phase 5, D-040; the cookie is D-028's).
//
// WHO YOU ARE is Supabase Auth's job: an email and password, checked once at
// login (@rag/db's staff-auth.ts). WHETHER YOU MAY ADMINISTER THIS TENANT is
// ours: a `memberships` row, re-checked on EVERY request, so removing a member
// takes effect on their next click, not when the cookie runs out.
//
// THE SHAPE
// ---------
// Logging in sets a cookie holding
//
//     <slug>.<user-id>.<expiry-ms>.<hmac-sha256(slug.user-id.expiry, ADMIN_COOKIE_SECRET)>
//
// There is no session table. The HMAC is what makes the cookie unforgeable,
// and the expiry inside it is what makes it end. Slugs have no dots
// (tenants_slug_shape) and a uuid has none, so `.` is a safe separator.
//
// A request that passes requireAdmin() gets a STAFF context back: a token
// with this user as `sub` and `app_admin`. Postgres's app_is_admin() then
// checks the membership AGAIN on every write, so even a bug here cannot
// write for a non-member.
//
// THE PATH IS PART OF THE SECURITY
// --------------------------------
// The cookie is set with `path: /api/t/<slug>`. A browser sends a cookie only
// to URLs under its path, so villa's cookie never even reaches a request to
// /api/t/northwind/…. (`/api/t/villa` does not path-match `/api/t/villa2`;
// the next character must be `/`.)
//
// That path is a courtesy of the browser, not a guarantee. curl sends whatever
// it is given. So readSession() ALSO checks that the slug inside the cookie is
// the tenant in the URL. A valid villa cookie is not a valid northwind cookie.

export const ADMIN_COOKIE = 'rag_admin';

/** How long a login lasts. Long enough for a working session; short enough that a forgotten tab ends. */
const SESSION_MS = 12 * 60 * 60 * 1000;

/**
 * The ONE message for every failed login: a wrong password, an unknown email,
 * and a real account that is not a member of this tenant. An attacker learns
 * nothing about which emails exist or who belongs where.
 */
export const LOGIN_FAILED = 'That email and password do not match a staff account for this workspace.';

function secret(): string {
  const value = process.env.ADMIN_COOKIE_SECRET ?? '';
  // withRoute's assertEnv() already guarantees it is set. This guards against a
  // placeholder like "changeme", which would make every cookie forgeable.
  if (value.length < 32) throw new Error('ADMIN_COOKIE_SECRET must be at least 32 characters');
  return value;
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

/** The cookie value for a fresh session. */
export function signSession(slug: string, userId: string, expiresAt: number): string {
  const payload = `${slug}.${userId}.${expiresAt}`;
  return `${payload}.${sign(payload)}`;
}

/**
 * The user id in this request's session cookie for THIS tenant, or null.
 *
 * Three checks, all of which must pass: the HMAC is ours (`timingSafeEqual`,
 * never `===`), the slug inside it is the tenant in the URL, and it has not
 * expired. This says only that the cookie is genuine. Whether the user is
 * still a member is requireAdmin()'s question.
 */
export function readSession(request: Request, tenant: TenantContext): string | null {
  const cookie = request.headers.get('cookie') ?? '';
  const raw = cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${ADMIN_COOKIE}=`))
    ?.slice(ADMIN_COOKIE.length + 1);
  if (!raw) return null;

  // A cookie from before auth-rls Phase 5 has three parts, not four, and so
  // is refused here: everyone logs in again, with an email this time.
  const [slug, userId, expiry, mac, ...extra] = decodeURIComponent(raw).split('.');
  if (!slug || !userId || !expiry || !mac || extra.length > 0) return null;

  const expected = Buffer.from(sign(`${slug}.${userId}.${expiry}`));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  return slug === tenant.slug && Number(expiry) > Date.now() ? userId : null;
}

/** A 401 carrying the real reason, raised through withRoute's single error map. */
class AdminAuthError extends Error {
  readonly status = 401;
}

/**
 * Guard an admin-only handler, and hand back the STAFF context it runs on.
 *
 * Throws a 401 unless the request has a session for this tenant AND the
 * user is still a member. Callers replace their chat context with the result:
 *
 *     tenant = await requireAdmin(request, tenant);
 *
 * so no line after the guard can reach the database as the chat token by
 * mistake. A throw rather than a returned response, so a guarded handler is
 * one line and cannot forget to `return` it.
 */
export async function requireAdmin(request: Request, tenant: TenantContext): Promise<TenantContext> {
  const userId = readSession(request, tenant);
  if (!userId) throw new AdminAuthError(`Admin login required for "${tenant.slug}"`);
  const db = await staffClient(tenant.id, userId);
  if (!db) throw new AdminAuthError(`This account is no longer a member of "${tenant.slug}". Log in again.`);
  return { ...tenant, db };
}

/**
 * Email + password, then the membership. The user id on success, or null,
 * which the route turns into LOGIN_FAILED whatever the reason was.
 */
export async function checkStaffLogin(tenant: TenantContext, email: string, password: string): Promise<string | null> {
  const userId = await signInStaff(email, password);
  if (!userId) return null;
  return (await staffClient(tenant.id, userId)) ? userId : null;
}

/** Attach the session cookie, scoped to this tenant's API path. */
export function setSessionCookie(response: NextResponse, tenant: TenantContext, userId: string): NextResponse {
  const expiresAt = Date.now() + SESSION_MS;
  response.cookies.set(ADMIN_COOKIE, signSession(tenant.slug, userId, expiresAt), {
    httpOnly: true, // no script can read it, so an XSS cannot exfiltrate it
    sameSite: 'lax', // not sent on cross-site POSTs, which is the CSRF half
    secure: process.env.NODE_ENV !== 'development',
    path: `/api/t/${tenant.slug}`,
    expires: new Date(expiresAt),
  });
  return response;
}

/** Expire the cookie. The path must match the one it was set with, or the browser keeps it. */
export function clearSessionCookie(response: NextResponse, tenant: TenantContext): NextResponse {
  response.cookies.set(ADMIN_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV !== 'development',
    path: `/api/t/${tenant.slug}`,
    maxAge: 0,
  });
  return response;
}
