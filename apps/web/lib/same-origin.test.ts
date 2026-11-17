import { describe, expect, it } from 'vitest';
import { crossOriginRefusal, requestHost } from './same-origin';

// Audit S-7 (D-164).
const HOST = 'resort.example.com';

describe('crossOriginRefusal', () => {
  it('lets every safe method through, whatever its origin', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(crossOriginRefusal(method, 'https://evil.example', 'text/plain', HOST)).toBeNull();
    }
  });

  it('lets our own pages post JSON and multipart', () => {
    expect(crossOriginRefusal('POST', `https://${HOST}`, 'application/json', HOST)).toBeNull();
    expect(crossOriginRefusal('PATCH', `https://${HOST}`, 'application/json; charset=utf-8', HOST)).toBeNull();
    expect(crossOriginRefusal('POST', `https://${HOST}`, 'multipart/form-data; boundary=x', HOST)).toBeNull();
    expect(crossOriginRefusal('DELETE', `https://${HOST}`, null, HOST)).toBeNull();
  });

  it('refuses another site, a sibling subdomain, another port and an opaque origin (403)', () => {
    for (const origin of ['https://evil.example', `https://other.${HOST}`, `https://${HOST}:8443`, 'null', 'not a url']) {
      expect(crossOriginRefusal('POST', origin, 'application/json', HOST)?.status).toBe(403);
    }
  });

  it('compares hosts without regard to case, and with the port when there is one', () => {
    expect(crossOriginRefusal('POST', 'https://Resort.Example.com', 'application/json', HOST)).toBeNull();
    expect(crossOriginRefusal('POST', 'http://localhost:3000', 'application/json', 'localhost:3000')).toBeNull();
    expect(crossOriginRefusal('POST', 'http://localhost:3001', 'application/json', 'localhost:3000')?.status).toBe(403);
  });

  it("refuses the two types a plain HTML form sends without a preflight (415), even from our own origin", () => {
    expect(crossOriginRefusal('POST', `https://${HOST}`, 'text/plain;charset=UTF-8', HOST)).toEqual({ status: 415, error: 'Send this request as JSON.' });
    expect(crossOriginRefusal('PUT', null, 'application/x-www-form-urlencoded', HOST)?.status).toBe(415);
  });

  it('lets a request with no Origin through to the route (curl, the walks: no cookie jar to ride)', () => {
    expect(crossOriginRefusal('POST', null, 'application/json', HOST)).toBeNull();
  });
});

describe('requestHost', () => {
  it('is the Host header, or the URL host without one', () => {
    expect(requestHost(new Request('http://x.test/a', { headers: { host: HOST } }))).toBe(HOST);
    expect(requestHost(new Request('http://x.test:3000/a'))).toBe('x.test:3000');
  });
});
