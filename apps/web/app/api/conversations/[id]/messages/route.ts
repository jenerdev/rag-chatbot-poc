import { NextResponse } from 'next/server';
import { getMessages } from '@rag/pipeline';
import { withRoute } from '@/lib/route';

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
  return NextResponse.json(await getMessages((await params).id));
});
