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
 * Opening one is the one READ in the audit log (D-138, plan § 2.3): the
 * payment id, never the file.
 */
export const GET = withTenantRoute<{ id: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant, 'payments:read');
  await requireApplication(tenant, 'bookings');
  const id = parseId(params.id);
  if (id === null) return badRequest('No such payment.');
  const url = await proofUrl(tenant, id);
  if (!url) return NextResponse.json({ error: 'No such proof.' }, { status: 404 });
  const noted = await tenant.db.rpc('audit_note', { p_tenant_id: tenant.id, p_action: 'proof_opened', p_subject: String(id) });
  if (noted.error) throw new Error(`Could not record the proof being opened: ${noted.error.message}`);
  return NextResponse.json({ url });
});
