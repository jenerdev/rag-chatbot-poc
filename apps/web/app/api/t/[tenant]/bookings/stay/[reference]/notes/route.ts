import { NextResponse } from 'next/server';
import { addStayNote } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { badRequest } from '@/lib/route';
import { firstError, stayNoteSchema } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Add a staff note to a stay (D-132): `{ "body": "Asked for an early check-in" }`.
 * Any number per stay; never shown to the guest. bookings:write, the same as
 * acting on the stay; the author is the session's user, set by Postgres.
 *
 *   201  { id }
 *   400  empty, or longer than MAX_STAY_NOTE
 *   404  no such booking here (not this tenant's looks the same)
 */
export const POST = withTenantRoute<{ reference: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant, 'bookings:write');
  await requireApplication(tenant, 'bookings');

  const parsed = stayNoteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));

  const note = await addStayNote(tenant, params.reference, parsed.data.body);
  if (!note) return NextResponse.json({ error: 'No such booking' }, { status: 404 });
  return NextResponse.json(note, { status: 201 });
});
