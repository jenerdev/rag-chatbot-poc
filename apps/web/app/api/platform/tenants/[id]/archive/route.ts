import { NextResponse } from 'next/server';
import { archiveTenant } from '@rag/pipeline';
import { withPlatformRoute } from '@/lib/platform-auth';
import { badRequest, parseId } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Archive (POST) and unarchive (DELETE) a tenant (plan/tenant-management.md
 * § 2.3). Archived, the tenant is a 404 everywhere: its pages, its chat, its
 * admin, its booking page, because every one of them resolves the slug
 * through tenant_public(), which no longer returns the row. Nothing is
 * deleted, and nothing here CAN delete: hard delete is the CLI's
 * (tenant:remove), which prints the counts and sweeps Storage after.
 */
export const POST = withPlatformRoute<{ id: string }>(async (_request, { platform, params }) => {
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid tenant id');
  return NextResponse.json(await archiveTenant(platform, id, true));
});

export const DELETE = withPlatformRoute<{ id: string }>(async (_request, { platform, params }) => {
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid tenant id');
  return NextResponse.json(await archiveTenant(platform, id, false));
});
