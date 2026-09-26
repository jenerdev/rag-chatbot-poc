import { NextResponse } from 'next/server';
import { requestPasswordReset } from '@rag/db';
import { badRequest } from '@/lib/route';
import { firstError, passwordResetSchema } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * "Forgot password?" Ask Supabase Auth to email a reset link.
 *
 * The answer is the same whether or not the email has an account, so this
 * cannot be used to list who has one. The link comes back to this tenant's
 * reset page, which must be allowed in Supabase: Auth → URL Configuration →
 * Redirect URLs (for local work, `http://localhost:3000/t/*\/admin/reset`).
 *
 * Supabase's built-in sender is rate-limited and meant for testing. Real
 * staff need custom SMTP first (plan/auth-rls.md § 2.6).
 */
export const POST = withTenantRoute(async (request, { tenant }) => {
  const parsed = passwordResetSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));

  const redirectTo = `${new URL(request.url).origin}/t/${tenant.slug}/admin/reset`;
  await requestPasswordReset(parsed.data.email, redirectTo);
  return NextResponse.json({
    message: 'If that email has a staff account, a reset link is on its way. It expires in an hour.',
  });
});
