import { NextResponse } from 'next/server';
import { requestPasswordReset } from '@rag/db';
import { allowPlatformAuth } from '@/lib/platform-auth';
import { AUTH_LIMITED, clientIp } from '@/lib/rate-limit';
import { badRequest, withRoute } from '@/lib/route';
import { firstError, passwordResetSchema } from '@/lib/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * "Forgot password?" for the platform login. The same answer whether or not
 * the email has an account. The link comes back to /platform/reset, which
 * must be in Supabase's Redirect URLs (for local work,
 * `http://localhost:3000/platform/reset`). Under withRoute(): no session yet.
 */
export const POST = withRoute(async (request: Request) => {
  const parsed = passwordResetSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  // Audit S-2 (D-157): every reset is an email on a capped sender (R-21).
  if (!(await allowPlatformAuth('reset', clientIp(request), parsed.data.email))) {
    return NextResponse.json({ error: AUTH_LIMITED }, { status: 429 });
  }
  await requestPasswordReset(parsed.data.email, `${new URL(request.url).origin}/platform/reset`);
  return NextResponse.json({ message: 'If that email has a platform account, a reset link is on its way. It expires in an hour.' });
});
