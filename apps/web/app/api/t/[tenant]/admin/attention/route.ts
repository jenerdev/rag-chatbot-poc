import { NextResponse } from 'next/server';
import { attentionCounts } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { hasApplication } from '@/lib/applications';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What waits on staff now (plan/notifications.md Phase 1): three numbers,
 * polled every 30 s by each open, visible staff tab for the sidebar's
 * badges, the tab title and the chime. Any member (`dashboard:read`, the
 * same counts the dashboard shows). A tenant without bookings has nothing
 * to wait on: zeros, without a query.
 */
export const GET = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'dashboard:read');
  const counts = (await hasApplication(tenant, 'bookings')) ? await attentionCounts(tenant) : { requests: 0, proofs: 0, changes: 0 };
  return NextResponse.json(counts, { headers: { 'Cache-Control': 'no-store' } });
});
