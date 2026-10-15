import { NextResponse } from 'next/server';
import { moveOptions, moveStay } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { badRequest, parseId } from '@/lib/route';
import { firstError, roomMoveSchema } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The rooms of this booking's type, and which are free for every night of
 * the stay that would move (D-133). The stay's page draws its "Move to room"
 * choice from it; the PATCH below is still the guard (trap 21).
 *
 *   200  { unit, room, nights, rooms: [{ id, name, current, free }] }
 *   404  no such booking here (not this tenant's looks the same)
 */
export const GET = withTenantRoute<{ id: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant, 'bookings:read');
  await requireApplication(tenant, 'bookings');
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid booking id');

  const options = await moveOptions(tenant, id);
  if (!options) return NextResponse.json({ error: `No booking with id ${id}` }, { status: 404 });
  return NextResponse.json(options);
});

/**
 * Move the stay of this booking to another room of the same type:
 * `{ "roomId": 23, "note": "Guest asked for the room by the pool" }`. Every
 * live, not-yet-ended night of the stay in the booking's room moves, in one
 * statement, through move_room(); the price does not change. bookings:write,
 * the same as confirming.
 *
 *   200  { moved }  the rows moved
 *   400  no note, a room of another type, a retired room, the room it is in, nothing left to move
 *   404  no such booking here
 *   409  that room is confirmed or held for one of those nights, in words
 */
export const PATCH = withTenantRoute<{ id: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant, 'bookings:write');
  await requireApplication(tenant, 'bookings');
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid booking id');
  const parsed = roomMoveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));

  const moved = await moveStay(tenant, id, parsed.data.roomId, parsed.data.note);
  if (moved === null) return NextResponse.json({ error: `No booking with id ${id}` }, { status: 404 });
  return NextResponse.json({ moved });
});
