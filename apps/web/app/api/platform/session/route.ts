import { NextResponse } from 'next/server';
import { PLATFORM_LOGIN_FAILED, checkPlatformLogin, clearPlatformCookie, requirePlatform, setPlatformCookie } from '@/lib/platform-auth';
import { badRequest, withRoute } from '@/lib/route';
import { adminLoginSchema, firstError } from '@/lib/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The platform session (plan/tenant-management.md § 4.2): the super user's
// login, "am I logged in?", and logout. These three run under withRoute()
// rather than withPlatformRoute(), because they exist BEFORE a session does;
// every other handler under app/api/platform/ starts with withPlatformRoute().

/**
 * Log in as the platform. The password goes to Supabase Auth and nowhere
 * else; then the platform_admins row is read through the platform token
 * itself. Every failure (wrong password, unknown email, a real account that
 * does not run the platform) is one 401 with one message.
 */
export const POST = withRoute(async (request: Request) => {
  const parsed = adminLoginSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));

  const userId = await checkPlatformLogin(parsed.data.email, parsed.data.password);
  if (!userId) return NextResponse.json({ error: PLATFORM_LOGIN_FAILED }, { status: 401 });
  return setPlatformCookie(NextResponse.json({ platform: true }), userId);
});

/** Is this browser the platform? Re-reads the row, so a removed super user sees the login form on the next load. */
export const GET = withRoute(async (request: Request) => {
  try {
    const { userId } = await requirePlatform(request);
    // The id, not the email: the platform token cannot read auth.users, and
    // the id is what the members route takes to add this very account.
    return NextResponse.json({ platform: true, userId });
  } catch (error) {
    if ((error as { status?: number }).status === 401) return NextResponse.json({ platform: false });
    throw error;
  }
});

/** Log out. Always succeeds. */
export const DELETE = withRoute(async () => clearPlatformCookie(NextResponse.json({ platform: false })));
