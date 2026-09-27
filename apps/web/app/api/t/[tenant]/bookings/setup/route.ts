import { NextResponse } from 'next/server';
import { bookingsConfig, listSlots, listUnits, localDate } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What the booking form needs: the units, the slots, the timezone, today's
 * date IN that timezone, and how this tenant books (`bookingType`, and the
 * `currency` its prices are shown in). Units include inactive ones, marked
 * `active: false`, because the booking list still names them; the form offers
 * only the active ones.
 *
 * `today` is computed on the server from the tenant's timezone, not from the
 * browser's clock. A staff member on a laptop set to another timezone would
 * otherwise default the form to the wrong day (plan/bookings.md § 2.3).
 */
export const GET = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant);
  await requireApplication(tenant, 'bookings');

  const [config, units, slots] = await Promise.all([bookingsConfig(tenant), listUnits(tenant), listSlots(tenant)]);
  // requireApplication passed, so config exists. The null check keeps the type honest.
  if (!config) throw new Error(`"${tenant.slug}" lost its bookings configuration mid-request`);

  return NextResponse.json({
    timezone: config.timezone,
    today: localDate(config.timezone),
    bookingType: config.bookingType,
    currency: config.currency,
    units,
    slots,
  });
});
