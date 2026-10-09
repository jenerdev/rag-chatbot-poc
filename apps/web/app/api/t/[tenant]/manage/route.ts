import { NextResponse } from 'next/server';
import { guestStatus, guestStay } from '@rag/bookings';
import { requireApplication } from '@/lib/applications';
import { MANAGE_NOT_FOUND } from '@/lib/manage';
import { allow, clientIp } from '@/lib/rate-limit';
import { badRequest } from '@/lib/route';
import { firstError, manageLookupSchema } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';


/**
 * Look up a stay for the Manage booking page (plan/manage-booking.md,
 * Phase 2). OPEN, like book/request: no login, on the CHAT token, and the
 * only read is guest_stay(), security definer, which checks the token's
 * tenant and returns one stay's guest-facing columns.
 *
 * Two limits, weakest first (plan § 2.2): the per-IP window in memory
 * (lib/rate-limit.ts, its own key so lookups do not spend the booking
 * page's allowance), then guest_stay()'s lockout in SQL, 5 misses per
 * reference per hour, which holds whoever calls.
 *
 * A miss is a 404 with one sentence, the same for a wrong contact, an
 * unknown reference, a stay with no contact on file and a locked reference:
 * telling them apart would tell a stranger which references exist.
 */
export const POST = withTenantRoute(async (request, { tenant }) => {
  await requireApplication(tenant, 'bookings');

  const parsed = manageLookupSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));

  if (!allow(`manage|${tenant.id}|${clientIp(request)}`)) {
    return NextResponse.json({ error: 'Too many lookups from here. Please try again in a few minutes.' }, { status: 429 });
  }

  const stay = await guestStay(tenant, parsed.data.reference, parsed.data.contact);
  if (!stay) return NextResponse.json({ error: MANAGE_NOT_FOUND }, { status: 404 });
  // The word the guest reads ('completed' is derived, plan § 2.6), decided
  // here so the page never re-derives it.
  return NextResponse.json({ stay: { ...stay, guestStatus: guestStatus(stay) } });
});
