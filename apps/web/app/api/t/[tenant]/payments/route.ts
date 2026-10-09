import { NextResponse } from 'next/server';
import { listPayments } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * S-14's queue (plan/manage-booking.md Phase 4): `?which=open` (default),
 * the proofs waiting, oldest first; `?which=all`, the latest payments and
 * refunds. Any member reads (payments:read); deciding is payments:write.
 */
export const GET = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'payments:read');
  await requireApplication(tenant, 'bookings');
  const which = new URL(request.url).searchParams.get('which') === 'all' ? 'all' : 'open';
  return NextResponse.json(await listPayments(tenant, which));
});
