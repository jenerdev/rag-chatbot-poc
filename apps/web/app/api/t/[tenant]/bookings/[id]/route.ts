import { NextResponse } from 'next/server';
import { cancelBooking, confirmBooking } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { badRequest, parseId } from '@/lib/route';
import { bookingActionSchema, firstError } from '@/lib/schemas';
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
 * Confirm or cancel a booking (D-095, D-096): `{ action: "confirm" | "cancel",
 * note? }`. A staff booking is born pending and holds nothing until it is
 * confirmed; a clash with a confirmed booking is the 409 bookings_no_overlap
 * raises, mapped in lib/route.ts. The note is what staff wrote with the
 * decision, shown on the row. DELETE above still cancels, with no note.
 * The same 404 for "not this tenant's" and "not there".
 */
export const PATCH = withTenantRoute<{ id: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant, 'bookings:write');
  await requireApplication(tenant, 'bookings');
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid booking id');
  const parsed = bookingActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));

  const done =
    parsed.data.action === 'confirm' ? await confirmBooking(tenant, id, parsed.data.note) : await cancelBooking(tenant, id, parsed.data.note);
  if (!done) return NextResponse.json({ error: `No booking with id ${id}` }, { status: 404 });
  return NextResponse.json({ status: parsed.data.action === 'confirm' ? 'confirmed' : 'cancelled' });
});
