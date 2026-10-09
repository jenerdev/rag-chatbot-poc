import { NextResponse } from 'next/server';
import { reviewPayment } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { parseMoneyInput } from '@/lib/money';
import { badRequest, parseId } from '@/lib/route';
import { firstError, reviewPaymentSchema } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Verify or reject one proof (plan/manage-booking.md Phase 4). Owners and
 * admins (payments:write, § 9 q4); review_payment() asks the role again.
 *   { action: 'verify', amount: '1500', accountChecked: true, note?, confirm? }
 *   { action: 'reject', note: 'the reason the guest reads' }
 * `confirm` also confirms the stay, in the same transaction, when the
 * verified amount is enough; a night taken meanwhile is a 409 and nothing
 * changes. "Not yours" and "not there" are one 404.
 */
export const PATCH = withTenantRoute<{ id: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant, 'payments:write');
  await requireApplication(tenant, 'bookings');

  const id = parseId(params.id);
  if (id === null) return badRequest('No such payment.');
  const parsed = reviewPaymentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  const { action, amount, accountChecked, note, confirm } = parsed.data;
  const centavos = amount ? parseMoneyInput(amount) : null;
  if (action === 'verify' && centavos === null) return badRequest('Type the amount you found in the account, like 1500 or 1,500.00.');

  const result = await reviewPayment(tenant, id, {
    action,
    amount: centavos,
    accountChecked: accountChecked ?? false,
    note: note ?? null,
    confirm: confirm ?? false,
  });
  if (!result) return NextResponse.json({ error: 'No such payment.' }, { status: 404 });
  return NextResponse.json(result);
});
