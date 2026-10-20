import { describe, expect, it } from 'vitest';
import { allow, allowSpend, CHAT_REQUESTS_PER_WINDOW, clientIp, MAX_REQUESTS_PER_WINDOW, TENANT_CEILING_PER_WINDOW, WINDOW_SECONDS } from './rate-limit';

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
