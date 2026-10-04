import { NextResponse } from 'next/server';
import { cancelBooking, confirmBooking } from '@rag/bookings';
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
  tenant = await requireAdmin(request, tenant, 'bookings:write');
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

/**
 * Confirm a booking (D-095): `{ "action": "confirm" }`. A staff booking is
 * born pending and holds nothing until this; a clash with a confirmed
 * booking is the 409 bookings_no_overlap raises, mapped in lib/route.ts.
 * The same 404 for "not this tenant's" and "not there".
 */
export const PATCH = withTenantRoute<{ id: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant, 'bookings:write');
  await requireApplication(tenant, 'bookings');
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid booking id');
  const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
  if (body?.action !== 'confirm') return badRequest('Action must be "confirm"');

  const confirmed = await confirmBooking(tenant, id);
  if (!confirmed) return NextResponse.json({ error: `No booking with id ${id}` }, { status: 404 });
  return NextResponse.json({ confirmed: true });
});
