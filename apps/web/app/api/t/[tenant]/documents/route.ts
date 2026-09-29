import { NextResponse } from 'next/server';
import { ingestDocument, listDocuments } from '@rag/pipeline';
import { requireAdmin } from '@/lib/admin-auth';
import { badRequest } from '@/lib/route';
import { createDocumentSchema, firstError } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

// This route talks to a database and OpenAI on every request; there is nothing
// here to cache or prerender, and trying would make ingest a build-time action.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Add a document: chunk it, embed it, store it. */
export const POST = withTenantRoute(async (request, { tenant }) => {
  // Admin only (Phase 6). The chat route is the product and stays open. Editing
  // the knowledge base behind it needs a member of this tenant (auth-rls Phase 5).
  tenant = await requireAdmin(request, tenant, 'documents:write');
  const parsed = createDocumentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));

  const result = await ingestDocument({ tenant, ...parsed.data });
  return NextResponse.json(result, { status: 201 });
});

/** List the tenant's documents with their chunk counts. Admin only. */
export const GET = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'documents:read');
  return NextResponse.json(await listDocuments(tenant));
});
