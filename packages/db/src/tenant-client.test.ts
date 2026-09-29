import { generateKeyPairSync } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintPlatformToken, mintTenantToken, TENANT_TOKEN_SECONDS } from './tenant-client.js';

// The two token SHAPES (plan/tenant-management.md Rule 1; CLAUDE.md rule 8),
// read back out of the tokens the shipped signer produces. A throwaway P-256
// key stands in for TENANT_SIGNING_JWK: the claims are what is under test,
// not the signature, which PostgREST checks (verify.mjs does that, live).

const USER = '11111111-2222-4333-8444-555555555555';
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as Record<string, unknown>;

beforeAll(() => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  process.env.TENANT_SIGNING_JWK = JSON.stringify({ ...privateKey.export({ format: 'jwk' }), kid: 'test-kid' });
});

describe('mintTenantToken', () => {
  it('chat: a tenant and nothing about a user', () => {
    const claims = claimsOf(mintTenantToken({ tenantId: 7 }));
    expect(claims.role).toBe('authenticated');
    expect(claims.tenant_id).toBe(7);
    expect(claims).not.toHaveProperty('sub');
    expect(claims).not.toHaveProperty('app_admin');
    expect(claims).not.toHaveProperty('app_super');
    expect((claims.exp as number) - (claims.iat as number)).toBe(TENANT_TOKEN_SECONDS);
  });

  it('staff: the user and app_admin, never app_super, and no role claim (the role is a row)', () => {
    const claims = claimsOf(mintTenantToken({ tenantId: 7, userId: USER, admin: true }));
    expect(claims.sub).toBe(USER);
    expect(claims.app_admin).toBe(true);
    expect(claims).not.toHaveProperty('app_super');
    expect(Object.keys(claims).sort()).toEqual(['app_admin', 'exp', 'iat', 'role', 'sub', 'tenant_id']);
  });
});

describe('mintPlatformToken', () => {
  it('the user and app_super, NO tenant, NO app_admin, still authenticated, still five minutes', () => {
    const claims = claimsOf(mintPlatformToken({ userId: USER }));
    expect(claims.role).toBe('authenticated');
    expect(claims.sub).toBe(USER);
    expect(claims.app_super).toBe(true);
    expect(claims).not.toHaveProperty('tenant_id');
    expect(claims).not.toHaveProperty('app_admin');
    expect((claims.exp as number) - (claims.iat as number)).toBe(TENANT_TOKEN_SECONDS);
    expect(Object.keys(claims).sort()).toEqual(['app_super', 'exp', 'iat', 'role', 'sub']);
  });

  it('refuses anything but a uuid for the user', () => {
    expect(() => mintPlatformToken({ userId: 'service_role' })).toThrow(/uuid/);
  });

  it('the header names our key, ES256', () => {
    const header = JSON.parse(Buffer.from(mintPlatformToken({ userId: USER }).split('.')[0], 'base64url').toString());
    expect(header).toEqual({ alg: 'ES256', typ: 'JWT', kid: 'test-kid' });
  });
});
