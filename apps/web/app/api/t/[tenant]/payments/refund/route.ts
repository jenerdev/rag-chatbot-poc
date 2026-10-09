import { NextResponse } from 'next/server';
import { recordRefund } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { parseMoneyInput } from '@/lib/money';
import { badRequest } from '@/lib/route';
import { firstError, recordRefundSchema } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Record a refund staff made elsewhere (no money moves here). Owners and
 * admins; record_refund() checks it is no more than what was received.
 */
export const POST = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'payments:write');
  await requireApplication(tenant, 'bookings');
  const parsed = recordRefundSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  const amount = parseMoneyInput(parsed.data.amount);
  if (amount === null || amount < 1) return badRequest('Type the amount refunded, like 1500 or 1,500.00.');
  const result = await recordRefund(tenant, parsed.data.groupId, amount, parsed.data.method, parsed.data.note);
  if (!result) return NextResponse.json({ error: 'No such booking.' }, { status: 404 });
  return NextResponse.json(result, { status: 201 });
});
