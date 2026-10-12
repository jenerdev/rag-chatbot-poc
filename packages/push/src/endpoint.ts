// endpoint.ts — which URLs the server will POST a push to.
//
// A subscription's endpoint is a URL the browser hands us and the drain
// later POSTs to. Taken on trust, it would let a member make the server
// POST to anything it can reach: an internal host, a cloud metadata
// address (SSRF). So an endpoint must be https on a known push service.

/** The browsers' push services, by host suffix. */
export const PUSH_SERVICE_HOSTS: readonly string[] = [
  'fcm.googleapis.com', // Chrome, Android, Opera, Samsung Internet
  'android.googleapis.com', // older Chrome subscriptions
  'updates.push.services.mozilla.com', // Firefox
  'push.services.mozilla.com',
  'web.push.apple.com', // Safari, iOS 16.4+ from the Home Screen
  'notify.windows.com', // Edge (wns2-*.notify.windows.com)
];

/** true for https://<a known push service>/…, on the default port, with no credentials. */
export function isPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}
