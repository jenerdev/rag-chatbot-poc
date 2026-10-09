import { NextResponse } from 'next/server';
import { proofUrl } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { badRequest, parseId } from '@/lib/route';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A 5-minute signed URL for one proof (plan § 2.7), minted on the STAFF
 * token: the bucket is private and only a member of the tenant may sign.
 * Never stored, never in a list response: asked for when someone opens it.
 */
export const GET = withTenantRoute<{ id: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant, 'payments:read');
  await requireApplication(tenant, 'bookings');
  const id = parseId(params.id);
  if (id === null) return badRequest('No such payment.');
  const url = await proofUrl(tenant, id);
  if (!url) return NextResponse.json({ error: 'No such proof.' }, { status: 404 });
  return NextResponse.json({ url });
});
