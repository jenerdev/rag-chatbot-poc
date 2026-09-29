import { NextResponse } from 'next/server';
import { setPasswordWithToken } from '@rag/db';
import { badRequest, withRoute } from '@/lib/route';
import { firstError, setPasswordSchema } from '@/lib/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Set a super user's password from the invite or reset link that landed on
 * /platform/reset. The access token in the link is the proof; it is sent
 * once and never stored. Runs under withRoute(), not withPlatformRoute():
 * there is no session yet. It logs nobody in: a normal login follows, which
 * is where the platform_admins row is checked.
 */
export const POST = withRoute(async (request: Request) => {
  const parsed = setPasswordSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  await setPasswordWithToken(parsed.data.accessToken, parsed.data.password);
  return NextResponse.json({ message: 'Password set. You can log in with it now.' });
});
