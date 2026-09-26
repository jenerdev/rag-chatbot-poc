import { NextResponse } from 'next/server';
import { cancelBooking } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { badRequest, parseId } from '@/lib/route';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Cancel a booking. DELETE is the verb because, to the client, the booking is
 * gone. The row is kept with status 'cancelled', because the history of who
 * booked is the tenant's record, and a cancelled row frees its slot anyway.
 */
export const DELETE = withTenantRoute<{ id: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant);
  await requireApplication(tenant, 'bookings');
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid booking id');

  // false means "not this tenant's OR not there", and the 404 says the same
  // thing for both. Anything else would let one tenant enumerate another's
  // booking ids.
  const cancelled = await cancelBooking(tenant, id);
  if (!cancelled) return NextResponse.json({ error: `No booking with id ${id}` }, { status: 404 });
  return NextResponse.json({ cancelled: true });
});
