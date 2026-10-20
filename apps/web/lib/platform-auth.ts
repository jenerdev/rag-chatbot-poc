import 'server-only';
import { NextResponse } from 'next/server';
import { platformClient, signInStaff } from '@rag/db';
import type { DbClient } from '@rag/db';
import { signSessionPayload, verifySessionPayload } from './admin-auth';
import { withRoute } from './route';

// The platform session: the super user's (plan/tenant-management.md § 2.1, § 4.2).
//
// The same design as the staff session in admin-auth.ts, and deliberately a
// SEPARATE cookie, path and payload kind rather than a flag on the staff one:
//
//   - WHO YOU ARE is Supabase Auth's (email + password, checked once);
//   - WHETHER YOU RUN THE PLATFORM is a `platform_admins` row, re-read on
//     EVERY request through the platform token itself (platformClient()), so
//     super:remove takes effect on the next click;
//   - the cookie is `rag_platform`, path `/api/platform`, so a browser never
//     sends it to a tenant's routes, nor a tenant's cookie here. That path is
//     the browser's courtesy; readPlatformSession() also checks the payload's
//     first field, `platform`, so a staff cookie pasted by hand is refused.
//
// A request that passes requirePlatform() gets a PlatformContext: a client on
// the platform token (app_super, NO tenant_id). Under RLS that client reads
// no document, chunk or booking of anyone; the *_super_* policies open
// tenants, tenant_applications and memberships to it, and each asks Postgres
// for the same row again (app_is_super()). There is no `tenant` in this
// context on purpose: the platform's work has no tenant yet, or has all of them.

export const PLATFORM_COOKIE = 'rag_platform';
export const PLATFORM_API = '/api/platform';
const SESSION_MS = 12 * 60 * 60 * 1000;

/** ONE message for every failed platform login, as LOGIN_FAILED is for staff. */
export const PLATFORM_LOGIN_FAILED = 'That email and password do not match a platform account.';

/** What a platform route runs on. No tenant, by design. */
export interface PlatformContext {
  db: DbClient;
  userId: string;
}

class PlatformAuthError extends Error {
  readonly status = 401;
}

/** The user id in this request's platform cookie, or null. Genuine and unexpired says nothing about the row; requirePlatform() asks that. */
export function readPlatformSession(request: Request): string | null {
  const cookie = request.headers.get('cookie') ?? '';
  const raw = cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${PLATFORM_COOKIE}=`))
    ?.slice(PLATFORM_COOKIE.length + 1);
  if (!raw) return null;
  const [kind, userId, expiry, mac, ...extra] = decodeURIComponent(raw).split('.');
  if (kind !== 'platform' || !userId || !expiry || !mac || extra.length > 0) return null;
  if (!verifySessionPayload(`${kind}.${userId}.${expiry}`, mac)) return null;
  return Number(expiry) > Date.now() ? userId : null;
}

/**
 * Guard a platform handler and hand back the platform context. A 401 unless
 * the request has a genuine platform cookie AND the user still has the row.
 */
export async function requirePlatform(request: Request): Promise<PlatformContext> {
  const userId = readPlatformSession(request);
  if (!userId) throw new PlatformAuthError('Platform login required');
  const db = await platformClient(userId);
  if (!db) throw new PlatformAuthError('This account no longer runs the platform. Log in again.');
  return { db, userId };
}

/** Email + password, then the platform_admins row. The user id, or null for every failure alike. */
export async function checkPlatformLogin(email: string, password: string): Promise<string | null> {
  const userId = await signInStaff(email, password);
  if (!userId) return null;
  return (await platformClient(userId)) ? userId : null;
}

/** D-138: a super user's login or logout, as a platform-wide audit row (no tenant), on the platform token so the row names them. */
export async function notePlatformSession(userId: string, action: 'login' | 'logout'): Promise<void> {
  const db = await platformClient(userId);
  if (!db) return;
  const { error } = await db.rpc('audit_note', { p_tenant_id: null, p_action: action });
  if (error) throw new Error(`Could not record the ${action}: ${error.message}`);
}

export function setPlatformCookie(response: NextResponse, userId: string): NextResponse {
  const expiresAt = Date.now() + SESSION_MS;
  const payload = `platform.${userId}.${expiresAt}`;
  response.cookies.set(PLATFORM_COOKIE, `${payload}.${signSessionPayload(payload)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV !== 'development',
    path: PLATFORM_API,
    expires: new Date(expiresAt),
  });
  return response;
}

export function clearPlatformCookie(response: NextResponse): NextResponse {
  response.cookies.set(PLATFORM_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV !== 'development',
    path: PLATFORM_API,
    maxAge: 0,
  });
  return response;
}

/**
 * Wrap a Route Handler under `app/api/platform/…`: withRoute()'s single error
 * map, then requirePlatform(), so no line of the handler runs without the
 * platform context. Every handler under that directory starts with it
 * (CLAUDE.md rule 3, extended). The session routes, which must run BEFORE a
 * session exists, use withRoute() directly and say so.
 */
export function withPlatformRoute<Params extends Record<string, string> = Record<never, never>>(
  handler: (request: Request, context: { platform: PlatformContext; params: Params }) => Promise<Response>,
): (request: Request, context: { params: Promise<Params> }) => Promise<Response> {
  return withRoute(async (request, { params }: { params: Promise<Params> }) => {
    const platform = await requirePlatform(request);
    return handler(request, { platform, params: await params });
  });
}
