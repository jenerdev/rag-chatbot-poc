// notifications-devices-walk.mjs — "Turn off on all my devices" (R-51,
// plan/notifications.md Phase 7) over HTTP, against pnpm dev.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/notifications-devices-walk.mjs)
//
// Two throwaway villa members. The first has two devices (seeded on the
// service client, as a lost phone and a laptop), the second one. GET counts
// the first member's two; DELETE { all: true } removes those two and not
// the other member's; a bad body is a 400. Everything is deleted at the end.

import { randomBytes, randomUUID } from 'node:crypto';
import { supabase } from '../packages/db/dist/service.js';

const BASE = 'http://localhost:3000';
const SLUG = 'villa';
const KEYS = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', SLUG).single();
const users = [];
const member = async (role) => {
  const email = `devices-walk-${role}-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  users.push(data.user.id);
  await supabase.from('memberships').insert({ user_id: data.user.id, tenant_id: tenant.id, role });
  const r = await fetch(`${BASE}/api/t/${SLUG}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0];
  if (!cookie) throw new Error('login failed');
  return { id: data.user.id, cookie };
};
const device = (userId) => ({ tenant_id: tenant.id, user_id: userId, endpoint: `https://fcm.googleapis.com/fcm/send/devices-walk-${randomUUID()}`, ...KEYS });

try {
  const me = await member('staff');
  const other = await member('staff');
  const seeded = await supabase.from('push_subscriptions').insert([device(me.id), device(me.id), device(other.id)]);
  if (seeded.error) throw new Error(seeded.error.message);
  const api = `${BASE}/api/t/${SLUG}/admin/push`;

  const got = await (await fetch(api, { headers: { cookie: me.cookie } })).json();
  check(got.devices === 2 && typeof got.publicKey === 'string', '1. GET counts this member’s devices (2), not the other member’s', JSON.stringify({ devices: got.devices, publicKey: !!got.publicKey }));

  const bad = await fetch(api, { method: 'DELETE', headers: { cookie: me.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ all: 'yes' }) });
  check(bad.status === 400, '2. DELETE with a body that is neither { endpoint } nor { all: true } is a 400', `${bad.status} ${(await bad.json()).error}`);

  const del = await fetch(api, { method: 'DELETE', headers: { cookie: me.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }) });
  const body = await del.json();
  const mine = (await supabase.from('push_subscriptions').select('id').eq('tenant_id', tenant.id).eq('user_id', me.id)).data?.length;
  const theirs = (await supabase.from('push_subscriptions').select('id').eq('tenant_id', tenant.id).eq('user_id', other.id)).data?.length;
  check(del.status === 200 && body.removed === 2 && mine === 0 && theirs === 1, '3. DELETE { all: true } removes this member’s 2 devices and leaves the other member’s', `${del.status} removed ${body.removed} · mine ${mine} · theirs ${theirs}`);

  const after = await (await fetch(api, { headers: { cookie: me.cookie } })).json();
  const anon = await fetch(api, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }) });
  check(after.devices === 0 && anon.status === 401, '4. then GET counts 0; without a session the DELETE is a 401', `devices ${after.devices} · anon ${anon.status}`);
} finally {
  for (const id of users) await supabase.auth.admin.deleteUser(id);
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
