import { NextResponse } from 'next/server';
import { setPasswordWithToken } from '@rag/db';
import { badRequest } from '@/lib/route';
import { firstError, setPasswordSchema } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Set a new password, from the reset page (or an invite link).
 *
 * The access token is the one Supabase put in the link's fragment. The reset
 * page read it and sends it here once. It is the proof that the person
 * clicked a link sent to that inbox, and it is never stored.
 *
 * This logs nobody in. A new password is followed by a normal login, which
 * is where the membership for THIS tenant is checked.
 */
export const POST = withTenantRoute(async (request) => {
  const parsed = setPasswordSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));

  await setPasswordWithToken(parsed.data.accessToken, parsed.data.password);
  return NextResponse.json({ message: 'Password set. You can log in with it now.' });
});
