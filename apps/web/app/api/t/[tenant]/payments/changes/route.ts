import { NextResponse } from 'next/server';
import { listChanges } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** S-14's Change requests: `?which=open` (default) or `all`. Any member reads. */
export const GET = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'payments:read');
  await requireApplication(tenant, 'bookings');
  const which = new URL(request.url).searchParams.get('which') === 'all' ? 'all' : 'open';
  return NextResponse.json(await listChanges(tenant, which));
});
