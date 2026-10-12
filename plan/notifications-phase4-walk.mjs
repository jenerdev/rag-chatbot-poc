// notifications-phase4-walk.mjs — the worker, the manifest and the device
// routes over HTTP (plan/notifications.md Phase 4).
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/notifications-phase4-walk.mjs)
//
// Needs pnpm dev. A throwaway staff member of villa and of northwind (which
// has no bookings). With VAPID unset on the server, POST is a 503 that says
// so; with it set, a refused endpoint is a 400 and a real-shaped one is
// stored and removed. Everything made is deleted at the end.

import { randomBytes, randomUUID } from 'node:crypto';
import { supabase } from '../packages/db/dist/service.js';

const BASE = 'http://localhost:3000';
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const KEYS = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };

const users = [];
try {
  const login = async (slug) => {
    const email = `notify-p4-${slug}-${Date.now()}@example.com`;
    const password = randomBytes(18).toString('base64url');
    const { data: u, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(error.message);
    users.push(u.user.id);
    const { data: t } = await supabase.from('tenants').select('id').eq('slug', slug).single();
    await supabase.from('memberships').insert({ user_id: u.user.id, tenant_id: t.id, role: 'staff' });
    const r = await fetch(`${BASE}/api/t/${slug}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    return (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0];
  };
  const villa = await login('villa');
  const northwind = await login('northwind');
  const push = (cookie, method, body, slug = 'villa', query = '') =>
    fetch(`${BASE}/api/t/${slug}/admin/push${query}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });

  // 1. The worker: JavaScript, never cached stale, scoped to the tenant.
  {
    const r = await fetch(`${BASE}/t/villa/sw.js`);
    const text = await r.text();
    const missing = await fetch(`${BASE}/t/no-such-tenant/sw.js`);
    check(
      r.status === 200 && /javascript/.test(r.headers.get('content-type') ?? '') && r.headers.get('cache-control') === 'no-cache'
        && text.includes('const SCOPE = "/t/villa/"') && text.includes("addEventListener('push'") && text.includes("addEventListener('notificationclick'") && missing.status === 404,
      '1. /t/villa/sw.js is a no-cache script scoped to /t/villa/; an unknown tenant is 404',
      `${r.status} ${r.headers.get('content-type')} ${r.headers.get('cache-control')} · unknown ${missing.status}`,
    );
  }

  // 2. The manifest: the staff app, in the tenant's scope and colours.
  {
    const r = await fetch(`${BASE}/t/villa/manifest.webmanifest`);
    const m = await r.json();
    check(
      r.status === 200 && /manifest\+json/.test(r.headers.get('content-type') ?? '') && m.scope === '/t/villa/' && m.start_url === '/t/villa/admin/dashboard'
        && m.display === 'standalone' && /^#[0-9a-f]{3,6}$/i.test(m.theme_color) && /Staff$/.test(m.name),
      '2. the manifest opens the staff dashboard, scoped to /t/villa/, in its colours',
      JSON.stringify({ name: m.name, scope: m.scope, start: m.start_url, theme: m.theme_color }),
    );
  }

  // 3. The staff pages link it; the public chat does not.
  {
    const admin = await (await fetch(`${BASE}/t/villa/admin/bookings`)).text();
    const chat = await (await fetch(`${BASE}/t/villa`)).text();
    check(
      admin.includes('rel="manifest" href="/t/villa/manifest.webmanifest"') && !chat.includes('rel="manifest"'),
      '3. a staff page links the manifest; the guest chat does not',
      `admin ${admin.includes('rel="manifest"')} · chat ${chat.includes('rel="manifest"')}`,
    );
  }

  // 4. The device route: a session is required; a tenant without bookings is 404.
  const state = await (await push(villa, 'GET')).json();
  {
    const anon = await push(null, 'GET');
    const noBookings = await push(northwind, 'GET', undefined, 'northwind');
    check(
      anon.status === 401 && noBookings.status === 404 && 'publicKey' in state && state.kinds === null,
      '4. GET /admin/push: 401 without a session, 404 without bookings; a member reads the key and no device yet',
      `anon ${anon.status} · northwind ${noBookings.status} · publicKey ${state.publicKey ? 'set' : 'null'}`,
    );
  }

  // 5. Saving a device.
  const endpoint = `https://fcm.googleapis.com/fcm/send/notify-p4-${randomUUID()}`;
  if (!state.publicKey) {
    const r = await push(villa, 'POST', { endpoint, keys: KEYS, kinds: ['request'] });
    const body = await r.json();
    check(r.status === 503 && /not set up/.test(body.error), '5. push not configured: POST is a 503 that says so (layer 1 still works)', `${r.status} "${body.error}"`);
  } else {
    const internal = await push(villa, 'POST', { endpoint: 'https://169.254.169.254/latest/meta-data', keys: KEYS, kinds: ['request'] });
    const badKeys = await push(villa, 'POST', { endpoint, keys: { p256dh: 'short', auth: KEYS.auth }, kinds: ['request'] });
    const saved = await push(villa, 'POST', { endpoint, keys: KEYS, kinds: ['request', 'change'] });
    const savedBody = await saved.json();
    const read = await (await push(villa, 'GET', undefined, 'villa', `?endpoint=${encodeURIComponent(endpoint)}`)).json();
    const removed = await (await push(villa, 'DELETE', { endpoint })).json();
    const after = await (await push(villa, 'GET', undefined, 'villa', `?endpoint=${encodeURIComponent(endpoint)}`)).json();
    check(
      internal.status === 400 && badKeys.status === 400 && saved.status === 201 && savedBody.kinds.join() === 'request,change'
        && read.kinds?.join() === 'request,change' && removed.removed === true && after.kinds === null,
      '5. an internal endpoint and a bad key are 400; a push-service endpoint is stored with its kinds, read back, and removed',
      `internal ${internal.status} · keys ${badKeys.status} · saved ${saved.status} ${savedBody.kinds} · read ${read.kinds} · removed ${removed.removed} · after ${after.kinds}`,
    );
  }
} finally {
  for (const id of users) await supabase.auth.admin.deleteUser(id);
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
