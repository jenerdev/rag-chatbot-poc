// vapid.mjs — print a NEW VAPID key pair for .env (plan/notifications.md Phase 4).
//
//   pnpm --filter @rag/push vapid
//
// Prints the three lines to paste into .env. The private JWK is a secret like
// TENANT_SIGNING_JWK: keep it out of git and out of NEXT_PUBLIC_. Changing it
// later orphans every subscription (each was made for the old public key):
// members then press "Notify me on this device" again.

import { generateKeyPairSync } from 'node:crypto';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = privateKey.export({ format: 'jwk' });
const point = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);

console.log(`VAPID_PUBLIC_KEY=${point.toString('base64url')}`);
console.log(`VAPID_PRIVATE_JWK=${JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d })}`);
console.log('VAPID_SUBJECT=mailto:you@example.com');
