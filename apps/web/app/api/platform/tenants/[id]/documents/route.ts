import { NextResponse } from 'next/server';
import { ingestDocument, listDocuments, platformTenantContext } from '@rag/pipeline';
import { withPlatformRoute } from '@/lib/platform-auth';
import { badRequest, parseId } from '@/lib/route';
import { createDocumentSchema, firstError } from '@/lib/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A tenant's knowledge base, from the platform (D-128): a super user lists
 * and adds documents for any tenant, so a tenant can be set up where only
 * the platform adds documents and its owner only reads them. The same
 * ingest as the tenant's own screen (chunk, embed, store), on the PLATFORM
 * token: ingest.ts filters on the tenant in every query, and the super
 * policies on documents and chunks are the second wall.
 */
export const GET = withPlatformRoute<{ id: string }>(async (_request, { platform, params }) => {
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid tenant id');
  return NextResponse.json(await listDocuments(await platformTenantContext(platform, id)));
});

export const POST = withPlatformRoute<{ id: string }>(async (request, { platform, params }) => {
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid tenant id');
  const parsed = createDocumentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  const tenant = await platformTenantContext(platform, id);
  console.log(`[platform] ${platform.userId} adds a document to tenant ${id}`);
  return NextResponse.json(await ingestDocument({ tenant, ...parsed.data }), { status: 201 });
});
