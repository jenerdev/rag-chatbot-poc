import { NextResponse } from 'next/server';
import { getChunks } from '@rag/pipeline';
import { badRequest, parseId, withRoute } from '@/lib/route';
import { bridgeTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** The chunks of one document, for the expandable row on the admin page. */
export const GET = withRoute<Context>(async (_request, { params }) => {
  const id = parseId((await params).id);
  if (id === null) return badRequest('Invalid document id');

  // ⚠ D-031 bridge: northwind until Phase 5.
  return NextResponse.json(await getChunks(await bridgeTenant(), id));
});
