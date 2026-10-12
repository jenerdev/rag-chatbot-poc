import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fromBase64url } from './base64url';
import { isPushEndpoint } from './endpoint';
import { sendPush } from './send';
import { publicKeyObject, vapidAuthorization, vapidKeysFromJwk } from './vapid';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const keys = vapidKeysFromJwk(JSON.stringify(privateKey.export({ format: 'jwk' })), 'mailto:ops@example.com');
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc:def';

describe('vapidAuthorization', () => {
  it('is a JWT for the push service, signed ES256, that the public key verifies', () => {
    const header = vapidAuthorization(ENDPOINT, keys, Date.UTC(2026, 9, 13, 0, 0, 0));
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header) ?? [];
    expect(k).toBe(keys.publicKey);
    const [h, c, s] = jwt!.split('.');
    expect(JSON.parse(fromBase64url(h!).toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(fromBase64url(c!).toString());
    expect(claims).toEqual({ aud: 'https://fcm.googleapis.com', exp: Date.UTC(2026, 9, 13, 12, 0, 0) / 1000, sub: 'mailto:ops@example.com' });
    // Raw r||s (64 bytes), not DER: what JOSE and the push services expect.
    expect(fromBase64url(s!).length).toBe(64);
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKeyObject(keys.publicKey), dsaEncoding: 'ieee-p1363' }, fromBase64url(s!))).toBe(true);
  });

  it('gives the browser an uncompressed P-256 point', () => {
    const point = fromBase64url(keys.publicKey);
    expect(point.length).toBe(65);
    expect(point[0]).toBe(0x04);
  });

  it('refuses a public key, another curve, or a subject that is no address', () => {
    const pub = JSON.stringify(privateKey.export({ format: 'jwk' }), (key, value) => (key === 'd' ? undefined : value));
    expect(() => vapidKeysFromJwk(pub, 'mailto:a@b.c')).toThrow(/private P-256/);
    expect(() => vapidKeysFromJwk(JSON.stringify(privateKey.export({ format: 'jwk' })), 'ops@example.com')).toThrow(/mailto/);
  });
});

describe('isPushEndpoint', () => {
  it('takes the browsers’ push services over https', () => {
    for (const url of [ENDPOINT, 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/QG9', 'https://wns2-par02p.notify.windows.com/w/?token=x']) {
      expect(isPushEndpoint(url), url).toBe(true);
    }
  });

  it('refuses anything the server should not POST to', () => {
    for (const url of ['http://fcm.googleapis.com/x', 'https://localhost/x', 'https://169.254.169.254/latest', 'https://fcm.googleapis.com.evil.example/x', 'https://evilfcm.googleapis.com.example/x', 'https://fcm.googleapis.com:8443/x', 'https://u:p@fcm.googleapis.com/x', 'not a url']) {
      expect(isPushEndpoint(url), url).toBe(false);
    }
  });
});

describe('sendPush', () => {
  // A real subscription's keys (RFC 8291 Appendix A's device).
  const target = { endpoint: ENDPOINT, p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
  const answering = (status: number) => (async () => new Response(null, { status })) as unknown as typeof fetch;

  it('posts the encrypted body with the Web Push headers', async () => {
    let seen: RequestInit | undefined;
    const fake = (async (_url: string, init: RequestInit) => {
      seen = init;
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    expect(await sendPush(target, { kind: 'request' }, keys, 'VIL-ABC123', fake)).toBe('ok');
    const headers = seen!.headers as Record<string, string>;
    expect(headers['Content-Encoding']).toBe('aes128gcm');
    expect(headers.TTL).toBe('86400');
    expect(headers.Urgency).toBe('high');
    expect(headers.Topic).toBe('VIL-ABC123');
    expect(headers.Authorization).toMatch(/^vapid t=/);
    expect(seen!.redirect).toBe('error');
  });

  it('reads the answer as ok, gone or retry', async () => {
    expect(await sendPush(target, {}, keys, undefined, answering(201))).toBe('ok');
    expect(await sendPush(target, {}, keys, undefined, answering(410))).toBe('gone');
    expect(await sendPush(target, {}, keys, undefined, answering(404))).toBe('gone');
    expect(await sendPush(target, {}, keys, undefined, answering(429))).toBe('retry');
    expect(await sendPush(target, {}, keys, undefined, answering(503))).toBe('retry');
    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await sendPush(target, {}, keys, undefined, failing)).toBe('retry');
  });
});
