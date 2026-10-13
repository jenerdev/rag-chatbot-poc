// service-worker.ts — the source of a tenant's service worker
// (plan/notifications.md § 2b.4), served by app/t/[tenant]/sw.js/route.ts.
// A pure function of the slug, so service-worker.test.ts can run it against
// a fake `self`: headless Chrome shows no notification to read back, so the
// worker's behaviour is tested here, and on a real screen by hand.
//
// It does two things and caches nothing:
//   push               show the notification the server sent (title, body),
//                      tagged by kind and reference, so a second push about
//                      the same stay replaces the first rather than stacking;
//                      and tell this tenant's open tabs, so their badge and
//                      chime (components/attention.tsx) do not wait for the
//                      next 30 s poll
//   notificationclick  mark THIS notification read for the member (the
//                      Notifications item's count, § 8), then focus an open
//                      tab of this tenant and take it to the path, or open
//                      one. A path outside the scope is not followed: the
//                      dashboard instead.
//
// The sound is the device's own (§ 2b.5); `silent: false` is all it asks.

export function serviceWorkerSource(slug: string, businessName: string): string {
  const scope = `/t/${slug}/`;
  // The name goes in a comment line: a line break in it could end the comment.
  const name = businessName.replace(/[\r\n\u2028\u2029]+/g, ' ');
  return `// ${name}: staff notifications (plan/notifications.md)
const SCOPE = ${JSON.stringify(scope)};
const HOME = SCOPE + 'admin/dashboard';
const READ = '/api' + SCOPE + 'admin/notifications';

/** This tenant's open tabs. */
async function tabs() {
  const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return open.filter((client) => new URL(client.url).pathname.startsWith(SCOPE));
}

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
  const id = Number.isInteger(message.id) && message.id > 0 ? message.id : null;
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, {
        body,
        tag: (message.kind || 'notice') + ':' + (message.reference || ''),
        renotify: true,
        silent: false,
        data: { path, id },
      });
      for (const client of await tabs()) client.postMessage({ type: 'rag-notification' });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const wanted = typeof data.path === 'string' && data.path.startsWith(SCOPE) ? data.path : HOME;
  const id = Number.isInteger(data.id) && data.id > 0 ? data.id : null;
  event.waitUntil(
    (async () => {
      // Read first, so the page it opens already counts it read. The
      // session cookie goes with it (same origin); a failure only leaves
      // it unread, to be opened from the list.
      if (id !== null) {
        await fetch(READ, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [id] }) }).catch(() => undefined);
      }
      const [client] = await tabs();
      if (client) {
        await client.focus();
        if ('navigate' in client) await client.navigate(wanted);
        return;
      }
      await self.clients.openWindow(wanted);
    })(),
  );
});
`;
}
