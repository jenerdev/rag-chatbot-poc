import { NextResponse } from 'next/server';
import { checkAdminKey, clearSessionCookie, readSession, setSessionCookie } from '@/lib/admin-auth';
import { badRequest } from '@/lib/route';
import { adminLoginSchema, firstError } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Log in: exchange this tenant's admin key for a session cookie.
 *
 * The key itself is never logged, never echoed, and never stored. It is only
 * checked against the scrypt hash. The cookie is scoped to `/api/t/<slug>`, so
 * the browser does not send it to any other tenant's routes.
 */
export const POST = withTenantRoute(async (request, { tenant }) => {
  const parsed = adminLoginSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));

  const result = await checkAdminKey(tenant, parsed.data.key);
  if (result === 'unset') {
    return NextResponse.json(
      { error: `"${tenant.slug}" has no admin key set. Run: pnpm --filter @rag/db tenant:key -- ${tenant.slug}` },
      { status: 401 },
    );
  }
  if (result === 'wrong') {
    return NextResponse.json({ error: 'That admin key is not correct' }, { status: 401 });
  }
  return setSessionCookie(NextResponse.json({ admin: true, tenant: tenant.slug }), tenant);
});

/** Is this browser logged in as this tenant's admin? Lets the admin page decide between a login form and the list. */
export const GET = withTenantRoute(async (request, { tenant }) => {
  return NextResponse.json({ admin: readSession(request, tenant) });
});

/** Log out. It always succeeds, because clearing a cookie that is not there is not an error. */
export const DELETE = withTenantRoute(async (_request, { tenant }) => {
  return clearSessionCookie(NextResponse.json({ admin: false }), tenant);
});
