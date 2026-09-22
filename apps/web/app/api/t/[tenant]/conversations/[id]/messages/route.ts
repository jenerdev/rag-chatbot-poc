import { NextResponse } from 'next/server';
import { getMessages } from '@rag/pipeline';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Reload a conversation's transcript.
 *
 * The UI does not list past conversations (out of scope), but the messages are
 * in the database, so this exists.
 */
export const GET = withTenantRoute<{ id: string }>(async (_request, { tenant, params }) => {
  const id = params.id;
  // null = not this tenant's conversation OR no such conversation. Both are a
  // 404, and they are indistinguishable on purpose (plan.md § 2.2).
  const messages = await getMessages(tenant, id);
  if (messages === null) {
    return NextResponse.json({ error: `No conversation with id ${id}` }, { status: 404 });
  }
  return NextResponse.json(messages);
});
