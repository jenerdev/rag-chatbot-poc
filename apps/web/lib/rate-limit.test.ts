import { describe, expect, it } from 'vitest';
import {
  allow,
  allowAuth,
  allowSpend,
  CHAT_REQUESTS_PER_WINDOW,
  clientIp,
  hashed,
  LOGIN_PER_ACCOUNT,
  LOGIN_PER_ADDRESS,
  MAX_REQUESTS_PER_WINDOW,
  platformAuthKeys,
  RESET_PER_ACCOUNT,
  RESET_PER_ADDRESS,
  TENANT_CEILING_PER_WINDOW,
  tenantAuthKeys,
  WINDOW_SECONDS,
} from './rate-limit';

// allow() is a thin wrapper over rate_allow() (schema-rate-limit.sql); the
// SQL is proved live by verify 225–229. What is tested here is the wrapper's
// contract: which arguments reach the function, what each answer becomes,
// and that an error is thrown, never swallowed into "allowed" (Rule 4).

type Call = { fn: string; args: Record<string, unknown> };
function fakeTenant(answers: Array<boolean | Error>) {
  const calls: Call[] = [];
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      const next = answers.shift();
      if (next instanceof Error) return { data: null, error: { message: next.message } };
      return { data: next, error: null };
    },
  };
  return { tenant: { id: 7, db } as unknown as Parameters<typeof allow>[0], calls };
}

describe('clientIp', () => {
  const req = (forwarded?: string) => new Request('http://x/', { headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded } });
  it('is the first X-Forwarded-For entry', () => {
    expect(clientIp(req('203.0.113.9, 10.0.0.1'))).toBe('203.0.113.9');
    expect(clientIp(req(' 203.0.113.9 '))).toBe('203.0.113.9');
  });
  it('is "local" with no header or an empty one', () => {
    expect(clientIp(req())).toBe('local');
    expect(clientIp(req(''))).toBe('local');
  });
});

describe('allow', () => {
  it('sends the tenant id, the key, the max and the window to rate_allow', async () => {
    const { tenant, calls } = fakeTenant([true]);
    await expect(allow(tenant, 'chat|7|1.2.3.4', 30)).resolves.toBe(true);
    expect(calls).toEqual([{ fn: 'rate_allow', args: { p_tenant_id: 7, p_key: 'chat|7|1.2.3.4', p_max: 30, p_window_seconds: WINDOW_SECONDS } }]);
  });
  it('defaults max to the request limit', async () => {
    const { tenant, calls } = fakeTenant([true]);
    await allow(tenant, 'k');
    expect(calls[0]?.args.p_max).toBe(MAX_REQUESTS_PER_WINDOW);
    expect(WINDOW_SECONDS).toBe(600);
  });
  it('is false when the function says so', async () => {
    const { tenant } = fakeTenant([false]);
    await expect(allow(tenant, 'k')).resolves.toBe(false);
  });
  it('throws on a database error instead of allowing (Rule 4)', async () => {
    const { tenant } = fakeTenant([new Error('connection refused')]);
    await expect(allow(tenant, 'k')).rejects.toThrow(/rate_allow: connection refused/);
  });
});

describe('allowSpend', () => {
  it("checks the address's window, then the tenant's ceiling", async () => {
    const { tenant, calls } = fakeTenant([true, true]);
    await expect(allowSpend(tenant, 'chat', '1.2.3.4', CHAT_REQUESTS_PER_WINDOW)).resolves.toBe(true);
    expect(calls.map((c) => [c.args.p_key, c.args.p_max])).toEqual([
      ['chat|7|1.2.3.4', CHAT_REQUESTS_PER_WINDOW],
      ['chat|7|*', TENANT_CEILING_PER_WINDOW],
    ]);
  });
  it('does not bump the ceiling for a refused address', async () => {
    const { tenant, calls } = fakeTenant([false]);
    await expect(allowSpend(tenant, 'voice-in', '1.2.3.4', 30)).resolves.toBe(false);
    expect(calls).toHaveLength(1);
  });
  it('is false when the ceiling is met', async () => {
    const { tenant } = fakeTenant([true, false]);
    await expect(allowSpend(tenant, 'chat', '1.2.3.4', 30)).resolves.toBe(false);
  });
});

// Audit S-2 (D-157): the sign-in and reset doors.
describe('hashed', () => {
  it('is one account for any case or surrounding space, and never the email itself', () => {
    expect(hashed(' Ann@Example.com ')).toBe(hashed('ann@example.com'));
    expect(hashed('ann@example.com')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashed('ann@example.com')).not.toBe(hashed('bob@example.com'));
  });
});

describe('tenantAuthKeys', () => {
  it('is the address, then the hashed account, under the scope and tenant', () => {
    const [address, account] = tenantAuthKeys(7, 'login', '1.2.3.4', 'Ann@x.com');
    expect(address).toBe('login|7|ip|1.2.3.4');
    expect(account).toBe(`login|7|acct|${hashed('ann@x.com')}`);
    expect(account).not.toContain('@');
    expect(tenantAuthKeys(7, 'reset', '1.2.3.4', 'a@x.com')[0]).toBe('reset|7|ip|1.2.3.4');
  });
});

describe('platformAuthKeys', () => {
  it('holds only hashes, in the one shape platform_rate_allow() accepts', () => {
    const shape = /^platform-(login|reset)\|[0-9a-f]{64}$/;
    const keys = [...platformAuthKeys('login', '1.2.3.4', 'a@x.com'), ...platformAuthKeys('reset', 'local', 'a@x.com')];
    for (const key of keys) expect(key).toMatch(shape);
    expect(keys.join()).not.toContain('1.2.3.4');
    const [address, account] = platformAuthKeys('login', 'a@x.com', 'a@x.com');
    expect(address).not.toBe(account); // an address and an account never share a count
  });
});

describe('allowAuth', () => {
  it("checks the address, then the account, with the scope's limits", async () => {
    const { tenant, calls } = fakeTenant([true, true]);
    await expect(allowAuth(tenant, 'login', '1.2.3.4', 'a@x.com')).resolves.toBe(true);
    expect(calls.map((c) => [c.args.p_key, c.args.p_max])).toEqual([
      ['login|7|ip|1.2.3.4', LOGIN_PER_ADDRESS],
      [`login|7|acct|${hashed('a@x.com')}`, LOGIN_PER_ACCOUNT],
    ]);
    const reset = fakeTenant([true, true]);
    await allowAuth(reset.tenant, 'reset', '1.2.3.4', 'a@x.com');
    expect(reset.calls.map((c) => c.args.p_max)).toEqual([RESET_PER_ADDRESS, RESET_PER_ACCOUNT]);
  });
  it('does not spend the account for a refused address', async () => {
    const { tenant, calls } = fakeTenant([false]);
    await expect(allowAuth(tenant, 'login', '1.2.3.4', 'a@x.com')).resolves.toBe(false);
    expect(calls).toHaveLength(1);
  });
  it('is false when the account is over, and throws on a database error', async () => {
    await expect(allowAuth(fakeTenant([true, false]).tenant, 'login', '1.2.3.4', 'a@x.com')).resolves.toBe(false);
    await expect(allowAuth(fakeTenant([new Error('down')]).tenant, 'reset', '1.2.3.4', 'a@x.com')).rejects.toThrow(/down/);
  });
});
