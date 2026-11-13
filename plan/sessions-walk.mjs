// Audit S-6 (D-163): a copied session cookie stops working when its owner
// logs out or sets a new password. Over HTTP, against pnpm dev or next start.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/sessions-walk.mjs)
//
// A throwaway villa STAFF member and a throwaway SUPER user, made here and
// deleted at the end with their audit rows. No email is sent: the recovery
// token comes from the admin API (generateLink) and is exchanged directly.
//
// 1. Staff: log in twice (two devices); both cookies work. Log out on device
//    A: A's cookie, replayed (a copy), is now refused; device B still works.
// 2. Staff: a new password through the reset route ends device B too, and
//    the route says one open session was signed out.
// 3. Platform: log in, the cookie works; log out; the replayed cookie is
//    refused. The platform cookie lasts 4 hours (Max-Age / Expires).
import { randomBytes } from 'node:crypto';
import { anonClient } from '../packages/db/dist/index.js';
import { supabase } from '../packages/db/dist/service.js';

const BASE = process.env.WALK_BASE ?? 'http://localhost:3000';
const SLUG = 'villa';
const RUN_START = new Date().toISOString();
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
// A fresh address per run: the login limit counts in Postgres (D-137, D-157).
const ip = `198.19.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const headers = (cookie) => ({ 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(cookie ? { cookie } : {}) });
const login = async (path, name, email, password) => {
  const response = await fetch(`${BASE}${path}`, { method: 'POST', headers: headers(), body: JSON.stringify({ email, password }) });
  const set = (response.headers.getSetCookie?.() ?? []).find((c) => c.startsWith(`${name}=`));
  if (!set) throw new Error(`${path} login failed: ${response.status}`);
  return { cookie: set.split(';')[0], set };
};
const status = async (path, cookie, method = 'GET') => (await fetch(`${BASE}${path}`, { method, headers: headers(cookie) })).status;

const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', SLUG).single();
const users = [];
let superUser = null;
try {
  const make = async (label) => {
    const email = `sessions-walk-${label}-${Date.now()}@example.com`;
    const password = randomBytes(18).toString('base64url');
    const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(error.message);
    users.push(data.user.id);
    return { id: data.user.id, email, password };
  };

  // 1.
  const staff = await make('staff');
  const m = await supabase.from('memberships').insert({ user_id: staff.id, tenant_id: tenant.id, role: 'staff' });
  if (m.error) throw new Error(m.error.message);
  const session = `/api/t/${SLUG}/admin/session`;
  const guarded = `/api/t/${SLUG}/dashboard?days=7`;
  const a = await login(session, 'rag_admin', staff.email, staff.password);
  const b = await login(session, 'rag_admin', staff.email, staff.password);
  const before = [await status(guarded, a.cookie), await status(guarded, b.cookie)];
  await status(session, a.cookie, 'DELETE');
  const after = [await status(guarded, a.cookie), await status(guarded, b.cookie)];
  check(
    before.join() === '200,200' && after.join() === '401,200',
    '1. staff: two devices work; after logout on A, a copy of A\'s cookie is refused (401) and B still works',
    `before ${before.join(',')} · after ${after.join(',')}`,
  );

  // 2.
  const link = await supabase.auth.admin.generateLink({ type: 'recovery', email: staff.email });
  if (link.error) throw new Error(`generateLink: ${link.error.message}`);
  const anon = anonClient();
  const otp = await anon.auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: 'recovery' });
  if (otp.error) throw new Error(`verifyOtp: ${otp.error.message}`);
  const reset = await fetch(`${BASE}/api/t/${SLUG}/admin/password`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ accessToken: otp.data.session.access_token, password: randomBytes(18).toString('base64url') }),
  });
  const said = (await reset.json().catch(() => ({}))).message ?? '';
  const bAfter = await status(guarded, b.cookie);
  check(
    reset.status === 200 && /One open session was signed out/.test(said) && bAfter === 401,
    '2. staff: a new password ends device B too (401), and the route says one open session was signed out',
    `${reset.status} "${said}" · B ${bAfter}`,
  );

  // 3.
  const sup = await make('super');
  const s = await supabase.from('platform_admins').insert({ user_id: sup.id });
  if (s.error) throw new Error(s.error.message);
  superUser = sup.id;
  const p = await login('/api/platform/session', 'rag_platform', sup.email, sup.password);
  const tenants = '/api/platform/tenants';
  const pBefore = await status(tenants, p.cookie);
  await status('/api/platform/session', p.cookie, 'DELETE');
  const pAfter = await status(tenants, p.cookie);
  const expires = /Expires=([^;]+)/i.exec(p.set)?.[1];
  const hours = expires ? (new Date(expires).getTime() - Date.now()) / 3600000 : NaN;
  check(
    pBefore === 200 && pAfter === 401 && hours > 3.9 && hours <= 4.01,
    '3. platform: the cookie works, a copy is refused after logout (401), and it lasts 4 hours',
    `before ${pBefore} · after ${pAfter} · ${hours.toFixed(2)} h`,
  );
} catch (error) {
  check(false, 'walk', error.message);
} finally {
  if (superUser) await supabase.from('platform_admins').delete().eq('user_id', superUser);
  for (const id of users) {
    await supabase.from('memberships').delete().eq('user_id', id);
    const { error } = await supabase.auth.admin.deleteUser(id);
    if (error) console.log(`WARN  could not delete ${id}: ${error.message}`);
    await supabase.from('audit_log').delete().eq('actor_user', id);
    await supabase.from('audit_log').delete().eq('subject', id);
  }
  const swept = await supabase.from('audit_log').delete({ count: 'exact' }).eq('actor_kind', 'system').gte('at', RUN_START).eq('tenant_id', tenant.id);
  console.log(`cleanup: ${users.length} users deleted; swept ${swept.count ?? 0} system audit row(s)`);
}
console.log(failures === 0 ? '\nALL SESSIONS WALK CHECKS PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
