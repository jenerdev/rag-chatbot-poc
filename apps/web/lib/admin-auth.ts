import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { verifyAdminKey } from '@rag/db';
import type { TenantContext } from '@rag/pipeline';

// Per-tenant admin sessions (plan.md Phase 6, D-028). Hand-rolled on
// node:crypto, with no NextAuth or Supabase Auth, because "no library does a
// step" holds here too.
//
// THE SHAPE
// ---------
// Logging in with a tenant's admin key sets a cookie holding
//
//     <slug>.<expiry-ms>.<hmac-sha256(slug.expiry, ADMIN_COOKIE_SECRET)>
//
// There is no session table. The HMAC is what makes the cookie unforgeable, and
// the expiry inside it is what makes it end.
//
// THE PATH IS PART OF THE SECURITY
// --------------------------------
// The cookie is set with `path: /api/t/<slug>`. A browser sends a cookie only
// to URLs under its path, so villa's cookie never even reaches a request to
// /api/t/northwind/…. (`/api/t/villa` does not path-match `/api/t/villa2`;
// the next character must be `/`.) plan.md said `/t/<slug>`, but the routes
// this cookie guards live under `/api/t/<slug>`, so with that path the cookie
// would never be sent to them.
//
// That path is a courtesy of the browser, not a guarantee. curl sends whatever
// it is given. So readSession() ALSO checks that the slug inside the cookie is
// the tenant in the URL. A valid villa cookie is not a valid northwind cookie.

export const ADMIN_COOKIE = 'rag_admin';

/** How long a login lasts. Long enough for a working session; short enough that a forgotten tab ends. */
const SESSION_MS = 12 * 60 * 60 * 1000;

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

/** The cookie value for a fresh session. Slugs contain no dots (tenants_slug_shape), so `.` is a safe separator. */
export function signSession(slug: string, expiresAt: number): string {
  const payload = `${slug}.${expiresAt}`;
  return `${payload}.${sign(payload)}`;
}

/**
 * Is this request carrying a live admin session for THIS tenant?
 *
 * Three checks, all of which must pass: the HMAC is ours (`timingSafeEqual`,
 * never `===`), the slug inside it is the tenant in the URL, and it has not
 * expired.
 */
export function readSession(request: Request, tenant: TenantContext): boolean {
  const cookie = request.headers.get('cookie') ?? '';
  const raw = cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${ADMIN_COOKIE}=`))
    ?.slice(ADMIN_COOKIE.length + 1);
  if (!raw) return false;

  const [slug, expiry, mac] = decodeURIComponent(raw).split('.');
  if (!slug || !expiry || !mac) return false;

  const expected = Buffer.from(sign(`${slug}.${expiry}`));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;

  return slug === tenant.slug && Number(expiry) > Date.now();
}

/** A 401 carrying the real reason, raised through withRoute's single error map. */
class AdminAuthError extends Error {
  readonly status = 401;
}

/**
 * Guard an admin-only handler. Throws a 401 unless the request has a session
 * for this tenant.
 *
 * A throw rather than a returned response, so a guarded handler is one line and
 * cannot forget to `return` it. `errorResponse()` passes a 401 status through
 * unchanged (lib/route.ts).
 */
export function requireAdmin(request: Request, tenant: TenantContext): void {
  if (!readSession(request, tenant)) {
    throw new AdminAuthError(`Admin login required for "${tenant.slug}"`);
  }
}

/**
 * Check a submitted key against this tenant's stored hash.
 *
 * The hash is selected here and only here, as ONE named column. It never goes
 * into a TenantContext, and never into anything that might be serialised into
 * a response.
 */
export async function checkAdminKey(tenant: TenantContext, key: string): Promise<'ok' | 'wrong' | 'unset'> {
  // ⚠️ THE ONE `@rag/db/service` USE OUTSIDE tools/, until auth-rls Phase 6.
  // This must read tenants.admin_key_hash, and no token can reach that
  // column: `tenants` has no policies, and tenant_public() leaves it out, on
  // purpose. Phase 6 deletes the admin key, this function, and this import.
  //
  // Imported HERE, lazily, not at the top of the file. Every admin route
  // imports this module for requireAdmin(), and a top-level import would
  // construct the service client, which throws on a missing key, for all of
  // them. So only the admin-key login needs SUPABASE_SERVICE_ROLE_KEY, and
  // the web process runs without it otherwise (auth-rls Phase 4).
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Admin-key login needs SUPABASE_SERVICE_ROLE_KEY until auth-rls Phase 6 (staff accounts replace it)');
  }
  const { supabase } = await import('@rag/db/service');
  const { data, error } = await supabase
    .from('tenants')
    .select('admin_key_hash')
    .eq('id', tenant.id)
    .single();
  if (error) throw new Error(`Could not load the admin key: ${error.message}`);
  // NULL = nobody can administer this tenant (default-deny). This is a
  // different message from a wrong key, because a key-less tenant is a setup
  // problem that the person at the keyboard needs to know about.
  if (!data.admin_key_hash) return 'unset';
  return (await verifyAdminKey(key, data.admin_key_hash)) ? 'ok' : 'wrong';
}

/** Attach the session cookie, scoped to this tenant's API path. */
export function setSessionCookie(response: NextResponse, tenant: TenantContext): NextResponse {
  const expiresAt = Date.now() + SESSION_MS;
  response.cookies.set(ADMIN_COOKIE, signSession(tenant.slug, expiresAt), {
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
