import { NextResponse } from 'next/server';
import { quoteStaffStay } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { badRequest } from '@/lib/route';
import { firstError, staffQuoteSchema } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What a stay would cost, night by night, before booking it (D-111): the
 * booking page's quote (priceStay(), the same unit_quote() the insert
 * trigger stores from, plan Rule 2) with the promo the staff member picked.
 * Both booking types; a whole-resort tenant's unit has its rates in the
 * database since customer booking. A POST because it takes a list.
 */
export const POST = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'bookings:read');
  await requireApplication(tenant, 'bookings');

  const parsed = staffQuoteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));

  return NextResponse.json(await quoteStaffStay(tenant, parsed.data));
});
