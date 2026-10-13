import { NextResponse } from 'next/server';
import { NOTIFICATION_POLL_ITEMS, notificationFeed } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { hasApplication } from '@/lib/applications';
import { notifyAfter } from '@/lib/notify';
import { featureOn } from '@/lib/feature-flags';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What is new for this member (plan/notifications.md § 8, which replaced
 * Phase 1's three "waiting" counts): the unread count for the Notifications
 * item's badge and the tab title, and the newest few rows, whose arrival
 * the frame announces with a toast and the chime. Polled every 30 s by
 * each open staff tab, and at once when a push reaches the device. Any
 * member (`dashboard:read`). A tenant without bookings, or with the
 * notifications feature off (D-127), has nothing to say: zero, without a query.
 */
export const GET = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'dashboard:read');
  const bookings = (await hasApplication(tenant, 'bookings')) && (await featureOn(tenant, 'notifications'));
  const feed = bookings ? await notificationFeed(tenant, NOTIFICATION_POLL_ITEMS) : { unread: 0, items: [] };
  // The sweep (§ 7 q5): whatever a guest's drain left, a staff tab sends.
  if (bookings) notifyAfter(tenant);
  return NextResponse.json({ unread: feed.unread, latest: feed.items }, { headers: { 'Cache-Control': 'no-store' } });
});
