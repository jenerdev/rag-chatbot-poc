import 'server-only';
import { cache } from 'react';
import { NextResponse } from 'next/server';
import { loadTenant } from '@rag/pipeline';
import type { TenantContext } from '@rag/pipeline';
import { withRoute } from './route';

/**
 * The tenant for a slug, or null.
 *
 * Wrapped in React `cache()`, so one request that needs it three times costs
 * one query. The column list lives in `loadTenant()`, which never selects
 * anything but public columns (it goes through tenant_public).
 */
export const getTenant = cache(async (slug: string): Promise<TenantContext | null> => loadTenant(slug));

/**
 * Wrap a Route Handler under `app/api/t/[tenant]/…`.
 *
 * Resolves the `[tenant]` segment and hands the handler a `TenantContext`. An
 * unknown slug is a 404 that names the slug and nothing else: no list of real
 * slugs, and no fallback. **There is no default tenant** (D-027, plan.md
 * Phase 5). A route that picked a tenant when the URL did not name a real one
 * is exactly how tenant A's question gets answered from tenant B's documents.
 *
 * Built on `withRoute()`, so the one error map still applies. Same argument
 * as `withRoute` itself: nothing enforces it, so it has to be trivial to apply
 * and obvious when absent. Every handler under `app/api/t/` starts with it.
 */
export function withTenantRoute<Params extends Record<string, string> = Record<never, never>>(
  handler: (
    request: Request,
    context: { tenant: TenantContext; params: Params },
  ) => Promise<Response>,
): (request: Request, context: { params: Promise<Params & { tenant: string }> }) => Promise<Response> {
  return withRoute(async (request, { params }: { params: Promise<Params & { tenant: string }> }) => {
    const { tenant: slug, ...rest } = await params;
    const tenant = await getTenant(slug);
    if (!tenant) {
      return NextResponse.json({ error: `No workspace named "${slug}"` }, { status: 404 });
    }
    return handler(request, { tenant, params: rest as unknown as Params });
  });
}
