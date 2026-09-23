import { NextResponse } from 'next/server';
import { checkAvailability } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { badRequest } from '@/lib/route';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Open or taken, per (date, unit, slot).
 * `GET /api/t/<slug>/bookings/availability?from=2026-10-01&to=2026-10-07`
 *
 * The same function the chatbot's tool will call in Phase 6, and the same
 * answer. That is the point of D-032.
 *
 * Admin-only for now, like every route under bookings/. The data has no guest
 * fields and could be public, but nothing needs it to be yet. The chatbot will
 * reach it through the pipeline, not over HTTP.
 */
export const GET = withTenantRoute(async (request, { tenant }) => {
  requireAdmin(request, tenant);
  await requireApplication(tenant, 'bookings');

  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  if (!from) return badRequest('A from date is required, e.g. ?from=2026-10-01');
  const to = url.searchParams.get('to') ?? undefined;

  return NextResponse.json(await checkAvailability(tenant, { from, to }));
});
