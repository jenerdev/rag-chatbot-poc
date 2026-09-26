import { NextResponse } from 'next/server';
import { deleteDocument } from '@rag/pipeline';
import { requireAdmin } from '@/lib/admin-auth';
import { badRequest, parseId } from '@/lib/route';
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
  tenant = await requireAdmin(request, tenant);
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid document id');

  // false means "not this tenant's OR not there". The 404 says the same thing
  // for both, on purpose: anything else would let one tenant enumerate
  // another's document ids.
  const deleted = await deleteDocument(tenant, id);
  if (!deleted) return NextResponse.json({ error: `No document with id ${id}` }, { status: 404 });
  return NextResponse.json({ deleted: true });
});
