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
  const scope = `/t/${tenant.slug}/`;
  const body = `// ${tenant.businessName}: staff notifications (plan/notifications.md)
const SCOPE = ${JSON.stringify(scope)};
const HOME = SCOPE + 'admin/dashboard';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = {};
  }
  const title = typeof message.title === 'string' ? message.title : 'Something waits for you';
  const body = typeof message.body === 'string' ? message.body : '';
  const path = typeof message.path === 'string' && message.path.startsWith(SCOPE) ? message.path : HOME;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: (message.kind || 'notice') + ':' + (message.reference || ''),
      renotify: true,
      silent: false,
      data: { path },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const wanted = event.notification.data && typeof event.notification.data.path === 'string' && event.notification.data.path.startsWith(SCOPE) ? event.notification.data.path : HOME;
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of open) {
        if (new URL(client.url).pathname.startsWith(SCOPE)) {
          await client.focus();
          if ('navigate' in client) await client.navigate(wanted);
          return;
        }
      }
      await self.clients.openWindow(wanted);
    })(),
  );
});
`;
  return new Response(body, {
    headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' },
  });
});
