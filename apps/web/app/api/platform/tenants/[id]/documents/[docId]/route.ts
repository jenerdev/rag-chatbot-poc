import { NextResponse } from 'next/server';
import { deleteDocument, platformTenantContext } from '@rag/pipeline';
import { withPlatformRoute } from '@/lib/platform-auth';
import { badRequest, parseId } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Delete one of a tenant's documents from the platform (D-128); its chunks go with it. 404: not this tenant's, or not there. */
export const DELETE = withPlatformRoute<{ id: string; docId: string }>(async (_request, { platform, params }) => {
  const id = parseId(params.id);
  const docId = parseId(params.docId);
  if (id === null || docId === null) return badRequest('Invalid id');
  const gone = await deleteDocument(await platformTenantContext(platform, id), docId);
  if (!gone) return NextResponse.json({ error: 'No such document' }, { status: 404 });
  console.log(`[platform] ${platform.userId} deleted document ${docId} of tenant ${id}`);
  return NextResponse.json({ deleted: docId });
});
