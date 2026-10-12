import { serviceWorkerSource } from '@/lib/service-worker';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The tenant's service worker (plan/notifications.md § 2b.4): served at
 * /t/<slug>/sw.js, so its scope is /t/<slug>/ and a person in two tenants
 * has two registrations, each with its own push subscription. `no-cache`,
 * so an edit here reaches browsers on their next visit.
 *
 * It does two things and caches nothing:
 *   push               show the notification the server sent (title, body),
 *                      tagged by kind and reference, so a second push about
 *                      the same stay replaces the first rather than stacking
 *   notificationclick  focus an open tab of this tenant and take it to the
 *                      path, or open one. A path outside the scope is not
 *                      followed: the dashboard instead.
 *
 * The sound is the device's own (§ 2b.5); `silent: false` is all it asks.
 */
export const GET = withTenantRoute(async (_request, { tenant }) => {
  const body = serviceWorkerSource(tenant.slug, tenant.businessName);
  return new Response(body, {
    headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' },
  });
});
