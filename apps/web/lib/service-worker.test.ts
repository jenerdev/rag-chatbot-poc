import { describe, expect, it, vi } from 'vitest';
import { serviceWorkerSource } from './service-worker';

// The worker, run against a fake `self`: what it shows for a push, and where
// a tap takes the member. Headless Chrome keeps no notification to read back,
// so this is where the worker's behaviour is proved.
function load(slug = 'villa', name = 'Villa') {
  const handlers: Record<string, (event: unknown) => void> = {};
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const navigated: string[] = [];
  const open: { url: string; focus: () => Promise<void>; navigate: (u: string) => Promise<void> }[] = [];
  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => (handlers[type] = fn),
    skipWaiting: vi.fn(),
    registration: { showNotification: async (title: string, options: Record<string, unknown>) => void shown.push({ title, options }) },
    clients: {
      claim: vi.fn(),
      matchAll: async () => open,
      openWindow: async (url: string) => void opened.push(url),
    },
  };
  new Function('self', serviceWorkerSource(slug, name))(self);
  const run = async (type: string, event: Record<string, unknown>) => {
    let waited: Promise<unknown> = Promise.resolve();
    handlers[type]!({ ...event, waitUntil: (p: Promise<unknown>) => (waited = p) });
    await waited;
  };
  const push = (message: unknown) => run('push', { data: { json: () => message } });
  const click = (path: unknown) => run('notificationclick', { notification: { close: vi.fn(), data: { path } } });
  const tab = (url: string) => open.push({ url, focus: async () => undefined, navigate: async (u: string) => void navigated.push(u) });
  return { push, click, tab, shown, opened, navigated };
}

describe('the service worker', () => {
  it('shows the server’s title and body, tagged by kind and reference, with its path', async () => {
    const sw = load();
    await sw.push({ kind: 'request', reference: 'VIL-ABC234', title: 'New booking request', body: 'VIL-ABC234 · Fri 16 Oct', path: '/t/villa/admin/bookings/VIL-ABC234' });
    expect(sw.shown).toEqual([
      { title: 'New booking request', options: { body: 'VIL-ABC234 · Fri 16 Oct', tag: 'request:VIL-ABC234', renotify: true, silent: false, data: { path: '/t/villa/admin/bookings/VIL-ABC234' } } },
    ]);
  });

  it('never takes a path outside the tenant: another tenant’s or another site’s becomes the dashboard', async () => {
    const sw = load();
    await sw.push({ title: 'x', path: '/t/harbor/admin/payments' });
    await sw.push({ title: 'y', path: 'https://evil.example/' });
    expect(sw.shown.map((n) => n.options.data)).toEqual([{ path: '/t/villa/admin/dashboard' }, { path: '/t/villa/admin/dashboard' }]);
  });

  it('shows something even for a push it cannot read', async () => {
    const sw = load();
    await sw.push(undefined);
    expect(sw.shown[0]!.title).toBe('Something waits for you');
  });

  it('a tap reuses an open tab of the tenant, else opens one, and only inside the scope', async () => {
    const sw = load();
    await sw.click('/t/villa/admin/bookings/VIL-ABC234');
    expect(sw.opened).toEqual(['/t/villa/admin/bookings/VIL-ABC234']);
    sw.tab('http://localhost:3000/t/harbor/admin/dashboard');
    sw.tab('http://localhost:3000/t/villa/admin/calendar');
    await sw.click('/t/villa/admin/payments');
    await sw.click('/t/harbor/admin/payments');
    expect(sw.navigated).toEqual(['/t/villa/admin/payments', '/t/villa/admin/dashboard']);
    expect(sw.opened).toHaveLength(1);
  });

  it('keeps a tenant name with a line break inside its comment', () => {
    expect(() => load('villa', 'Villa\nself.evil = 1')).not.toThrow();
    expect(serviceWorkerSource('villa', 'Villa\nalert(1)').split('\n')[0]).toBe('// Villa alert(1): staff notifications (plan/notifications.md)');
  });
});
