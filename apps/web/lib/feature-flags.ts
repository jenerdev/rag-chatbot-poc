import 'server-only';
import { cache } from 'react';
import { featureSwitches } from '@rag/pipeline';
import type { TenantContext } from '@rag/pipeline';
import { featureFlags, type FeatureFlags, type FeatureKey } from './features';

/**
 * The tenant's feature flags (D-127), memoised per request like
 * applicationsOf(): getTenant() hands every caller the same TenantContext,
 * so this is one query per request.
 */
export const loadFeatures = cache(async (tenant: TenantContext): Promise<FeatureFlags> => featureFlags(await featureSwitches(tenant)));

/** For pages, which call notFound() rather than throw. */
export async function featureOn(tenant: TenantContext, key: FeatureKey): Promise<boolean> {
  return (await loadFeatures(tenant))[key];
}

class FeatureOffError extends Error {
  // 404, like an application that is not switched on (lib/applications.ts):
  // a switched-off page looks like no page, not like a locked one.
  readonly status = 404;
}

/**
 * Guard a handler that belongs to a feature: a 404 unless it is on. Wall 1;
 * for the writes a stranger could make, Postgres refuses too
 * (sql/schema-features.sql). Call it AFTER requireAdmin() on a staff route,
 * so a stranger gets the 401 whether or not the feature is on.
 */
export async function requireFeature(tenant: TenantContext, key: FeatureKey): Promise<void> {
  if (!(await featureOn(tenant, key))) throw new FeatureOffError(`"${tenant.slug}" has ${key} switched off`);
}
