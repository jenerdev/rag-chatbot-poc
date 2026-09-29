import { NextResponse } from 'next/server';
import { createAccommodation, listAccommodations } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { badRequest } from '@/lib/route';
import { createAccommodationSchema, firstError } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Every handler under accommodations/ opens with the same four steps, in this
// order (plan/booking-types.md § 4):
//   withTenantRoute     the slug is a real tenant, or 404
//   requireAdmin        this tenant's staff, or 401
//   requireApplication  bookings is switched on, or 404
//   @rag/bookings       requirePerRoom: a whole-resort tenant has no rooms, 404
// Admin first, so a stranger gets the same 401 whether or not the tenant books
// by room. Rooms are staff data: descriptions, inactive rooms, prices being set.

/** Every room, active or not, with its rates and photos. */
export const GET = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'rooms:read');
  await requireApplication(tenant, 'bookings');
  return NextResponse.json(await listAccommodations(tenant));
});

/** Add a room. 201 with it. It cannot be booked until it has a rate. */
export const POST = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'rooms:write');
  await requireApplication(tenant, 'bookings');

  const parsed = createAccommodationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));

  return NextResponse.json(await createAccommodation(tenant, parsed.data), { status: 201 });
});
