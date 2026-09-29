import { NextResponse } from 'next/server';
import { removeCalendarDay } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Remove a holiday: `DELETE /api/t/<slug>/holidays/2026-12-24`. Counted, not
 * trusted: 404 when nothing was removed, whether the day is another tenant's
 * or not there. A booking already stored keeps its price (§ 2.3).
 */
export const DELETE = withTenantRoute<{ day: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant, 'holidays:write');
  await requireApplication(tenant, 'bookings');

  if (!(await removeCalendarDay(tenant, params.day))) {
    return NextResponse.json({ error: `No holiday on ${params.day}` }, { status: 404 });
  }
  return NextResponse.json({ removed: true });
});
