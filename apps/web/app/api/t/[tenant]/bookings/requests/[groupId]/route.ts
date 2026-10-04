import { NextResponse } from 'next/server';
import { confirmRequest, declineRequest } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { badRequest } from '@/lib/route';
import { decideRequestSchema, firstError } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Confirm or decline a whole request: `{ "action": "confirm" }` or
 * `{ "action": "decline" }`. Every night and unit in ONE statement, so a stay
 * is never half confirmed (plan/customer-booking.md § 2.6).
 *
 *   200  done (and done again: confirming a confirmed request is still 200)
 *   404  not this tenant's, not there, or already decided the other way;
 *        deliberately one answer, so request ids cannot be probed
 *   409  a night was confirmed for another booking; nothing changed
 *        (bookings_no_overlap's 23P01, through the one error map)
 */
export const PATCH = withTenantRoute<{ groupId: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant, 'bookings:write');
  await requireApplication(tenant, 'bookings');

  const parsed = decideRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));

  const done =
    parsed.data.action === 'confirm'
      ? await confirmRequest(tenant, params.groupId, parsed.data.note)
      : await declineRequest(tenant, params.groupId, parsed.data.note);
  if (!done) return NextResponse.json({ error: 'No such request' }, { status: 404 });
  return NextResponse.json({ status: parsed.data.action === 'confirm' ? 'confirmed' : 'cancelled' });
});
