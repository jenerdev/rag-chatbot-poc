import { NextResponse } from 'next/server';
import { LOGIN_FAILED, checkStaffLogin, clearSessionCookie, requireAdmin, setSessionCookie } from '@/lib/admin-auth';
import { badRequest } from '@/lib/route';
import { adminLoginSchema, firstError } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Log in: an email and password, for a member of THIS tenant, become a
 * session cookie (auth-rls Phase 5).
 *
 * The password goes to Supabase Auth and nowhere else: never logged, echoed
 * or stored. Every way of failing (a wrong password, an unknown email, an
 * account that is not a member here) is the same 401 with the same words.
 * The cookie is scoped to `/api/t/<slug>`, so the browser does not send it
 * to any other tenant's routes.
 */
export const POST = withTenantRoute(async (request, { tenant }) => {
  const parsed = adminLoginSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));

  const userId = await checkStaffLogin(tenant, parsed.data.email, parsed.data.password);
  if (!userId) return NextResponse.json({ error: LOGIN_FAILED }, { status: 401 });
  return setSessionCookie(NextResponse.json({ admin: true, tenant: tenant.slug }), tenant, userId);
});

/**
 * Is this browser logged in as a member of this tenant, and as WHAT? Lets
 * the admin page choose between the login form and the list, and hide what
 * the role cannot do (lib/permissions.ts). It re-checks the membership, the
 * same way every admin route does, so a removed member sees the login form,
 * not a list that fails row by row, and a demoted one sees fewer buttons on
 * the next load. The role in the answer is a courtesy to the screen; every
 * route decides for itself.
 */
export const GET = withTenantRoute(async (request, { tenant }) => {
  try {
    const { role } = await requireAdmin(request, tenant, 'session');
    return NextResponse.json({ admin: true, role });
  } catch (error) {
    // Only "not logged in" becomes false. A database error is still an
    // error, with its real message (architecture.md § 9).
    if ((error as { status?: number }).status === 401) return NextResponse.json({ admin: false });
    throw error;
  }
});

/** Log out. It always succeeds, because clearing a cookie that is not there is not an error. */
export const DELETE = withTenantRoute(async (_request, { tenant }) => {
  return clearSessionCookie(NextResponse.json({ admin: false }), tenant);
});
