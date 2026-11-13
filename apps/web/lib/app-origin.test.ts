import { describe, expect, it } from 'vitest';
import { AppOriginError, appOrigin } from './app-origin';

// Audit S-13 (D-169): never the request's Host in production.
const forged = 'https://evil.example/api/t/villa/admin/password-reset';

describe('appOrigin', () => {
  it('uses APP_URL when set, whatever the request says', () => {
    expect(appOrigin({ APP_URL: 'https://resort.example.com/', NODE_ENV: 'production' }, forged)).toBe('https://resort.example.com');
    expect(appOrigin({ APP_URL: 'https://resort.example.com', VERCEL_PROJECT_PRODUCTION_URL: 'x.vercel.app' }, forged)).toBe('https://resort.example.com');
  });
  it('refuses a plain-http APP_URL in production, except localhost', () => {
    expect(() => appOrigin({ APP_URL: 'http://resort.example.com', NODE_ENV: 'production' }, forged)).toThrow(AppOriginError);
    expect(appOrigin({ APP_URL: 'http://localhost:3000', NODE_ENV: 'production' }, forged)).toBe('http://localhost:3000');
  });
  it("on Vercel without APP_URL, uses Vercel's own production domain", () => {
    expect(appOrigin({ VERCEL_PROJECT_PRODUCTION_URL: 'rag-chatbot.vercel.app', NODE_ENV: 'production' }, forged)).toBe('https://rag-chatbot.vercel.app');
  });
  it('in development, uses the request origin (localhost), as before', () => {
    expect(appOrigin({ NODE_ENV: 'development' }, 'http://localhost:3000/api/t/villa/admin/password-reset')).toBe('http://localhost:3000');
  });
  it('self-hosted in production with nothing configured, refuses rather than trust the Host', () => {
    expect(() => appOrigin({ NODE_ENV: 'production' }, forged)).toThrow(/Set APP_URL/);
  });
});
