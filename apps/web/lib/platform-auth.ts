import 'server-only';
import { NextResponse } from 'next/server';
import { anonClient, platformClient, signInStaff } from '@rag/db';
import type { DbClient } from '@rag/db';
import { sessionLive, signSessionPayload, verifySessionPayload } from './admin-auth';
import { WINDOW_SECONDS, authLimits, platformAuthKeys, type AuthScope } from './rate-limit';
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
// D-163 (audit S-6): 4 hours, not the staff session's 12. This cookie reaches
// EVERY tenant's record and members, so a forgotten tab or a copied cookie
// should end sooner; a super user's work is occasional, and logs in again.
const SESSION_MS = 4 * 60 * 60 * 1000;

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

/**
 * The user and session in this request's platform cookie, or null. Genuine and
 * unexpired says nothing about the rows; requirePlatform() asks those. Since
 * D-163 the payload carries the session id (`platform.<user>.<expiry>.<session>`),
 * so a cookie from before it has one part fewer and is refused: log in again.
 */
export function readPlatformSessionCookie(request: Request): { userId: string; sessionId: string } | null {
  const cookie = request.headers.get('cookie') ?? '';
  const raw = cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${PLATFORM_COOKIE}=`))
    ?.slice(PLATFORM_COOKIE.length + 1);
  if (!raw) return null;
  const [kind, userId, expiry, sessionId, mac, ...extra] = decodeURIComponent(raw).split('.');
  if (kind !== 'platform' || !userId || !expiry || !sessionId || !mac || extra.length > 0) return null;
  if (!verifySessionPayload(`${kind}.${userId}.${expiry}.${sessionId}`, mac)) return null;
  return Number(expiry) > Date.now() ? { userId, sessionId } : null;
}

/** The user id alone, for the logout note. */
export function readPlatformSession(request: Request): string | null {
  return readPlatformSessionCookie(request)?.userId ?? null;
}

/**
 * Guard a platform handler and hand back the platform context. A 401 unless
 * the request has a genuine platform cookie AND the user still has the row.
 */
export async function requirePlatform(request: Request): Promise<PlatformContext> {
  const session = readPlatformSessionCookie(request);
  if (!session) throw new PlatformAuthError('Platform login required');
  const { userId } = session;
  const db = await platformClient(userId);
  if (!db) throw new PlatformAuthError('This account no longer runs the platform. Log in again.');
  // D-163: the session row is live (not logged out, no new password since).
  if (!(await sessionLive(db, session.sessionId))) throw new PlatformAuthError('Your platform session has ended. Log in again.');
  return { db, userId };
}

/** D-163: a platform login's session row, on the super user's own platform token. */
export async function openPlatformSession(userId: string): Promise<string> {
  const db = await platformClient(userId);
  if (!db) throw new PlatformAuthError('This account does not run the platform.');
  const { data, error } = await db.rpc('session_open', { p_kind: 'platform', p_seconds: SESSION_MS / 1000 });
  if (error) throw new Error(`Could not open the session: ${error.message}`);
  return data;
}

/** D-163: logout revokes this device's platform session. */
export async function closePlatformSession(userId: string, sessionId: string): Promise<void> {
  const db = await platformClient(userId);
  if (!db) return;
  const { error } = await db.rpc('session_close', { p_id: sessionId });
  if (error) throw new Error(`Could not end the session: ${error.message}`);
}

/** Email + password, then the platform_admins row. The user id, or null for every failure alike. */
/**
 * Audit S-2 (D-157): the platform's sign-in or reset, counted per address
 * and per account like a tenant's (lib/rate-limit.ts), through
 * platform_rate_allow() on the publishable key: before a login there is no
 * token to call it with. Throws when the database does not answer (never
 * fail-open, D-137).
 */
export async function allowPlatformAuth(scope: AuthScope, ip: string, email: string): Promise<boolean> {
  const db = anonClient();
  const limits = authLimits(scope);
  const [address, account] = platformAuthKeys(scope, ip, email);
  for (const [key, max] of [[address, limits.address], [account, limits.account]] as const) {
    const { data, error } = await db.rpc('platform_rate_allow', { p_key: key, p_max: max, p_window_seconds: WINDOW_SECONDS });
    if (error) throw new Error(`platform_rate_allow: ${error.message}`);
    if (data !== true) return false;
  }
  return true;
}

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

export function setPlatformCookie(response: NextResponse, userId: string, sessionId: string): NextResponse {
  const expiresAt = Date.now() + SESSION_MS;
  const payload = `platform.${userId}.${expiresAt}.${sessionId}`;
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
