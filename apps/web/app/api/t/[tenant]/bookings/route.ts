import { NextResponse } from 'next/server';
import { createBooking, listBookings } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { badRequest } from '@/lib/route';
import { createBookingSchema, firstError } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Every handler under bookings/ opens with the same three steps, in this order:
//   withTenantRoute    the slug is a real tenant, or 404
//   requireAdmin       this tenant's admin, or 401 (guest data lives here)
//   requireApplication the tenant has bookings switched on, or 404
// Admin before application, so a stranger gets the same 401 whether or not
// the tenant has bookings. Then @rag/bookings does the rest, and anything it
// throws (400, 409, 404) is mapped by withRoute().

/**
 * The bookings from `from` to `to` (default: `from`), with guest data.
 * `GET /api/t/<slug>/bookings?from=2026-10-01&to=2026-10-31`
 */
export const GET = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant);
  await requireApplication(tenant, 'bookings');

  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  if (!from) return badRequest('A from date is required, e.g. ?from=2026-10-01');
  const to = url.searchParams.get('to') ?? undefined;

  return NextResponse.json(await listBookings(tenant, { from, to }));
});

/** Book a slot. 201 with the booking, 409 if the span is taken, 400 on bad input. */
export const POST = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant);
  await requireApplication(tenant, 'bookings');

  const parsed = createBookingSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));

  return NextResponse.json(await createBooking(tenant, parsed.data), { status: 201 });
});
