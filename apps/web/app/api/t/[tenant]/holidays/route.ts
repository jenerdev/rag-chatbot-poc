import { NextResponse } from 'next/server';
import { listCalendar, setCalendarDay } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { badRequest } from '@/lib/route';
import { firstError, holidaySchema } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The holiday calendar (plan/customer-booking.md § 2.3), for the staff
 * screen. `GET ?from=&to=` lists it (default: today to a year out; past
 * dates allowed, so last year's can be copied). `PUT` adds a day or changes
 * the one on that date.
 *
 * Staff only here. The public page reads the calendar too, but through
 * bookingPage() in its Server Component, not over this route.
 */
export const GET = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant);
  await requireApplication(tenant, 'bookings');

  const url = new URL(request.url);
  const from = url.searchParams.get('from') ?? undefined;
  const to = url.searchParams.get('to') ?? undefined;
  return NextResponse.json(await listCalendar(tenant, { from, to }));
});

export const PUT = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant);
  await requireApplication(tenant, 'bookings');

  const parsed = holidaySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  return NextResponse.json(await setCalendarDay(tenant, parsed.data));
});
