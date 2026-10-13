import { NextResponse } from 'next/server';
import { markNotificationsRead, notificationFeed } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { badRequest } from '@/lib/route';
import { firstError, notificationsReadSchema } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The Notifications item (plan/notifications.md § 8): what arrived for the
 * signed-in member in the last 30 days, and which they have read. Any member
 * (`bookings:read`); which rows a role sees is the database's decision (RLS:
 * a proof only for owners and admins, as the push).
 *
 * GET  → { unread, items }, newest first.
 * POST { ids } | { all: true } → { marked }: read for this member, on every
 *      device. The service worker posts here when a push is tapped.
 */
export const GET = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'bookings:read');
  await requireApplication(tenant, 'bookings');
  return NextResponse.json(await notificationFeed(tenant), { headers: { 'Cache-Control': 'no-store' } });
});

export const POST = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'bookings:read');
  await requireApplication(tenant, 'bookings');
  const parsed = notificationsReadSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  const marked = await markNotificationsRead(tenant, 'ids' in parsed.data ? parsed.data.ids : null);
  return NextResponse.json({ marked });
});
