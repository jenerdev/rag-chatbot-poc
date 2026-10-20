import { NextResponse } from 'next/server';
import { listActivity } from '@rag/pipeline';
import { withPlatformRoute } from '@/lib/platform-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The platform's own activity (D-138): rows with no tenant, which are a
 * super user added or removed, a workspace created or removed, and super
 * users' sign-ins. Super users only: activity_list(null, …) refuses anyone
 * else itself. `?days=`, `?area=`, `?actor=`, `?q=`, `?before=&beforeKey=`
 * as on the tenant routes.
 */
export const GET = withPlatformRoute(async (request, { platform }) => {
  const p = new URL(request.url).searchParams;
  const before = p.get('before');
  const beforeKey = p.get('beforeKey');
  return NextResponse.json(
    await listActivity(platform.db, null, {
      days: p.get('days') ?? undefined,
      area: p.get('area') ?? undefined,
      actor: p.get('actor'),
      q: p.get('q'),
      before: before && beforeKey ? { at: before, key: beforeKey } : null,
    }),
  );
});
