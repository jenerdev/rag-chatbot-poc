import { NextResponse } from 'next/server';
import { getTranscript } from '@rag/pipeline';
import { requireAdmin } from '@/lib/admin-auth';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One conversation's transcript, oldest first (S-16a, D-115), for any member
 * (`conversations:read`). Another tenant's id, a deleted conversation and a
 * malformed id are the same 404 (plan Rule 3), so ids cannot be probed.
 */
export const GET = withTenantRoute<{ id: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant, 'conversations:read');
  const transcript = await getTranscript(tenant, params.id);
  if (!transcript) return NextResponse.json({ error: 'No such conversation' }, { status: 404 });
  return NextResponse.json(transcript);
});
