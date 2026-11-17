import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { signInStaff, staffClient } from '@rag/db';
import type { TenantContext } from '@rag/pipeline';
import { can, type Permission, type Role } from './permissions';
import { loadRoleOverrides } from './role-access';

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
//     <slug>.<user-id>.<expiry-ms>.<session-id>.<hmac-sha256(slug.user-id.expiry.session-id, ADMIN_COOKIE_SECRET)>
//
// The HMAC is what makes the cookie unforgeable. Since D-163 (audit S-6) the
// session id inside it names an `app_sessions` row, and every guarded request
// asks Postgres whether that row is still live (session_valid()): logging out
// revokes the row, a new password revokes every row of the user, so a COPIED
// cookie stops working at once instead of in up to 12 hours. Before, there
// was no session table and the expiry was the only end. Slugs have no dots
// (tenants_slug_shape) and a uuid has none, so `.` is a safe separator.
//
// A request that passes requireAdmin() gets a STAFF context back: a token
// with this user as `sub` and `app_admin`, and the member's ROLE. Postgres's
// app_role() then reads the membership AGAIN on every write, so even a bug
// here cannot write for a non-member, or for a role the policy refuses.
//
// THE PERMISSION IS A REQUIRED ARGUMENT (tenant management Phase 3). Every
// admin route names what it needs, from the one table in lib/permissions.ts,
// and a call that forgets is a compile error, not a route that lets everyone
// in (D-027's argument, applied to roles). Wall 1; Postgres is wall 2.
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

/** HMAC a session payload. Shared with the platform cookie (lib/platform-auth.ts): one secret, one algorithm, two payload kinds. */
export function signSessionPayload(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

/** Constant-time check of a payload's MAC. `timingSafeEqual`, never `===`. */
export function verifySessionPayload(payload: string, mac: string): boolean {
  const expected = Buffer.from(signSessionPayload(payload));
  const given = Buffer.from(mac);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const sign = signSessionPayload;

/** The cookie value for a fresh session. */
export function signSession(slug: string, userId: string, expiresAt: number, sessionId: string): string {
  const payload = `${slug}.${userId}.${expiresAt}.${sessionId}`;
  return `${payload}.${sign(payload)}`;
}

/** The user and session in this request's cookie for THIS tenant: genuine, this tenant's and unexpired; null otherwise. */
export function readSessionCookie(request: Request, tenant: TenantContext): { userId: string; sessionId: string } | null {
  const cookie = request.headers.get('cookie') ?? '';
  const raw = cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${ADMIN_COOKIE}=`))
    ?.slice(ADMIN_COOKIE.length + 1);
  if (!raw) return null;

  // A cookie from before D-163 has four parts, not five, and so is refused
  // here: everyone logs in once more, and from then on has a session row.
  const [slug, userId, expiry, sessionId, mac, ...extra] = decodeURIComponent(raw).split('.');
  if (!slug || !userId || !expiry || !sessionId || !mac || extra.length > 0) return null;

  if (!verifySessionPayload(`${slug}.${userId}.${expiry}.${sessionId}`, mac)) return null;

  return slug === tenant.slug && Number(expiry) > Date.now() ? { userId, sessionId } : null;
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
  return readSessionCookie(request, tenant)?.userId ?? null;
}

/** A 401 carrying the real reason, raised through withRoute's single error map. */
class AdminAuthError extends Error {
  readonly status = 401;
}

/**
 * A 403: logged in, a member, and still not allowed. Names the permission,
 * so the person (a member, who already knows this tenant exists) learns
 * what to ask their owner for. Not a 404: "not yours = not there" is for
 * strangers enumerating ids, not for colleagues.
 */
class PermissionError extends Error {
  readonly status = 403;
}

/** A tenant context on a staff token, plus what the member is. */
export interface StaffContext extends TenantContext {
  role: Role;
  /** the signed-in member: for a filter on their OWN rows (wall 1), never trusted from a request */
  userId: string;
}

/**
 * Guard an admin-only handler, and hand back the STAFF context it runs on.
 *
 * Throws a 401 unless the request has a session for this tenant AND the
 * user is still a member; a 403 if the member's role lacks `permission`.
 * Callers replace their chat context with the result:
 *
 *     tenant = await requireAdmin(request, tenant, 'documents:write');
 *
 * so no line after the guard can reach the database as the chat token by
 * mistake. A throw rather than a returned response, so a guarded handler is
 * one line and cannot forget to `return` it. The role comes from the same
 * membership row Postgres reads inside every policy (plan Rule 4).
 */
export async function requireAdmin(request: Request, tenant: TenantContext, permission: Permission): Promise<StaffContext> {
  const session = readSessionCookie(request, tenant);
  if (!session) throw new AdminAuthError(`Admin login required for "${tenant.slug}"`);
  const { userId } = session;
  const staff = await staffClient(tenant.id, userId);
  if (!staff) throw new AdminAuthError(`This account is no longer a member of "${tenant.slug}". Log in again.`);
  // D-163: the session row, and the tenant's overrides, in one round trip.
  const [live, overrides] = await Promise.all([sessionLive(staff.db, session.sessionId), loadRoleOverrides(tenant)]);
  if (!live) throw new AdminAuthError(`Your session for "${tenant.slug}" has ended. Log in again.`);
  // The tenant's own permissions (D-128): the default, as the platform has changed it. Postgres asks app_can() again.
  if (!can(staff.role, permission, overrides)) {
    throw new PermissionError(`Your role (${staff.role}) may not do this (${permission}) in "${tenant.slug}". An owner can change your role; what each role may do is set by the platform.`);
  }
  return { ...tenant, db: staff.db, role: staff.role, userId };
}

/**
 * May this request's member do that? The NON-THROWING twin of requireAdmin()
 * for a route that stays OPEN to guests (the chat, D-140): false with no
 * session, a stale membership or a role without the permission; the same
 * three questions, from the same membership row. A database error still
 * throws. It hands back no context: the route keeps running as the chat
 * token, and only decides what the reply carries.
 */
export async function sessionCan(request: Request, tenant: TenantContext, permission: Permission): Promise<boolean> {
  const session = readSessionCookie(request, tenant);
  if (!session) return false;
  const staff = await staffClient(tenant.id, session.userId);
  if (!staff) return false;
  const [live, overrides] = await Promise.all([sessionLive(staff.db, session.sessionId), loadRoleOverrides(tenant)]);
  return live && can(staff.role, permission, overrides);
}

/**
 * D-163: is this session row live, for the token's user, kind and tenant?
 * Asked on the member's OWN token (session_valid() reads auth.uid()). A
 * database error throws, like every other read here: never a guess.
 */
export async function sessionLive(db: TenantContext['db'], sessionId: string): Promise<boolean> {
  const { data, error } = await db.rpc('session_valid', { p_id: sessionId });
  if (error) throw new Error(`Could not check the session: ${error.message}`);
  return data === true;
}

/** D-163: a login's session row, on the new member's own token; its id goes in the cookie. */
export async function openStaffSession(tenant: TenantContext, userId: string): Promise<string> {
  const staff = await staffClient(tenant.id, userId);
  if (!staff) throw new AdminAuthError(`This account is not a member of "${tenant.slug}".`);
  const { data, error } = await staff.db.rpc('session_open', { p_kind: 'staff', p_seconds: SESSION_MS / 1000 });
  if (error) throw new Error(`Could not open the session: ${error.message}`);
  return data;
}

/** D-163: logout revokes THIS device's row, so a copy of the cookie dies with it. A former member has no token to do it with; the missing membership refuses them already. */
export async function closeStaffSession(tenant: TenantContext, userId: string, sessionId: string): Promise<void> {
  const staff = await staffClient(tenant.id, userId);
  if (!staff) return;
  const { error } = await staff.db.rpc('session_close', { p_id: sessionId });
  if (error) throw new Error(`Could not end the session: ${error.message}`);
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

/**
 * D-138: a login or logout row in the audit log, written by audit_note() on
 * a STAFF token for this user, so the row names them; Postgres refuses a
 * token with no user. Called after a login succeeded and before a logout.
 * A failed login is NOT noted (plan § 2b.4): at that moment there is no
 * staff token, and Supabase records failed sign-ins itself.
 */
export async function noteSession(tenant: TenantContext, userId: string, action: 'login' | 'logout'): Promise<void> {
  const staff = await staffClient(tenant.id, userId);
  if (!staff) return; // no longer a member: nothing to note, and nothing to refuse
  const { error } = await staff.db.rpc('audit_note', { p_tenant_id: tenant.id, p_action: action });
  if (error) throw new Error(`Could not record the ${action}: ${error.message}`);
}

/** Attach the session cookie, scoped to this tenant's API path. */
export function setSessionCookie(response: NextResponse, tenant: TenantContext, userId: string, sessionId: string): NextResponse {
  const expiresAt = Date.now() + SESSION_MS;
  response.cookies.set(ADMIN_COOKIE, signSession(tenant.slug, userId, expiresAt, sessionId), {
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
