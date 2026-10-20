import { NextResponse } from 'next/server';
import { requestChange } from '@rag/bookings';
import { requireApplication } from '@/lib/applications';
import { MANAGE_NOT_FOUND } from '@/lib/manage';
import { notifyAfter } from '@/lib/notify';
import { allow, clientIp } from '@/lib/rate-limit';
import { badRequest } from '@/lib/route';
import { changeRequestSchema, firstError } from '@/lib/schemas';
import { requireFeature } from '@/lib/feature-flags';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A guest asks to cancel or move a stay (plan/manage-booking.md Phase 6).
 * `dryRun: true` only quotes: the refund the policy gives today, or the new
 * price and the difference; nothing is stored. OPEN, on the CHAT token,
 * the lookup's per-IP window; request_change() matches the guest, checks
 * the policy and the new dates, and stores at most one open request.
 * Nothing changes the stay until staff approve it (plan Rule 1).
 */
export const POST = withTenantRoute(async (request, { tenant }) => {
  await requireApplication(tenant, 'bookings');
  await requireFeature(tenant, 'manage_booking');
  const parsed = changeRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  if (!(await allow(tenant, `manage|${tenant.id}|${clientIp(request)}`))) {
    return NextResponse.json({ error: 'Too many attempts from here. Please try again in a few minutes.' }, { status: 429 });
  }
  const { reference, contact, kind, newCheckIn, reason, dryRun } = parsed.data;
  const result = await requestChange(tenant, { reference, contact, kind, newCheckIn: newCheckIn ?? null, reason: reason ?? null, dryRun: dryRun ?? false });
  if (!result) return NextResponse.json({ error: MANAGE_NOT_FOUND }, { status: 404 });
  // A real request is news; a dry run (the guest reading the terms) is not.
  if (!dryRun) notifyAfter(tenant);
  return NextResponse.json(result, { status: dryRun ? 200 : 201 });
});
