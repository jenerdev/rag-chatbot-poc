// tenant.ts — looking a tenant up by its slug.
//
// The one place a slug becomes a TenantContext. Every caller (the routes, the
// eval battery, the score probe) goes through here.

import { anonClient, mintTenantToken, scopedClient } from '@rag/db';
import type { TenantContext } from './types.js';

/**
 * The tenant for a slug, as a CHAT context, or null when there is no such
 * tenant.
 *
 * Two steps, because the server does not know the tenant until it has looked
 * the slug up, so it cannot mint a token for it yet:
 *
 * 1. `tenant_public(slug)` with NO token. `tenants` has no RLS policies, so no
 *    token can read the table. This security-definer function is the one way
 *    in, and its column list is the boundary: `admin_key_hash` is not in it.
 *    That is stronger than naming columns in a select here, which is what
 *    this used to rely on.
 * 2. A chat token for that tenant's id, and a client holding it. Everything
 *    this context touches from here on is under RLS as this tenant, and reads
 *    no bookings row (plan/auth-rls.md § 1.3).
 *
 * Staff contexts, with a user and `app_admin`, come from the admin session in
 * Phase 5. Until then every request, admin routes included, is a chat context.
 *
 * A miss is `null`, not a fallback. There is no default tenant (D-027). A
 * caller that cannot find the tenant it was asked for must say so, never
 * quietly answer from someone else's documents.
 */
export async function loadTenant(slug: string): Promise<TenantContext | null> {
  const { data, error } = await anonClient().rpc('tenant_public', { p_slug: slug });
  if (error) throw new Error(`Could not load tenant "${slug}": ${error.message}`);
  const row = data?.[0];
  if (!row) return null;

  return {
    id: row.id,
    slug: row.slug,
    businessName: row.business_name,
    assistantName: row.assistant_name,
    db: scopedClient(mintTenantToken({ tenantId: row.id })),
  };
}
