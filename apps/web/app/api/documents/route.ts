import { NextResponse } from 'next/server';
import { ingestDocument, listDocuments } from '@rag/pipeline';
import { badRequest, withRoute } from '@/lib/route';
import { createDocumentSchema, firstError } from '@/lib/schemas';

// This route talks to a database and OpenAI on every request; there is nothing
// here to cache or prerender, and trying would make ingest a build-time action.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Add a document: chunk it, embed it, store it. */
export const POST = withRoute(async (request: Request) => {
  const parsed = createDocumentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));

  const result = await ingestDocument(parsed.data);
  return NextResponse.json(result, { status: 201 });
});

/** List every document with its chunk count. */
export const GET = withRoute(async () => {
  return NextResponse.json(await listDocuments());
});
