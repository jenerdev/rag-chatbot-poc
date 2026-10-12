// @rag/push — Web Push, hand-written (plan/notifications.md Phase 3, § 7 q6).
//
// No Firebase and no `web-push` package: a push is an HTTPS POST to the
// browser's own push service, its body encrypted to the device (RFC 8291,
// encrypt.ts) and signed for by this server (RFC 8292, vapid.ts). Every
// step is node:crypto. Reading order: base64url, encrypt, vapid, endpoint,
// send.
//
// Server only: the VAPID private key is a secret like the token signer
// (Rule 4). It is read in ONE function, vapidKeys(), here; `server-only`
// makes importing this package from a Client Component a build error.

import 'server-only';
import { vapidKeysFromJwk, type VapidKeys } from './vapid.js';

export { encryptPayload } from './encrypt.js';
export { isPushEndpoint, PUSH_SERVICE_HOSTS } from './endpoint.js';
export { PUSH_TTL_SECONDS, sendPush, type PushResult, type PushTarget } from './send.js';
export { publicKeyObject, vapidAuthorization, vapidKeysFromJwk, type VapidKeys } from './vapid.js';

let cached: VapidKeys | null | undefined;

/**
 * The server's VAPID keys, or null when push is not configured: then layer 2
 * is off and says so, and the in-app layer still works. Read from
 * VAPID_PRIVATE_JWK and VAPID_SUBJECT; VAPID_PUBLIC_KEY, when set, must be
 * the private key's own public half (a mismatched pair would subscribe
 * browsers to a key nobody can sign for).
 */
export function vapidKeys(): VapidKeys | null {
  if (cached !== undefined) return cached;
  const jwk = process.env.VAPID_PRIVATE_JWK?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim();
  if (!jwk || !subject) return (cached = null);
  const keys = vapidKeysFromJwk(jwk, subject);
  const configured = process.env.VAPID_PUBLIC_KEY?.trim();
  if (configured && configured.replace(/=+$/, '') !== keys.publicKey) throw new Error('VAPID_PUBLIC_KEY is not the public half of VAPID_PRIVATE_JWK');
  return (cached = keys);
}
