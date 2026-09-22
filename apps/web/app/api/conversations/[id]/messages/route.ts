import { NextResponse } from 'next/server';
import { getMessages } from '@rag/pipeline';
import { withRoute } from '@/lib/route';
import { bridgeTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/**
 * Reload a conversation's transcript.
 *
 * The UI does not list past conversations (out of scope), but the messages are
 * in the database, so this exists.
 */
export const GET = withRoute<Context>(async (_request, { params }) => {
  const id = (await params).id;
  // ⚠ D-031 bridge: northwind until Phase 5. null = not this tenant's
  // conversation OR no such conversation. Both are a 404, and they are
  // indistinguishable on purpose (plan.md § 2.2).
  const messages = await getMessages(await bridgeTenant(), id);
  if (messages === null) {
    return NextResponse.json({ error: `No conversation with id ${id}` }, { status: 404 });
  }
  return NextResponse.json(messages);
});
