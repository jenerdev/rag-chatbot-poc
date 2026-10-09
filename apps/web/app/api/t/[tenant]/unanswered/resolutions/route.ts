import { NextResponse } from 'next/server';
import { reopenUnansweredMany, resolveUnansweredMany, UNANSWERED_LIMIT } from '@rag/pipeline';
import { requireAdmin } from '@/lib/admin-auth';
import { badRequest } from '@/lib/route';
import { firstError, unansweredIdsSchema } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Several questions' resolutions at once (S-4's checkboxes): PUT resolves
// `{ ids }`, DELETE reopens them. The one-question route,
// unanswered/[id]/resolution, stays for the row's own button.
//
// The answer names the ids that changed. An id that is not this tenant's (or
// not a refusal, or not resolved) is simply not in it: no 404 per id, and
// nothing that tells one tenant's ids from "not there".

const idsSchema = unansweredIdsSchema(UNANSWERED_LIMIT);

export const PUT = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'unanswered:write');
  const parsed = idsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  return NextResponse.json({ resolved: await resolveUnansweredMany(tenant, parsed.data.ids) });
});

export const DELETE = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'unanswered:write');
  const parsed = idsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  return NextResponse.json({ reopened: await reopenUnansweredMany(tenant, parsed.data.ids) });
});
