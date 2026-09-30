import { NextResponse } from 'next/server';
import { deleteSlot, updateSlot } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { badRequest, parseId } from '@/lib/route';
import { firstError, updateSlotSchema } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One slot (D-090). `PATCH` changes its name, times, nightly or active
 * (retire / bring back); a time change while upcoming bookings use it is
 * refused in words, by the package and by the trigger. `DELETE` removes a
 * slot never booked; one with bookings is refused ("retire it instead").
 * Both answer 404 for another tenant's slot and for one not there.
 */
export const PATCH = withTenantRoute<{ id: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant, 'slots:write');
  await requireApplication(tenant, 'bookings');

  const id = parseId(params.id);
  if (id === null) return badRequest('No such slot.');
  const parsed = updateSlotSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  const updated = await updateSlot(tenant, id, parsed.data);
  if (!updated) return NextResponse.json({ error: 'No such slot.' }, { status: 404 });
  return NextResponse.json(updated);
});

export const DELETE = withTenantRoute<{ id: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant, 'slots:write');
  await requireApplication(tenant, 'bookings');

  const id = parseId(params.id);
  if (id === null) return badRequest('No such slot.');
  // Counted, not trusted: 404 when nothing was removed (trap 17).
  if (!(await deleteSlot(tenant, id))) return NextResponse.json({ error: 'No such slot.' }, { status: 404 });
  return NextResponse.json({ deleted: true });
});
