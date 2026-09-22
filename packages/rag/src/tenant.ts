// tenant.ts — looking a tenant up by its slug.
//
// The one place a `tenants` row becomes a TenantContext. Every caller (the
// routes, the eval battery, the score probe) goes through here, so the list of
// selected columns is written once.

import { supabase } from '@rag/db';
import type { TenantContext } from './types.js';

/**
 * The tenant for a slug, or null when there is no such tenant.
 *
 * The four columns are named EXPLICITLY. `select('*')` would also fetch
 * `admin_key_hash`, and once that is in an object that gets passed around, it
 * is one `NextResponse.json(tenant)` away from being in a response.
 *
 * A miss is `null`, not a fallback. There is no default tenant (D-027). A
 * caller that cannot find the tenant it was asked for must say so, never
 * quietly answer from someone else's documents.
 */
export async function loadTenant(slug: string): Promise<TenantContext | null> {
  const { data, error } = await supabase
    .from('tenants')
    .select('id, slug, business_name, assistant_name')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw new Error(`Could not load tenant "${slug}": ${error.message}`);
  if (!data) return null;

  return {
    id: data.id,
    slug: data.slug,
    businessName: data.business_name,
    assistantName: data.assistant_name,
  };
}
