import { describe, expect, it, vi } from 'vitest';

// notify.ts imports @rag/push (server-only); the feed never sends, so a stub.
vi.mock('@rag/push', () => ({ sendPush: vi.fn(), vapidKeys: () => null }));

const { markNotificationsRead, notificationFeed, parseFeed } = await import('./notifications');

const row = { id: 7, kind: 'request', reference: 'VIL-ABC234', firstNight: '2026-10-16', nights: 2, at: '2026-10-14T03:00:00Z', read: false };

describe('parseFeed', () => {
  it('says each row in the push’s own words, with its link and read flag', () => {
    expect(parseFeed('villa', { unread: 3, items: [row, { ...row, id: 6, kind: 'proof', read: true }] })).toEqual({
      unread: 3,
      items: [
        { id: 7, kind: 'request', reference: 'VIL-ABC234', title: 'New booking request', body: 'VIL-ABC234 · 2 nights from Fri 16 Oct', path: '/t/villa/admin/bookings/VIL-ABC234', at: '2026-10-14T03:00:00Z', read: false },
        { id: 6, kind: 'proof', reference: 'VIL-ABC234', title: 'A proof of payment to verify', body: 'VIL-ABC234 · 2 nights from Fri 16 Oct', path: '/t/villa/admin/payments', at: '2026-10-14T03:00:00Z', read: true },
      ],
    });
  });

  it('reads nothing into a missing or odd body', () => {
    expect(parseFeed('villa', null)).toEqual({ unread: 0, items: [] });
    expect(parseFeed('villa', { unread: '2', items: 'x' })).toEqual({ unread: 0, items: [] });
  });

  it('carries only named fields, whatever else a row holds', () => {
    const [item] = parseFeed('villa', { unread: 1, items: [{ ...row, guest_name: 'Ana', amount: 500000 }] }).items;
    expect(Object.keys(item!).sort()).toEqual(['at', 'body', 'id', 'kind', 'path', 'read', 'reference', 'title']);
  });
});

describe('the two calls', () => {
  it('name the tenant, the limit and the ids', async () => {
    const calls: { fn: string; args: unknown }[] = [];
    const tenant = {
      id: 3,
      slug: 'villa',
      db: { rpc: async (fn: string, args: unknown) => (calls.push({ fn, args }), { data: fn === 'notification_read' ? 2 : { unread: 0, items: [] }, error: null }) },
    } as never;
    expect(await notificationFeed(tenant, 5)).toEqual({ unread: 0, items: [] });
    expect(await markNotificationsRead(tenant, [7, 8])).toBe(2);
    expect(await markNotificationsRead(tenant, null)).toBe(2);
    expect(calls).toEqual([
      { fn: 'notification_feed', args: { p_tenant_id: 3, p_limit: 5 } },
      { fn: 'notification_read', args: { p_tenant_id: 3, p_ids: [7, 8] } },
      { fn: 'notification_read', args: { p_tenant_id: 3, p_ids: null } },
    ]);
  });
});
