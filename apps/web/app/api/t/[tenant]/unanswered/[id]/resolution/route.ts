import { NextResponse } from 'next/server';
import { reopenUnanswered, resolveUnanswered } from '@rag/pipeline';
import { requireAdmin } from '@/lib/admin-auth';
import { badRequest, parseId } from '@/lib/route';
import { requireFeature } from '@/lib/feature-flags';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A question's resolution (D-045): PUT marks it resolved, DELETE reopens it.
// `id` is the refusal's message id, as the S-4 list carries it. Admin only.
//
// A 404 for both "not this tenant's" and "not there", as everywhere else, so
// message ids cannot be enumerated across tenants.

export const PUT = withTenantRoute<{ id: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant, 'unanswered:write');
  await requireFeature(tenant, 'unanswered');
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid question id');

  if (!(await resolveUnanswered(tenant, id))) {
    return NextResponse.json({ error: `No unanswered question with id ${id}` }, { status: 404 });
  }
  return NextResponse.json({ resolved: true });
});

export const DELETE = withTenantRoute<{ id: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant, 'unanswered:write');
  await requireFeature(tenant, 'unanswered');
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid question id');

  if (!(await reopenUnanswered(tenant, id))) {
    return NextResponse.json({ error: `No resolved question with id ${id}` }, { status: 404 });
  }
  return NextResponse.json({ resolved: false });
});
