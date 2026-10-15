import { NextResponse } from 'next/server';
import { deleteUnitRoom, getAccommodation, updateUnitRoom } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { badRequest, parseId } from '@/lib/route';
import { firstError, unitRoomUpdateSchema } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const notFound = () => NextResponse.json({ error: 'No such room here' }, { status: 404 });

/**
 * Rename a room of a type, or retire it / offer it again (D-133):
 * `{ "name": "Casa Uno by the pool" }`, `{ "active": false }`. Postgres
 * refuses retiring a room with an upcoming booking, or a type's last room,
 * in words (a 400).
 *
 *   200  the type, with its rooms
 *   404  no such room in that type here
 */
export const PATCH = withTenantRoute<{ id: string; roomId: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant, 'rooms:write');
  await requireApplication(tenant, 'bookings');
  const id = parseId(params.id);
  const roomId = parseId(params.roomId);
  if (id === null || roomId === null) return badRequest('Invalid room id');
  const parsed = unitRoomUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));

  if (!(await updateUnitRoom(tenant, id, roomId, parsed.data))) return notFound();
  return NextResponse.json(await getAccommodation(tenant, id));
});

/**
 * Delete a room that was never booked. A booked room is kept by its
 * bookings and is retired instead (a 400 says so).
 *
 *   200  the type, with its rooms
 *   404  no such room in that type here
 */
export const DELETE = withTenantRoute<{ id: string; roomId: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant, 'rooms:write');
  await requireApplication(tenant, 'bookings');
  const id = parseId(params.id);
  const roomId = parseId(params.roomId);
  if (id === null || roomId === null) return badRequest('Invalid room id');

  if (!(await deleteUnitRoom(tenant, id, roomId))) return notFound();
  return NextResponse.json(await getAccommodation(tenant, id));
});
