import { NextResponse } from 'next/server';
import { setRates } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { badRequest, parseId } from '@/lib/route';
import { firstError, setRatesSchema } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Set a room's rates, in CENTAVOS: `{ rates: [{ slotId, weekdayPrice,
 * weekendPrice }] }`. A PUT because each listed slot's rate is replaced; slots
 * left out keep theirs. Existing bookings keep the price they were booked at
 * (plan/booking-types.md Rule 2). 404 for a room that is not this tenant's or
 * not there.
 */
export const PUT = withTenantRoute<{ id: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant);
  await requireApplication(tenant, 'bookings');
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid room id');

  const parsed = setRatesSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));

  const room = await setRates(tenant, id, parsed.data.rates);
  return room ? NextResponse.json(room) : NextResponse.json({ error: `No room with id ${id}` }, { status: 404 });
});
