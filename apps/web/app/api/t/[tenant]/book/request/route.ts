import { NextResponse } from 'next/server';
import { requestBooking } from '@rag/bookings';
import { requireApplication } from '@/lib/applications';
import { notifyAfter } from '@/lib/notify';
import { allow, clientIp } from '@/lib/rate-limit';
import { badRequest } from '@/lib/route';
import { bookRequestSchema, firstError } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Send a booking request. THE one open write (plan/customer-booking.md
 * Rule 2, § 2.1): no login, like the chat, and it can only ever create
 * `pending` rows that hold nothing (D-070).
 *
 * Three limits, weakest first:
 *   - the honeypot: `website` is hidden from people, so a filled one is a bot;
 *   - a per-IP window in memory (lib/rate-limit.ts), weak on Vercel (R-39);
 *   - request_booking()'s per-contact limit in SQL, the one that holds:
 *     BookingLimitError, a 429 through the one error map.
 *
 * On the CHAT token. The chat token has no insert policy on `bookings`; the
 * only way in is request_booking(), security definer, which checks the
 * token's tenant itself. There is deliberately no requireAdmin(): this route
 * is open by design.
 */
export const POST = withTenantRoute(async (request, { tenant }) => {
  await requireApplication(tenant, 'bookings');

  const parsed = bookRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  const { website, ...input } = parsed.data;
  if (website) return badRequest('The request could not be sent.');

  if (!allow(`${tenant.id}|${clientIp(request)}`)) {
    return NextResponse.json({ error: 'Too many requests from here. Please try again in a few minutes.' }, { status: 429 });
  }

  const made = await requestBooking(tenant, input);
  // Staff hear of it (plan/notifications.md): after the response, never before.
  notifyAfter(tenant);
  return NextResponse.json(made, { status: 201 });
});
