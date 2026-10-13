import { NextResponse } from 'next/server';
import { deviceCount, deviceOf, removeAllDevices, removeDevice, saveDevice } from '@rag/bookings';
import { vapidKeys } from '@rag/push';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { badRequest } from '@/lib/route';
import { firstError, pushDeviceSchema, pushRemoveSchema } from '@/lib/schemas';
import { requireFeature } from '@/lib/feature-flags';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * THIS device's push subscription, for the signed-in member
 * (plan/notifications.md Phase 4). Any member (`session`): who may hear a
 * proof is decided when it is sent, from the role (Rule 3), not here. Only
 * a tenant with bookings has anything to notify of.
 *
 * GET ?endpoint= → { publicKey, kinds, devices }: the server's VAPID public
 * key (null when push is not configured: the sidebar then says so), this
 * device's kinds (null: not subscribed), and how many devices the member
 * has here, for "Turn off on all my devices" (R-51). The public key is not a secret; it is sent
 * here rather than threaded as a prop through every staff screen.
 */
export const GET = withTenantRoute(async (request, { tenant }) => {
  const staff = await requireAdmin(request, tenant, 'session');
  tenant = staff;
  await requireApplication(tenant, 'bookings');
  await requireFeature(tenant, 'notifications');
  const endpoint = new URL(request.url).searchParams.get('endpoint');
  const [device, devices] = await Promise.all([endpoint && /^https:\/\//.test(endpoint) ? deviceOf(tenant, endpoint) : null, deviceCount(tenant, staff.userId)]);
  return NextResponse.json({ publicKey: vapidKeys()?.publicKey ?? null, kinds: device?.kinds ?? null, devices }, { headers: { 'Cache-Control': 'no-store' } });
});

export const POST = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'session');
  await requireApplication(tenant, 'bookings');
  await requireFeature(tenant, 'notifications');
  if (!vapidKeys()) return NextResponse.json({ error: 'Push notifications are not set up on this server.' }, { status: 503 });
  const parsed = pushDeviceSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  const { endpoint, keys, kinds } = parsed.data;
  const saved = await saveDevice(tenant, { endpoint, p256dh: keys.p256dh, auth: keys.auth, kinds, userAgent: request.headers.get('user-agent') });
  return NextResponse.json(saved, { status: 201 });
});

export const DELETE = withTenantRoute(async (request, { tenant }) => {
  const staff = await requireAdmin(request, tenant, 'session');
  tenant = staff;
  await requireApplication(tenant, 'bookings');
  await requireFeature(tenant, 'notifications');
  const parsed = pushRemoveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  // { all: true }: every device of THIS member (R-51, a lost phone); the member is the session's.
  if ('all' in parsed.data) return NextResponse.json({ removed: await removeAllDevices(tenant, staff.userId) });
  return NextResponse.json({ removed: await removeDevice(tenant, parsed.data.endpoint) });
});
