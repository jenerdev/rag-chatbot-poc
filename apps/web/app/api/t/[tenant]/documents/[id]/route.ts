import { NextResponse } from 'next/server';
import { deleteDocument, getDocument, updateDocument } from '@rag/pipeline';
import { requireAdmin } from '@/lib/admin-auth';
import { badRequest, parseId } from '@/lib/route';
import { createDocumentSchema, firstError } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Delete a document. Its chunks cascade.
 *
 * Half of the project's success criterion lives here: delete the document, ask
 * the same question again, and the bot must stop knowing the answer.
 */
export const DELETE = withTenantRoute<{ id: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant, 'documents:write');
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid document id');

  // false means "not this tenant's OR not there". The 404 says the same thing
  // for both, on purpose: anything else would let one tenant enumerate
  // another's document ids.
  const deleted = await deleteDocument(tenant, id);
  if (!deleted) return NextResponse.json({ error: `No document with id ${id}` }, { status: 404 });
  return NextResponse.json({ deleted: true });
});

/** One document with its full text, for the edit form. Admin only. */
export const GET = withTenantRoute<{ id: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant, 'documents:read');
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid document id');

  const doc = await getDocument(tenant, id);
  if (!doc) return NextResponse.json({ error: `No document with id ${id}` }, { status: 404 });
  return NextResponse.json(doc);
});

/**
 * Edit a document: re-chunk and re-embed the new text, then remove the old
 * version. The reply carries the NEW id (updateDocument explains why).
 *
 * Same validation as adding one, so an edit cannot store what an add would
 * refuse.
 */
export const PUT = withTenantRoute<{ id: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant, 'documents:write');
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid document id');
  const parsed = createDocumentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));

  const result = await updateDocument({ tenant, id, ...parsed.data });
  if (!result) return NextResponse.json({ error: `No document with id ${id}` }, { status: 404 });
  return NextResponse.json(result);
});
