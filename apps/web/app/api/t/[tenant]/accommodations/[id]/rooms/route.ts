import { NextResponse } from 'next/server';
import { addUnitRoom, getAccommodation } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { badRequest, parseId } from '@/lib/route';
import { firstError, unitRoomSchema } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Add a physical room to a room type (D-133): `{ "name": "Casa Uno 2" }`.
 * The type takes one more booking per slot and night from then on.
 *
 *   201  the type, with its rooms
 *   400  no name, a name the type already has
 *   404  no such room type here (not this tenant's looks the same)
 */
export const POST = withTenantRoute<{ id: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant, 'rooms:write');
  await requireApplication(tenant, 'bookings');
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid room type id');
  const parsed = unitRoomSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));

  const added = await addUnitRoom(tenant, id, parsed.data.name);
  if (added === null) return NextResponse.json({ error: `No room type with id ${id}` }, { status: 404 });
  return NextResponse.json(await getAccommodation(tenant, id), { status: 201 });
});
