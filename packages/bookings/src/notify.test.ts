import { beforeEach, describe, expect, it, vi } from 'vitest';

// @rag/push is server-only and does network I/O; here it is a fake, so the
// drain's own logic is what is tested: who is sent what, and what is recorded.
const sendPush = vi.fn();
const vapidKeys = vi.fn();
vi.mock('@rag/push', () => ({ sendPush: (...a: unknown[]) => sendPush(...a), vapidKeys: () => vapidKeys() }));

const { drainNotifications, pushMessage } = await import('./notify');

describe('pushMessage', () => {
  it('says what waits, with the reference and the dates, and links to where it is dealt with', () => {
    expect(pushMessage('villa', { kind: 'request', reference: 'VIL-ABC234', first_night: '2026-10-16', nights: 3 })).toEqual({
      kind: 'request',
      reference: 'VIL-ABC234',
      title: 'New booking request',
      body: 'VIL-ABC234 · 3 nights from Fri 16 Oct',
      path: '/t/villa/admin/bookings/VIL-ABC234',
    });
    expect(pushMessage('villa', { kind: 'proof', reference: 'VIL-ABC234', first_night: '2026-10-16', nights: 1 })).toMatchObject({
      title: 'A proof of payment to verify',
      body: 'VIL-ABC234 · Fri 16 Oct',
      path: '/t/villa/admin/payments',
    });
    expect(pushMessage('villa', { kind: 'change', reference: 'VIL-ABC234', first_night: null, nights: null })).toMatchObject({
      title: 'A guest asks to change a stay',
      body: 'VIL-ABC234',
    });
  });

  it('carries the named fields only: no guest name, phone, email or amount (Rule 2)', () => {
    const row = { kind: 'request', reference: 'VIL-ABC234', first_night: '2026-10-16', nights: 1, guest_name: 'Ana', guest_phone: '0917', amount: 500000 };
    expect(Object.keys(pushMessage('villa', row)).sort()).toEqual(['body', 'kind', 'path', 'reference', 'title']);
    expect(JSON.stringify(pushMessage('villa', row))).not.toMatch(/Ana|0917|500000/);
  });
});

describe('drainNotifications', () => {
  const claimed = [
    { outbox_id: 1, kind: 'request', reference: 'VIL-AAA222', first_night: '2026-10-16', nights: 2, subscription_id: 10, endpoint: 'https://fcm.googleapis.com/a', p256dh: 'p', auth: 'a' },
    { outbox_id: 1, kind: 'request', reference: 'VIL-AAA222', first_night: '2026-10-16', nights: 2, subscription_id: 11, endpoint: 'https://fcm.googleapis.com/b', p256dh: 'p', auth: 'a' },
  ];
  const calls: { fn: string; args: unknown }[] = [];
  const db = {
    rpc: async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      return fn === 'notify_claim' ? { data: claimed, error: null } : { data: null, error: null };
    },
  };
  const tenant = { id: 3, slug: 'villa', db } as never;

  beforeEach(() => {
    calls.length = 0;
    sendPush.mockReset();
    vapidKeys.mockReset();
  });

  it('claims nothing when push is not configured (the rows wait)', async () => {
    vapidKeys.mockReturnValue(null);
    expect(await drainNotifications(tenant)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('sends each claimed device its message, and records every answer', async () => {
    vapidKeys.mockReturnValue({ publicKey: 'k' });
    sendPush.mockResolvedValueOnce('ok').mockResolvedValueOnce('gone');
    const result = await drainNotifications(tenant);
    expect(result).toEqual({ messages: 1, ok: 1, gone: 1, retry: 0 });
    expect(sendPush).toHaveBeenCalledTimes(2);
    expect(sendPush.mock.calls[0]![1]).toMatchObject({ title: 'New booking request', path: '/t/villa/admin/bookings/VIL-AAA222' });
    expect(sendPush.mock.calls[0]![3]).toBe('VIL-AAA222');
    expect(calls.map((c) => c.fn)).toEqual(['notify_claim', 'notify_done']);
    expect(calls[0]!.args).toEqual({ p_tenant_id: 3 });
    const results = (calls[1]!.args as { p_results: { outbox: number; subscription: number; result: string }[] }).p_results;
    expect(results.sort((a, b) => a.subscription - b.subscription)).toEqual([
      { outbox: 1, subscription: 10, result: 'ok' },
      { outbox: 1, subscription: 11, result: 'gone' },
    ]);
  });
});
