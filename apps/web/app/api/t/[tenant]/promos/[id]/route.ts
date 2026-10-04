import { NextResponse } from 'next/server';
import { deletePromo, updatePromo } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { badRequest, parseId } from '@/lib/route';
import { firstError, updatePromoSchema } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Edit a promo (D-097), `active: false` to retire it. A booking that already
 * used it keeps its stored discount (plan Rule 4). "Not yours" and "not
 * there" are one 404.
 */
export const PATCH = withTenantRoute<{ id: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant, 'promos:write');
  await requireApplication(tenant, 'bookings');

  const id = parseId(params.id);
  if (id === null) return badRequest('No such promo.');
  const parsed = updatePromoSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  const updated = await updatePromo(tenant, id, parsed.data);
  if (!updated) return NextResponse.json({ error: 'No such promo.' }, { status: 404 });
  return NextResponse.json(updated);
});

/** Delete a promo that was never used; a used one is a 400 saying to retire it instead. */
export const DELETE = withTenantRoute<{ id: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant, 'promos:write');
  await requireApplication(tenant, 'bookings');

  const id = parseId(params.id);
  if (id === null) return badRequest('No such promo.');
  // Counted, not trusted: 404 when nothing was removed (trap 17).
  if (!(await deletePromo(tenant, id))) return NextResponse.json({ error: 'No such promo.' }, { status: 404 });
  return NextResponse.json({ deleted: true });
});
