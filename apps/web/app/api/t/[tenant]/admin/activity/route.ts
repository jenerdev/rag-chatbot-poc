import { NextResponse } from 'next/server';
import { listActivity } from '@rag/pipeline';
import { requireAdmin } from '@/lib/admin-auth';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One page of this tenant's activity, newest first (S-18, D-138), for a
 * role with `activity:read` (owners by default; grantable). The SQL
 * function refuses any other caller itself as well (plan Rule 4).
 *
 * `?days=7|30|90|365` (else 30), `?area=` one area, `?actor=` one member's
 * user id, `?q=` a search over the label, and `?before=<at>&beforeKey=<key>`,
 * the previous page's last row (keyset).
 *
 * Under admin/, like conversations: nothing a chat token could mistake for
 * its own.
 */
export const GET = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'activity:read');
  const params = new URL(request.url).searchParams;
  const before = params.get('before');
  const beforeKey = params.get('beforeKey');
  return NextResponse.json(
    await listActivity(tenant.db, tenant.id, {
      days: params.get('days') ?? undefined,
      area: params.get('area') ?? undefined,
      actor: params.get('actor'),
      q: params.get('q'),
      before: before && beforeKey ? { at: before, key: beforeKey } : null,
    }),
  );
});
