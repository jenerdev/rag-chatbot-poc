import { NextResponse } from 'next/server';
import { getAccommodation, updateAccommodation } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { badRequest, parseId } from '@/lib/route';
import { firstError, updateAccommodationSchema } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// null from @rag/bookings means "not this tenant's OR not there", and the 404
// below says the same for both, so room ids cannot be enumerated across
// tenants. There is no DELETE: a room is retired with `active: false`, and
// the bookings that name it keep it.

const notFound = (id: number) => NextResponse.json({ error: `No room with id ${id}` }, { status: 404 });

export const GET = withTenantRoute<{ id: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant, 'rooms:read');
  await requireApplication(tenant, 'bookings');
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid room id');

  const room = await getAccommodation(tenant, id);
  return room ? NextResponse.json(room) : notFound(id);
});

/** Change any of name, description, capacity, order; `active: false` retires the room. */
export const PATCH = withTenantRoute<{ id: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant, 'rooms:write');
  await requireApplication(tenant, 'bookings');
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid room id');

  const parsed = updateAccommodationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));

  const room = await updateAccommodation(tenant, id, parsed.data);
  return room ? NextResponse.json(room) : notFound(id);
});
