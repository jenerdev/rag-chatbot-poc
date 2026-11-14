import { NextResponse } from 'next/server';
import { fullNights } from '@rag/bookings';
import { requireApplication } from '@/lib/applications';
import { allowSpend, clientIp, QUOTE_REQUESTS_PER_WINDOW } from '@/lib/rate-limit';
import { badRequest } from '@/lib/route';
import { bookNightsSchema, firstError } from '@/lib/schemas';
import { requireFeature } from '@/lib/feature-flags';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * D-177 (audit E-6): the nights of the booking window on which nothing of the
 * slot is free, for the date picker. OPEN like book/quote, read-only, on the
 * chat token, and on the SAME allowance (D-162).
 */
export const POST = withTenantRoute(async (request, { tenant }) => {
  await requireApplication(tenant, 'bookings');
  await requireFeature(tenant, 'booking_page');

  const parsed = bookNightsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  if (!(await allowSpend(tenant, 'quote', clientIp(request), QUOTE_REQUESTS_PER_WINDOW))) {
    return NextResponse.json({ error: 'Too many price checks from here. Please wait a few minutes and try again.' }, { status: 429 });
  }

  return NextResponse.json({ full: await fullNights(tenant, parsed.data) });
});
