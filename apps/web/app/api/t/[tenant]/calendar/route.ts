import { NextResponse } from 'next/server';
import { bookingsConfig, calendarDayBookings, calendarDays, calendarSlots, isIsoDate, localDate } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { isView, rangeFor } from '@/lib/calendar-range';
import { badRequest } from '@/lib/route';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The staff calendar (S-12, plan/calendar.md, D-103).
 * `GET /api/t/<slug>/calendar?view=month|week|day&date=2026-10-09&unit=12`
 *
 * `view` defaults to month, `date` to the tenant's today, `unit` to every
 * room. The range is the view's (lib/calendar-range.ts: a month is its whole
 * grid). `days` is calendar_days(), one row per date, every state decided in
 * SQL; `slots` (week and day only) is calendar_slots(); `bookings` (day only)
 * is every booking overlapping each slot, with its guest. `today` is the
 * tenant's, so the screen rings the right date whatever the browser's zone.
 *
 * Every role reads it (bookings:read, § 7 q1). No guest, no price.
 */
export const GET = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'bookings:read');
  await requireApplication(tenant, 'bookings');

  const params = new URL(request.url).searchParams;
  const rawView = params.get('view');
  if (rawView !== null && !isView(rawView)) return badRequest(`"${rawView}" is not a view. Use month, week or day.`);
  const view = rawView ?? 'month';
  const rawDate = params.get('date');
  if (rawDate !== null && !isIsoDate(rawDate)) return badRequest(`"${rawDate}" is not a date. Use YYYY-MM-DD.`);
  const config = await bookingsConfig(tenant);
  const date = rawDate ?? localDate(config?.timezone ?? 'Asia/Manila');
  const unitId = params.get('unit') ?? undefined;

  const range = rangeFor(view, date);
  const [{ from, to, today, days }, slots, bookings] = await Promise.all([
    calendarDays(tenant, range, { unitId }),
    view === 'month' ? Promise.resolve(null) : calendarSlots(tenant, range, { unitId }),
    view === 'day' ? calendarDayBookings(tenant, date, { unitId }) : Promise.resolve(null),
  ]);
  return NextResponse.json({ view, date, from, to, today, days, slots, bookings });
});
