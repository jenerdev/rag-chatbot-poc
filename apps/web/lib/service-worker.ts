// service-worker.ts — the source of a tenant's service worker
// (plan/notifications.md § 2b.4), served by app/t/[tenant]/sw.js/route.ts.
// A pure function of the slug, so service-worker.test.ts can run it against
// a fake `self`: headless Chrome shows no notification to read back, so the
// worker's behaviour is tested here, and on a real screen by hand.
//
// It does two things and caches nothing:
//   push               show the notification the server sent (title, body),
//                      tagged by kind and reference, so a second push about
//                      the same stay replaces the first rather than stacking
//   notificationclick  focus an open tab of this tenant and take it to the
//                      path, or open one. A path outside the scope is not
//                      followed: the dashboard instead.
//
// The sound is the device's own (§ 2b.5); `silent: false` is all it asks.

export function serviceWorkerSource(slug: string, businessName: string): string {
  const scope = `/t/${slug}/`;
  // The name goes in a comment line: a line break in it could end the comment.
  const name = businessName.replace(/[\r\n\u2028\u2029]+/g, ' ');
  return `// ${name}: staff notifications (plan/notifications.md)
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
  // "null" parses: a push must still show something, never throw.
  if (!message || typeof message !== 'object') message = {};
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
}
