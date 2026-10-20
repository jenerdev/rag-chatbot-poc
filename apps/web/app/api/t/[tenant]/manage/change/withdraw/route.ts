import { NextResponse } from 'next/server';
import { withdrawChange } from '@rag/bookings';
import { requireApplication } from '@/lib/applications';
import { MANAGE_NOT_FOUND } from '@/lib/manage';
import { allow, clientIp } from '@/lib/rate-limit';
import { badRequest } from '@/lib/route';
import { firstError, manageLookupSchema } from '@/lib/schemas';
import { requireFeature } from '@/lib/feature-flags';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A guest takes back their open change request. `{ withdrawn: false }` when none was open. */
export const POST = withTenantRoute(async (request, { tenant }) => {
  await requireApplication(tenant, 'bookings');
  await requireFeature(tenant, 'manage_booking');
  const parsed = manageLookupSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  if (!(await allow(tenant, `manage|${tenant.id}|${clientIp(request)}`))) {
    return NextResponse.json({ error: 'Too many attempts from here. Please try again in a few minutes.' }, { status: 429 });
  }
  const result = await withdrawChange(tenant, parsed.data.reference, parsed.data.contact);
  if (result === null) return NextResponse.json({ error: MANAGE_NOT_FOUND }, { status: 404 });
  return NextResponse.json({ withdrawn: result });
});
