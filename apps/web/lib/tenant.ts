import 'server-only';
import { cache } from 'react';
import { loadTenant } from '@rag/pipeline';
import type { TenantContext } from '@rag/pipeline';

/**
 * The tenant for a slug, or null.
 *
 * Wrapped in React `cache()`, so one request that needs it three times costs
 * one query. The column list lives in `loadTenant()`, which never selects
 * `admin_key_hash`.
 */
export const getTenant = cache(async (slug: string): Promise<TenantContext | null> => loadTenant(slug));

/**
 * ⚠ BRIDGE (D-031), removed in tenancy Phase 5.
 *
 * The pipeline now requires a tenant (Phase 3), but the routes do not move to
 * `/api/t/<slug>/…` until Phase 5. Until then, the existing un-prefixed routes
 * serve exactly one tenant: northwind. That is a hard-coded pin, not a default.
 * Nothing falls back to it, and no request can choose another tenant through
 * these routes. Villa is unreachable over HTTP until Phase 5, which is safer
 * than before Phase 3, when these routes searched every tenant.
 *
 * Phase 5 deletes this function, and the old routes go with it (`/api/chat`
 * becomes a 404).
 */
export async function bridgeTenant(): Promise<TenantContext> {
  const tenant = await getTenant('northwind');
  if (!tenant) {
    throw new Error('The northwind tenant is missing. Has packages/db/sql/schema-tenancy.sql been run?');
  }
  return tenant;
}
