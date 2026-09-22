import { NextResponse } from 'next/server';
import { getChunks } from '@rag/pipeline';
import { requireAdmin } from '@/lib/admin-auth';
import { badRequest, parseId } from '@/lib/route';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The chunks of one document, for the expandable row on the admin page. */
export const GET = withTenantRoute<{ id: string }>(async (request, { tenant, params }) => {
  requireAdmin(request, tenant);
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid document id');

  // Another tenant's document id gives [], the same as an id that does not exist.
  return NextResponse.json(await getChunks(tenant, id));
});
