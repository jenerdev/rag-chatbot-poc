import { NextResponse } from 'next/server';
import { listConversations } from '@rag/pipeline';
import { requireAdmin } from '@/lib/admin-auth';
import { requireFeature } from '@/lib/feature-flags';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One page of the tenant's chats, newest activity first (S-16, D-115), for
 * any member (`conversations:read`). They are visitors' own words, so staff
 * data, even though the chat token's policy could read them; the SQL
 * function refuses a non-member itself as well (plan Rule 2).
 *
 * `?days=7|30|90` (else 30), `?q=` a search over every message, `?refused=1`
 * only chats with a refusal, and `?before=<lastAt>&beforeId=<id>`, the
 * previous page's last row (keyset).
 *
 * Under admin/ so it is never mistaken for a chat route: the chat itself
 * reads no transcript.
 */
export const GET = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'conversations:read');
  await requireFeature(tenant, 'conversations');
  const params = new URL(request.url).searchParams;
  const before = params.get('before');
  const beforeId = params.get('beforeId');
  return NextResponse.json(
    await listConversations(tenant, {
      days: params.get('days') ?? undefined,
      query: params.get('q'),
      refused: params.get('refused') === '1',
      before: before && beforeId ? { lastAt: before, id: beforeId } : null,
    }),
  );
});
