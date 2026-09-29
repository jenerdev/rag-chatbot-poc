import { NextResponse } from 'next/server';
import { createTenant, listTenants } from '@rag/pipeline';
import { withPlatformRoute } from '@/lib/platform-auth';
import { badRequest } from '@/lib/route';
import { createTenantSchema, firstError } from '@/lib/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The platform's tenant list, archived included, and the birth of a tenant
 * (plan/tenant-management.md § 4.3). Both on the platform token: no tenant
 * is resolved here, because the platform's work has none yet, or has all of
 * them. A new tenant has no members; the platform adds the first owner on
 * its members route, or makes itself one (plan § 8 q5).
 */
export const GET = withPlatformRoute(async (_request, { platform }) => NextResponse.json(await listTenants(platform)));

export const POST = withPlatformRoute(async (request, { platform }) => {
  const parsed = createTenantSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  // The slug's reserved words and the names' lengths are Postgres's to refuse
  // (23514 → 400 with its message); a taken slug is a 409.
  return NextResponse.json(await createTenant(platform, parsed.data), { status: 201 });
});
