import { NextResponse } from 'next/server';
import { copyCalendarDays } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { badRequest } from '@/lib/route';
import { copyHolidaysSchema, firstError } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Copy chosen days to the same month and day of another year:
 * `{ "days": ["2026-12-24", "2026-12-25"], "toYear": 2027 }`. Staff choose
 * which, because only they know which dates are fixed; Holy Week moves and is
 * never copied (plan/customer-booking.md § 2.3). Returns the copies.
 */
export const POST = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'holidays:write');
  await requireApplication(tenant, 'bookings');

  const parsed = copyHolidaysSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  return NextResponse.json(await copyCalendarDays(tenant, parsed.data));
});
