import { NextResponse } from 'next/server';
import { decideChange } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { badRequest, parseId } from '@/lib/route';
import { decideChangeSchema, firstError } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Approve or reject a change request (plan/manage-booking.md Phase 6).
 * Owners and admins (payments:write): it moves money owed. decide_change()
 * asks the role again; approving a reschedule moves the stay in one
 * transaction, and a night taken meanwhile is a 409 with nothing changed.
 */
export const PATCH = withTenantRoute<{ id: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant, 'payments:write');
  await requireApplication(tenant, 'bookings');
  const id = parseId(params.id);
  if (id === null) return badRequest('No such request.');
  const parsed = decideChangeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  const result = await decideChange(tenant, id, parsed.data.action, parsed.data.note ?? null);
  if (!result) return NextResponse.json({ error: 'No such request.' }, { status: 404 });
  return NextResponse.json(result);
});
