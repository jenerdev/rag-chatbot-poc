import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, securityHeaders, supabaseOrigin } from './security-headers.mjs';

const directive = (csp: string, name: string) => csp.split('; ').find((line) => line === name || line.startsWith(`${name} `));

describe('supabaseOrigin', () => {
  it('keeps the origin of an https project URL', () => {
    expect(supabaseOrigin('https://abcd.supabase.co/rest/v1')).toBe('https://abcd.supabase.co');
  });
  it('allows a local Supabase over http', () => {
    expect(supabaseOrigin('http://127.0.0.1:54321')).toBe('http://127.0.0.1:54321');
  });
  it('refuses a missing, malformed or plain-http remote URL', () => {
    expect(supabaseOrigin(undefined)).toBeNull();
    expect(supabaseOrigin('not a url')).toBeNull();
    expect(supabaseOrigin('http://abcd.supabase.co')).toBeNull();
  });
});

describe('contentSecurityPolicy', () => {
  const prod = contentSecurityPolicy({ supabaseUrl: 'https://abcd.supabase.co' });

  it('lets nobody frame a page (clickjacking, audit S-1)', () => {
    expect(directive(prod, 'frame-ancestors')).toBe("frame-ancestors 'none'");
  });
  it('frames only our own pages and the proof PDF on the Supabase project', () => {
    expect(directive(prod, 'frame-src')).toBe("frame-src 'self' https://abcd.supabase.co");
    expect(directive(contentSecurityPolicy({}), 'frame-src')).toBe("frame-src 'self'");
  });
  it('sends every fetch to our own origin only', () => {
    expect(directive(prod, 'connect-src')).toBe("connect-src 'self'");
  });
  it('evaluates no code in production, and never rewrites http (next start on localhost)', () => {
    expect(directive(prod, 'script-src')).toBe("script-src 'self' 'unsafe-inline'");
    expect(directive(prod, 'upgrade-insecure-requests')).toBeUndefined();
    expect(directive(prod, 'object-src')).toBe("object-src 'none'");
  });
  it('allows next dev its eval and websocket', () => {
    const dev = contentSecurityPolicy({ dev: true });
    expect(directive(dev, 'script-src')).toContain("'unsafe-eval'");
    expect(directive(dev, 'connect-src')).toBe("connect-src 'self' ws: wss:");
    expect(directive(dev, 'frame-ancestors')).toBe("frame-ancestors 'none'");
  });
});

describe('securityHeaders', () => {
  it('carries every header the audit asked for, once each', () => {
    const keys = securityHeaders().map((h) => h.key);
    expect(keys).toEqual([
      'Content-Security-Policy',
      'X-Frame-Options',
      'Strict-Transport-Security',
      'X-Content-Type-Options',
      'Referrer-Policy',
      'Permissions-Policy',
    ]);
    const value = (key: string) => securityHeaders().find((h) => h.key === key)?.value;
    expect(value('X-Frame-Options')).toBe('DENY');
    expect(value('X-Content-Type-Options')).toBe('nosniff');
    expect(value('Permissions-Policy')).toContain('microphone=(self)');
  });
});
