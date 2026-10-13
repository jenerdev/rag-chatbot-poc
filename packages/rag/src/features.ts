// features.ts — a tenant's feature flags (D-127, sql/schema-features.sql).
//
// A feature is ON unless a row says it is off. This reads the rows; what the
// keys mean, and their defaults, is apps/web/lib/features.ts, the registry
// the pages and the platform form share. A key the registry does not know is
// ignored there, as an unknown application is (D-033).
//
// On the tenant's own token: any token of the tenant reads its own rows
// (tenant_features_read), so the chat's pages can ask too. Filtered on the
// tenant as well (CLAUDE.md rule 6, wall 1).

import type { TenantContext } from './types.js';

/** The rows this tenant has: feature key → enabled. A key with no row is absent (= on). */
export async function featureSwitches(tenant: TenantContext): Promise<Record<string, boolean>> {
  const { data, error } = await tenant.db.from('tenant_features').select('feature, enabled').eq('tenant_id', tenant.id);
  if (error) throw new Error(`Could not load feature flags: ${error.message}`);
  return Object.fromEntries(data.map((row) => [row.feature, row.enabled]));
}
