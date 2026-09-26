import { NextResponse } from 'next/server';
import { listUnanswered } from '@rag/pipeline';
import { requireAdmin } from '@/lib/admin-auth';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The questions this tenant's documents could not answer, newest first.
 *
 * Admin only. They are visitors' own words, so they are staff data, like the
 * bookings list, even though the chat token's policy could read them.
 */
export const GET = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant);
  return NextResponse.json(await listUnanswered(tenant));
});
