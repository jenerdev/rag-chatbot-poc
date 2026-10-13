import { NextResponse } from 'next/server';
import { setFeature } from '@rag/pipeline';
import { FEATURE_KEYS, isFeatureKey } from '@/lib/features';
import { withPlatformRoute } from '@/lib/platform-auth';
import { badRequest, parseId } from '@/lib/route';
import { featureSwitchSchema, firstError } from '@/lib/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Switch a feature on or off for a tenant (D-127): `{ "enabled": false }`.
 * The key must be one lib/features.ts knows, and Postgres's
 * tenant_features_key refuses any other as well. A super user only
 * (withPlatformRoute, and tenant_features_super_all in SQL). The tenant
 * as it now is comes back, as from every platform write.
 */
export const PUT = withPlatformRoute<{ id: string; key: string }>(async (request, { platform, params }) => {
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid tenant id');
  if (!isFeatureKey(params.key)) return badRequest(`No feature "${params.key}". The features are: ${FEATURE_KEYS.join(', ')}`);
  const parsed = featureSwitchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  return NextResponse.json(await setFeature(platform, id, params.key, parsed.data.enabled));
});
