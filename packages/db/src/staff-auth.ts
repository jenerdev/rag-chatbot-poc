// staff-auth.ts — staff sign-in, membership, and password reset (auth-rls Phase 5, D-040).
//
// Supabase Auth holds the passwords. That is the one deliberate exception to
// "hand-roll everything" (D-001, D-028): password storage, reset tokens and
// email verification are exactly where a readable home-made version is also a
// dangerous one. What Supabase does NOT decide is who may administer which
// tenant. That is the `memberships` table, checked here, and again by
// app_is_admin() in Postgres on every write.
//
// Supabase's own sessions are never kept. A sign-in proves the password once,
// the session is revoked straight away, and from then on the request carries
// our HMAC cookie and a server-minted staff token (D-039).
import 'server-only';

import type { AuthError } from '@supabase/supabase-js';
import type { MemberRole } from './database.types.js';
import { anonClient, mintPlatformToken, mintTenantToken, scopedClient, type DbClient } from './tenant-client.js';

/** What staffClient() hands back: the database AS this member, and what the member is. */
export interface StaffSession {
  db: DbClient;
  role: MemberRole;
}

/** An error whose status the web app's single error map passes through (429). */
export class StaffAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// The Supabase errors that mean "these credentials do not open an account".
// All of them become the same null, so the caller shows one message and an
// attacker cannot tell a wrong password from an unknown email (plan § 3 Phase 5).
const NOT_A_LOGIN = new Set(['invalid_credentials', 'email_not_confirmed', 'user_banned']);

function unexpected(what: string, error: AuthError): Error {
  // A rate limit is the one Supabase refusal worth surfacing as itself: it is
  // not about the credentials, and "try again later" is the right advice.
  // There are two, and they need different advice. The EMAIL cap belongs to
  // Supabase's built-in sender and is hourly (observed: an invite plus two
  // reset requests used it up). Custom SMTP is what lifts it
  // (plan/auth-rls.md § 2.6). The sign-in cap is 30 per window (Phase 0).
  if (error.code === 'over_email_send_rate_limit') {
    return new StaffAuthError(
      'The email limit is used up for now (Supabase’s built-in sender allows only a few emails an hour). Try again later, or set up custom SMTP.',
      429,
    );
  }
  if (error.status === 429) return new StaffAuthError('Too many attempts. Wait a few minutes and try again.', 429);
  return new Error(`${what}: ${error.message}`);
}

/**
 * Check an email and password. Returns the user id, or null for ANY
 * credential failure.
 *
 * The session Supabase hands back is revoked before returning (scope
 * `local`: this session only). Nothing here keeps a Supabase refresh token
 * alive that the app would never use.
 */
export async function signInStaff(email: string, password: string): Promise<string | null> {
  const client = anonClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    if (error.code && NOT_A_LOGIN.has(error.code)) return null;
    throw unexpected('Sign-in failed', error);
  }
  const userId = data.user.id;
  await client.auth.signOut({ scope: 'local' });
  return userId;
}

/**
 * A client AS this user, for this tenant, and the user's ROLE there: a staff
 * token with `app_admin`, but only if the membership row exists. Otherwise
 * null.
 *
 * The membership is read THROUGH that token. The `memberships_read_own`
 * policy lets a user see their own rows, so this needs no service key. The
 * same row is what app_role() reads inside every policy, so a user removed
 * or demoted between this check and a write is still refused by Postgres
 * (plan/tenant-management.md Rule 4: the role is a row, never a claim).
 */
export async function staffClient(tenantId: number, userId: string): Promise<StaffSession | null> {
  const db = scopedClient(mintTenantToken({ tenantId, userId, admin: true }));
  const { data, error } = await db
    .from('memberships')
    .select('role')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error(`Could not check the membership: ${error.message}`);
  return data ? { db, role: data.role } : null;
}

/**
 * A client AS the PLATFORM, for this user: a platform token (`app_super`,
 * no tenant), but only if the `platform_admins` row exists. Otherwise null.
 *
 * The same shape as staffClient(): the row is read through the token itself
 * (`platform_admins_read_own`), and app_is_super() demands the same row on
 * every read and write, so removing a super user takes effect on their next
 * request. With no tenant claim this client reads no tenant's documents,
 * chunks or bookings; only the `*_super_*` policies open a table to it.
 */
export async function platformClient(userId: string): Promise<DbClient | null> {
  const db = scopedClient(mintPlatformToken({ userId }));
  const { data, error } = await db.from('platform_admins').select('user_id').eq('user_id', userId).maybeSingle();
  if (error) throw new Error(`Could not check the platform membership: ${error.message}`);
  return data ? db : null;
}

/**
 * Send a password-reset email. Supabase answers the same way for an email it
 * does not know, which is what keeps this from listing accounts. Only a
 * rate limit or an outage is an error.
 *
 * `redirectTo` must be in the project's Auth → URL Configuration → Redirect
 * URLs, or Supabase sends the user to the Site URL instead.
 */
export async function requestPasswordReset(email: string, redirectTo: string): Promise<void> {
  const { error } = await anonClient().auth.resetPasswordForEmail(email, { redirectTo });
  if (error) throw unexpected('Could not send the reset email', error);
}

/**
 * Set a new password with the access token from a recovery or invite link.
 *
 * A raw call to GoTrue's `PUT /auth/v1/user`, not supabase-js's updateUser(),
 * which needs a whole session object (refresh token included) set on a client
 * first. The access token IS the proof the user clicked the link, and it is
 * all this call needs.
 */
export async function setPasswordWithToken(accessToken: string, password: string): Promise<void> {
  const response = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    method: 'PUT',
    headers: {
      apikey: process.env.SUPABASE_PUBLISHABLE_KEY!,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password }),
  });
  if (response.ok) return;
  const body = (await response.json().catch(() => ({}))) as { msg?: string; message?: string; error_description?: string };
  const reason = body.msg ?? body.message ?? body.error_description ?? `HTTP ${response.status}`;
  // 401/403: the link's token is expired or already used. 422: Supabase
  // refused the password itself (too short, same as the old one). Both are
  // the user's to fix, so the message is theirs.
  if (response.status === 401 || response.status === 403) {
    throw new StaffAuthError('That reset link has expired or was already used. Request a new one.', 401);
  }
  if (response.status === 422) throw new StaffAuthError(reason, 400);
  if (response.status === 429) throw new StaffAuthError('Too many attempts. Wait a few minutes and try again.', 429);
  throw new Error(`Could not set the password: ${reason}`);
}
