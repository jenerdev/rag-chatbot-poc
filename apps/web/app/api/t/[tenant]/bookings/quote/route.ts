import { NextResponse } from 'next/server';
import { quote } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { badRequest } from '@/lib/route';
import { firstError, quoteSchema } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What these rooms would cost on that date, before booking them. per_room
 * only: a whole-resort tenant gets a 404 (PerRoomOnlyError), because its
 * prices live in its documents, not the database (plan/booking-types.md § 8 q3).
 *
 * The same unit_price() the insert trigger calls, so the preview cannot
 * differ from what is stored (plan Rule 2). A POST because it takes a list.
 */
export const POST = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant);
  await requireApplication(tenant, 'bookings');

  const parsed = quoteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));

  return NextResponse.json(await quote(tenant, parsed.data));
});
