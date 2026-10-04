import { NextResponse } from 'next/server';
import { createPromo, listPromos } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { badRequest } from '@/lib/route';
import { createPromoSchema, firstError } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The tenant's promos (D-097), with their use counts. Owners and admins
 * (`promos:read`); `?all=1` includes retired ones. A customer never reaches
 * this list: the booking page asks `book/quote` with a code, and the one
 * definer function answers for that stay alone (plan Rule 2).
 */
export const GET = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'promos:read');
  await requireApplication(tenant, 'bookings');
  const all = new URL(request.url).searchParams.get('all') === '1';
  return NextResponse.json(await listPromos(tenant, { all }));
});

/** Create a promo. 400 in @rag/bookings' words for a bad input or a duplicate code. */
export const POST = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'promos:write');
  await requireApplication(tenant, 'bookings');

  const parsed = createPromoSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  return NextResponse.json(await createPromo(tenant, parsed.data), { status: 201 });
});
