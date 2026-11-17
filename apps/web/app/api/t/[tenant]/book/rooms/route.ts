import { NextResponse } from 'next/server';
import { roomChoices } from '@rag/bookings';
import { requireApplication } from '@/lib/applications';
import { allowSpend, clientIp, QUOTE_REQUESTS_PER_WINDOW } from '@/lib/rate-limit';
import { badRequest } from '@/lib/route';
import { bookRoomsSchema, firstError } from '@/lib/schemas';
import { requireFeature } from '@/lib/feature-flags';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * D-174 (audit E-3): each room type's lowest night price and free rooms for
 * the chosen slot and dates, before a room is picked: the booking page's
 * room cards. OPEN like book/quote, on the chat token, read-only, and it
 * spends from the SAME allowance as the quote (D-162: 60 per address per 10
 * minutes, the tenant's 600 across addresses).
 */
export const POST = withTenantRoute(async (request, { tenant }) => {
  await requireApplication(tenant, 'bookings');
  await requireFeature(tenant, 'booking_page');

  const parsed = bookRoomsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  if (!(await allowSpend(tenant, 'quote', clientIp(request), QUOTE_REQUESTS_PER_WINDOW))) {
    return NextResponse.json({ error: 'Too many price checks from here. Please wait a few minutes and try again.' }, { status: 429 });
  }

  return NextResponse.json({ rooms: await roomChoices(tenant, parsed.data) });
});
