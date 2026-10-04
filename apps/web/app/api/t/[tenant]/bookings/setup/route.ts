import { NextResponse } from 'next/server';
import { bookingsConfig, listPromos, listSlots, listUnits, localDate } from '@rag/bookings';
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
  tenant = await requireAdmin(request, tenant, 'bookings:read');
  await requireApplication(tenant, 'bookings');

  // The active promos too (D-097), for the form's picker: any member may
  // read them (promos_select), and a staff member applying one on the phone
  // is a customer availing it (plan § 7 q2).
  const [config, units, slots, promos] = await Promise.all([bookingsConfig(tenant), listUnits(tenant), listSlots(tenant), listPromos(tenant)]);
  // requireApplication passed, so config exists. The null check keeps the type honest.
  if (!config) throw new Error(`"${tenant.slug}" lost its bookings configuration mid-request`);

  return NextResponse.json({
    timezone: config.timezone,
    today: localDate(config.timezone),
    bookingType: config.bookingType,
    currency: config.currency,
    units,
    slots,
    promos,
  });
});
