import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fromBase64url, toBase64url } from './base64url';
import { encryptPayload } from './encrypt';

// RFC 8291, Appendix A: one message, every input fixed, the exact body.
const A = {
  plaintext: 'When I grow up, I want to be a watermelon',
  serverPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

/** The device's side, from the RFC: what a browser does with the body. */
function decrypt(body: Buffer, uaPrivate: string, auth: string): string {
  const salt = body.subarray(0, 16);
  const keyLength = body.readUInt8(20);
  const serverKey = body.subarray(21, 21 + keyLength);
  const record = body.subarray(21 + keyLength);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(fromBase64url(uaPrivate));
  const shared = ecdh.computeSecret(serverKey);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), serverKey]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, fromBase64url(auth), info, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  expect(plain[plain.length - 1]).toBe(0x02);
  return plain.subarray(0, plain.length - 1).toString();
}

describe('encryptPayload', () => {
  it('matches RFC 8291 Appendix A byte for byte', () => {
    const body = encryptPayload(A.plaintext, A.uaPublic, A.auth, { serverPrivateKey: fromBase64url(A.serverPrivate), salt: fromBase64url(A.salt) });
    expect(toBase64url(body)).toBe(A.body);
  });

  it('is read back by the device, and differs every time (a fresh key and salt)', () => {
    const one = encryptPayload('{"kind":"request"}', A.uaPublic, A.auth);
    const two = encryptPayload('{"kind":"request"}', A.uaPublic, A.auth);
    expect(decrypt(one, A.uaPrivate, A.auth)).toBe('{"kind":"request"}');
    expect(one.equals(two)).toBe(false);
  });

  it('refuses keys of the wrong shape', () => {
    expect(() => encryptPayload('x', A.auth, A.auth)).toThrow(/P-256/);
    expect(() => encryptPayload('x', A.uaPublic, A.uaPublic)).toThrow(/16 bytes/);
  });
});
