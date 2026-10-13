import { NextResponse } from 'next/server';
import { getTenant, sweepBrandImages, updateTenant } from '@rag/pipeline';
import { withPlatformRoute } from '@/lib/platform-auth';
import { badRequest, parseId } from '@/lib/route';
import { firstError, updateTenantSchema } from '@/lib/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One tenant, by id: its row, its applications with their configs, and how
 * many members it has. By id rather than slug because an archived tenant no
 * longer resolves by slug anywhere (tenant_public), and this is the one place
 * it must still be reachable, to unarchive it.
 */
export const GET = withPlatformRoute<{ id: string }>(async (_request, { platform, params }) => {
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid tenant id');
  return NextResponse.json(await getTenant(platform, id));
});

/**
 * Edit the names, the logo and banner, the theme and the fallback messages.
 * Not the slug (plan § 2.6). zod says the shape first, in the form's words;
 * Postgres says it again (tenants_theme_shape, tenants_urls_https, the
 * lengths, tenants_fallback_messages_shape) and its message comes back as a
 * 400 if the two ever disagree.
 */
export const PATCH = withPlatformRoute<{ id: string }>(async (request, { platform, params }) => {
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid tenant id');
  const parsed = updateTenantSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  const before = await getTenant(platform, id);
  const after = await updateTenant(platform, id, parsed.data);
  // An uploaded logo or banner the tenant no longer points at leaves the bucket (D-123).
  await sweepBrandImages(platform, before, after);
  return NextResponse.json(after);
});
