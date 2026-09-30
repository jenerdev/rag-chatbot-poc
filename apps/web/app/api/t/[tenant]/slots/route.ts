import { NextResponse } from 'next/server';
import { createSlot, listSlotsAdmin } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { badRequest } from '@/lib/route';
import { createSlotSchema, firstError } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The Slots screen (D-090). `GET` lists every slot, retired ones included,
 * with how many upcoming bookings fix its times and whether it was ever
 * booked. `POST` adds a slot. Owners and admins only: Postgres asks
 * app_is_admin() again (schema-slots.sql).
 */
export const GET = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'slots:read');
  await requireApplication(tenant, 'bookings');
  return NextResponse.json(await listSlotsAdmin(tenant));
});

export const POST = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'slots:write');
  await requireApplication(tenant, 'bookings');

  const parsed = createSlotSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  return NextResponse.json(await createSlot(tenant, parsed.data), { status: 201 });
});
