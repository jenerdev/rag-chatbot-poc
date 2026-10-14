import { NextResponse } from 'next/server';
import { deleteStayNote } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { badRequest } from '@/lib/route';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Delete one of YOUR notes on a stay (D-132). Only its author may: the
 * policy reaches no one else's row, so a colleague's note, another stay's,
 * another tenant's and a deleted one are all the same 404.
 */
export const DELETE = withTenantRoute<{ reference: string; id: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant, 'bookings:write');
  await requireApplication(tenant, 'bookings');

  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return badRequest('That is not a note id.');

  if (!(await deleteStayNote(tenant, params.reference, id))) return NextResponse.json({ error: 'No such note, or not yours' }, { status: 404 });
  return NextResponse.json({ deleted: id });
});
