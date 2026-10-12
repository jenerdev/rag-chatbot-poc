// The Bookings screen's list of stays over HTTP: a staff stay is listed while
// it runs, confirmed, then CANCELLED as a whole (the stay-level action), and
// a second cancel of it is still 200; a pending one cannot be "cancelled"
// (it is declined), 404. Cleans up after itself.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/stays-list-walk.mjs)
//
// Needs pnpm dev.

import { randomBytes } from 'node:crypto';
import { supabase } from '../packages/db/dist/service.js';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const SLUG = 'harbor';
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', SLUG).single();
let userId;
const groups = [];
try {
  const email = `stays-walk-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  userId = data.user.id;
  const m = await supabase.from('memberships').insert({ user_id: userId, tenant_id: tenant.id, role: 'admin' });
  if (m.error) throw new Error(m.error.message);
  const r = await fetch(`${BASE}/api/t/${SLUG}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0];
  if (!cookie) throw new Error('login failed');
  const call = (path, init = {}) => fetch(`${BASE}/api/t/${SLUG}${path}`, { ...init, headers: { 'Content-Type': 'application/json', cookie } });

  const setup = await (await call('/bookings/setup')).json();
  const night = setup.slots.find((s) => s.nightly);
  const { data: unit } = await supabase.from('units').select('id').eq('tenant_id', tenant.id).eq('active', true).order('sort_order').limit(1).single();
  const day = (n) => { const d = new Date(`${setup.today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const book = async (offset) => {
    const res = await call('/bookings', { method: 'POST', body: JSON.stringify({ slotId: night.id, rooms: [{ unitId: unit.id, guests: 1 }], checkIn: day(offset), nights: 2, name: 'Stays Walk', phone: '0917 555 0101', email: 'stays.walk@example.com' }) });
    const body = await res.json();
    if (res.status !== 201) throw new Error(`book ${res.status} ${body.error}`);
    groups.push(body.groupId);
    return body;
  };
  const listed = async (groupId, from) => (await (await call(`/bookings/requests${from ? `?from=${from}` : ''}`)).json()).find((s) => s.groupId === groupId);

  // 1. Listed, pending, two nights, one row.
  const a = await book(200);
  const rowA = await listed(a.groupId);
  check(rowA?.status === 'pending' && rowA.nights === 2 && rowA.reference === a.bookings[0].reference, '1. a staff stay is ONE row in the list, pending, 2 nights', JSON.stringify(rowA && { status: rowA.status, nights: rowA.nights, ref: rowA.reference }));

  // 2. Still listed on its LAST night (the list keeps a stay until it ends).
  const onLast = await listed(a.groupId, day(201));
  const afterEnd = await listed(a.groupId, day(202));
  check(!!onLast && !afterEnd, '2. listed from a date on its last night, not from the day after', `last night ${!!onLast}, after ${!!afterEnd}`);

  // 3. A pending stay cannot be cancelled (it is declined): 404, unchanged.
  const early = await call(`/bookings/requests/${a.groupId}`, { method: 'PATCH', body: JSON.stringify({ action: 'cancel' }) });
  check(early.status === 404 && (await listed(a.groupId))?.status === 'pending', '3. cancel on a pending stay → 404, still pending', String(early.status));

  // 4. Confirm (a note: harbor may track payment), then cancel the stay whole.
  const conf = await call(`/bookings/requests/${a.groupId}`, { method: 'PATCH', body: JSON.stringify({ action: 'confirm', note: 'stays walk: paid at the desk' }) });
  const cancel = await call(`/bookings/requests/${a.groupId}`, { method: 'PATCH', body: JSON.stringify({ action: 'cancel', note: 'stays walk: guest called' }) });
  const { data: rows } = await supabase.from('bookings').select('status').eq('tenant_id', tenant.id).eq('group_id', a.groupId);
  const again = await call(`/bookings/requests/${a.groupId}`, { method: 'PATCH', body: JSON.stringify({ action: 'cancel' }) });
  check(
    conf.status === 200 && cancel.status === 200 && rows.length === 2 && rows.every((x) => x.status === 'cancelled') && again.status === 200,
    '4. confirm, then cancel: both nights cancelled in one call; cancelling again is 200',
    `confirm ${conf.status} · cancel ${cancel.status} · rows ${rows.map((x) => x.status).join(',')} · again ${again.status}`,
  );

  // 5. Its nights are free: the same unit and nights can be confirmed by another stay.
  const b = await book(200);
  const confB = await call(`/bookings/requests/${b.groupId}`, { method: 'PATCH', body: JSON.stringify({ action: 'confirm', note: 'stays walk: second' }) });
  check(confB.status === 200, '5. a second stay on the freed nights confirms', String(confB.status));
} catch (error) {
  check(false, 'walk', error.message);
} finally {
  for (const g of groups) await supabase.from('bookings').delete().eq('tenant_id', tenant.id).eq('group_id', g);
  if (userId) await supabase.auth.admin.deleteUser(userId);
}
console.log(`\n${failures === 0 ? 'all passed' : `${failures} FAILED`}`);
process.exit(failures ? 1 : 0);
