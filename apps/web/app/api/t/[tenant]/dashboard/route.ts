import { NextResponse } from 'next/server';
import { tenantDashboard } from '@rag/pipeline';
import { requireAdmin } from '@/lib/admin-auth';
import { requireFeature } from '@/lib/feature-flags';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The tenant's dashboard (D-098): ONE JSON from tenant_dashboard(), for any
 * member (`dashboard:read`). `?days=7|30|90`, clamped by the package. The
 * function asks the membership again and withholds `money` from a staff
 * role, so this route adds nothing to what the database decides. Every
 * tenant has a dashboard: no application is required; a tenant without
 * bookings gets `bookings: null`.
 */
export const GET = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'dashboard:read');
  await requireFeature(tenant, 'dashboard');
  const days = new URL(request.url).searchParams.get('days');
  return NextResponse.json(await tenantDashboard(tenant, days ?? undefined));
});
