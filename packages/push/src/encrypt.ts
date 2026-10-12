// encrypt.ts — a push message's body, encrypted to ONE device (RFC 8291,
// "Message Encryption for Web Push", content coding aes128gcm, RFC 8188).
//
// Why encrypt at all: the push service (Google, Mozilla, Apple, Microsoft)
// carries the message and must not read it. The browser handed us two
// things when it subscribed: its public key (p256dh, a P-256 point) and a
// 16-byte secret (auth). From those, and a key pair made fresh for THIS
// message, both ends can derive the same AES key, and nobody between can.
//
//   1. ECDH: our fresh private key × the device's public key → a shared secret.
//   2. HKDF with the auth secret as salt, over "WebPush: info" and both
//      public keys → the input keying material (IKM). The auth secret is
//      what stops someone who only saw p256dh from deriving it.
//   3. HKDF with a random 16-byte salt → a 16-byte content key (CEK) and a
//      12-byte nonce, under the two labels RFC 8188 names.
//   4. AES-128-GCM over the payload followed by 0x02 (the last-record
//      delimiter, RFC 8188 § 2): one record, no padding.
//   5. The body is a header (salt, record size, our public key) and the
//      ciphertext; the device reads the salt and our key from the header.
//
// Every step is node:crypto. Checked byte for byte against RFC 8291's
// Appendix A in encrypt.test.ts.

import { createCipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { fromBase64url } from './base64url.js';

/** RFC 8188's record size field. One record holds the whole (small) payload. */
const RECORD_SIZE = 4096;

/** Fixed inputs, for the RFC's test vector only. A real send makes both fresh. */
export interface EncryptTestInputs {
  /** the application server's private key, 32 bytes */
  serverPrivateKey: Uint8Array;
  /** the 16-byte salt */
  salt: Uint8Array;
}

/**
 * The aes128gcm body for one device. `p256dh` and `auth` are the
 * subscription's keys, base64url, as the browser gave them.
 */
export function encryptPayload(plaintext: string | Uint8Array, p256dh: string, auth: string, test?: EncryptTestInputs): Buffer {
  const deviceKey = fromBase64url(p256dh);
  const authSecret = fromBase64url(auth);
  if (deviceKey.length !== 65 || deviceKey[0] !== 0x04) throw new Error('p256dh is not an uncompressed P-256 point');
  if (authSecret.length !== 16) throw new Error('auth is not 16 bytes');

  // 1. A key pair for this message alone, and the shared secret.
  const ecdh = createECDH('prime256v1');
  if (test) ecdh.setPrivateKey(Buffer.from(test.serverPrivateKey));
  else ecdh.generateKeys();
  const serverKey = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(deviceKey);

  // 2. IKM = HKDF(salt = auth, ikm = shared secret, info = "WebPush: info" 0x00 device key server key).
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), deviceKey, serverKey]);
  const ikm = Buffer.from(hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));

  // 3. The content key and the nonce, from a random salt.
  const salt = test ? Buffer.from(test.salt) : randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  // 4. One record: the payload, then the last-record delimiter.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const record = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);

  // 5. salt (16) | record size (4, big-endian) | key length (1) | our public key (65) | record.
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(serverKey.length, 20);
  return Buffer.concat([header, serverKey, record]);
}
