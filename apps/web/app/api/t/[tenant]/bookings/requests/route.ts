import { NextResponse } from 'next/server';
import { listRequests } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Customers' booking requests, one per request (all its nights and units),
 * newest first. `GET /api/t/<slug>/bookings/requests?from=2026-10-01`, from
 * today by default. STAFF ONLY: names, phones and emails.
 *
 * `clash` says a night is now confirmed for another booking, so confirming
 * this one would be refused (plan/customer-booking.md § 2.5).
 */
export const GET = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant);
  await requireApplication(tenant, 'bookings');

  const from = new URL(request.url).searchParams.get('from') ?? undefined;
  return NextResponse.json(await listRequests(tenant, { from }));
});
