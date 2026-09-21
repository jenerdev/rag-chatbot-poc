import { NextResponse } from 'next/server';
import { deleteDocument } from '@rag/pipeline';
import { badRequest, parseId, withRoute } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/**
 * Delete a document. Its chunks cascade.
 *
 * Half of the project's success criterion lives here: delete the document, ask
 * the same question again, and the bot must stop knowing the answer.
 */
export const DELETE = withRoute<Context>(async (_request, { params }) => {
  // Next 15 hands route params in as a promise.
  const id = parseId((await params).id);
  if (id === null) return badRequest('Invalid document id');

  const deleted = await deleteDocument(id);
  if (!deleted) return NextResponse.json({ error: `No document with id ${id}` }, { status: 404 });
  return NextResponse.json({ deleted: true });
});
