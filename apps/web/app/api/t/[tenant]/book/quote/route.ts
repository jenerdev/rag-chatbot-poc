import { NextResponse } from 'next/server';
import { quoteRequest } from '@rag/bookings';
import { requireApplication } from '@/lib/applications';
import { badRequest } from '@/lib/route';
import { bookQuoteSchema, firstError } from '@/lib/schemas';
import { requireFeature } from '@/lib/feature-flags';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The price of a stay, night by night, and whether it is still available.
 * OPEN, like the chat: the booking page calls it before anyone has an
 * account (plan/customer-booking.md § 2.8). Read-only: nothing is written and
 * nothing is held.
 *
 * On the CHAT token withTenantRoute hands every request. Units, rates and the
 * calendar are readable by any token of the tenant; no booking row is read,
 * only check_availability's open/taken. Every price is unit_quote() (Rule 3).
 */
export const POST = withTenantRoute(async (request, { tenant }) => {
  await requireApplication(tenant, 'bookings');
  await requireFeature(tenant, 'booking_page');

  const parsed = bookQuoteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));

  return NextResponse.json(await quoteRequest(tenant, parsed.data));
});
