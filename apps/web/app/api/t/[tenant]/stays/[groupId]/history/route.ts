import { NextResponse } from 'next/server';
import { stayHistory } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A stay's history (plan Rule 2): every creation, status change and
 * payment, oldest first, with who did it. booking_events is written by
 * triggers and read by any member; nothing writes it through a route.
 * Another tenant's stay is `[]`, the same as a stay with no events.
 */
export const GET = withTenantRoute<{ groupId: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant, 'bookings:read');
  await requireApplication(tenant, 'bookings');
  return NextResponse.json(await stayHistory(tenant, params.groupId));
});
