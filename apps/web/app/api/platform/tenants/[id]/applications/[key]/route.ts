import { NextResponse } from 'next/server';
import { APPLICATIONS, removeApplication, setApplication } from '@rag/pipeline';
import type { ApplicationKey } from '@rag/pipeline';
import type { Json } from '@rag/db';
import { withPlatformRoute } from '@/lib/platform-auth';
import { badRequest, parseId } from '@/lib/route';
import { applicationConfigSchema, firstError } from '@/lib/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Switch an application on for a tenant, or replace its config (PUT), and
 * switch it off (DELETE). The key must be one the registry knows (D-033: an
 * application is code; a row only switches it on). What a config may hold
 * is the triggers' to say (tenant_applications_validate,
 * tenant_applications_booking_page): timezone, booking_type, weekend_days,
 * currency, max_stay_nights, max_advance_days, booking_page. A refused
 * config comes back as a 400 with the trigger's own sentence; switching off
 * while a booking is live is a 409 (plan § 8 q7).
 */
function applicationKey(raw: string): ApplicationKey | null {
  return Object.hasOwn(APPLICATIONS, raw) ? (raw as ApplicationKey) : null;
}

export const PUT = withPlatformRoute<{ id: string; key: string }>(async (request, { platform, params }) => {
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid tenant id');
  const key = applicationKey(params.key);
  if (!key) return badRequest(`No application "${params.key}". The applications are: ${Object.keys(APPLICATIONS).join(', ')}`);
  const parsed = applicationConfigSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  return NextResponse.json(await setApplication(platform, id, key, parsed.data.config as Json));
});

export const DELETE = withPlatformRoute<{ id: string; key: string }>(async (_request, { platform, params }) => {
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid tenant id');
  const key = applicationKey(params.key);
  if (!key) return badRequest(`No application "${params.key}". The applications are: ${Object.keys(APPLICATIONS).join(', ')}`);
  return NextResponse.json(await removeApplication(platform, id, key));
});
