import { NextResponse } from 'next/server';
import { listActivity } from '@rag/pipeline';
import { withPlatformRoute } from '@/lib/platform-auth';
import { badRequest, parseId } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One page of a tenant's activity for a super user (the tenant form's
 * Activity tab, D-138). The platform token reads audit_log through its own
 * clause of the read policy (app_is_super()) and the tenant's stay log is
 * read by the function as that clause too; activity_list() admits a super
 * user for any tenant (plan Rule 4). The same query string as the tenant's
 * own route.
 */
export const GET = withPlatformRoute<{ id: string }>(async (request, { platform, params }) => {
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid tenant id');
  const p = new URL(request.url).searchParams;
  const before = p.get('before');
  const beforeKey = p.get('beforeKey');
  return NextResponse.json(
    await listActivity(platform.db, id, {
      days: p.get('days') ?? undefined,
      area: p.get('area') ?? undefined,
      actor: p.get('actor'),
      q: p.get('q'),
      before: before && beforeKey ? { at: before, key: beforeKey } : null,
    }),
  );
});
