// vapid.ts — who is sending (RFC 8292, "VAPID for Web Push").
//
// A push service accepts a message for a subscription only from the server
// whose public key the browser was given when it subscribed
// (applicationServerKey). The server proves it with a short JWT signed
// ES256 by the matching private key, in the Authorization header:
//
//   Authorization: vapid t=<jwt>, k=<our public key, base64url>
//
// The JWT says which push service it is for (aud: the endpoint's origin),
// until when (exp: at most 24 h; we use 12) and who to contact (sub: a
// mailto: or https: address). The signature is ES256 in JOSE's raw r||s
// form, which is node:crypto's `ieee-p1363` encoding (DER is the default
// and would be refused). The same signer as mintTenantToken(), another key.

import { createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { fromBase64url, toBase64url } from './base64url.js';

export interface VapidKeys {
  privateKey: KeyObject;
  /** the uncompressed P-256 point, base64url: what the browser is given as applicationServerKey */
  publicKey: string;
  /** mailto: or https: — the push service's contact if this server misbehaves */
  subject: string;
}

/** How long a VAPID JWT lives. RFC 8292 caps it at 24 h. */
const VAPID_TTL_SECONDS = 12 * 60 * 60;

/** A private P-256 JWK → the key, and its public point as the browser wants it. */
export function vapidKeysFromJwk(jwkText: string, subject: string): VapidKeys {
  const jwk = JSON.parse(jwkText) as { kty?: string; crv?: string; d?: string; x?: string; y?: string };
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) throw new Error('VAPID_PRIVATE_JWK must be a private P-256 JWK (kty EC, crv P-256, with d, x, y)');
  if (!/^(mailto:|https:\/\/)/.test(subject)) throw new Error('VAPID_SUBJECT must be a mailto: or https:// address');
  const privateKey = createPrivateKey({ key: jwk as never, format: 'jwk' });
  const point = Buffer.concat([Buffer.from([0x04]), fromBase64url(jwk.x), fromBase64url(jwk.y)]);
  return { privateKey, publicKey: toBase64url(point), subject };
}

/** The Authorization header for one push service (its origin is the JWT's audience). */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, now = Date.now()): string {
  const audience = new URL(endpoint).origin;
  const part = (value: object) => toBase64url(Buffer.from(JSON.stringify(value)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: audience, exp: Math.floor(now / 1000) + VAPID_TTL_SECONDS, sub: keys.subject })}`;
  const signature = sign('sha256', Buffer.from(unsigned), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${toBase64url(signature)}, k=${keys.publicKey}`;
}

/** The public point → a key node:crypto can verify with (for the tests, and for a check of a configured pair). */
export function publicKeyObject(publicKey: string): KeyObject {
  const point = fromBase64url(publicKey);
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: toBase64url(point.subarray(1, 33)), y: toBase64url(point.subarray(33, 65)) } as never, format: 'jwk' });
}
