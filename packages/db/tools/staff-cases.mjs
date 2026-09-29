// staff-cases.mjs — auth-rls Phase 5's done-when, over HTTP, against a
// running `pnpm dev` (plan/auth-rls.md § 3 Phase 5, the six curl cases).
//
// Creates its own throwaway users in Supabase Auth, each with a random
// password it never prints, and deletes them at the end. Deleting a user
// cascades to its memberships.
//
//   node --conditions=react-server --env-file=../../.env tools/staff-cases.mjs [base-url]

import { randomBytes } from 'node:crypto';
import { supabase } from '../dist/service.js';

const BASE = process.argv[2] ?? 'http://localhost:3000';
let failures = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  — ${detail}`);
  if (!ok) failures++;
};

const { data: tenants } = await supabase.from('tenants').select('id, slug').in('slug', ['villa', 'northwind']);
const idOf = Object.fromEntries(tenants.map((t) => [t.slug, t.id]));

const stamp = Date.now();
const users = {};
async function makeUser(name, memberOf) {
  const email = `staff-case-${name}-${stamp}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`create ${name}: ${error.message}`);
  for (const slug of memberOf) {
    const { error: memberError } = await supabase.from('memberships').insert({ user_id: data.user.id, tenant_id: idOf[slug], role: 'admin' });
    if (memberError) throw new Error(`membership ${name}/${slug}: ${memberError.message}`);
  }
  users[name] = { id: data.user.id, email, password };
}

const login = (slug, email, password) =>
  fetch(`${BASE}/api/t/${slug}/admin/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
const cookieOf = (response) => (response.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('rag_admin='))?.split(';')[0];
const asCookie = (cookie, path, init = {}) =>
  fetch(`${BASE}${path}`, { ...init, headers: { ...(init.headers ?? {}), Cookie: cookie } });
const errorOf = async (response) => (await response.clone().json().catch(() => ({}))).error;

try {
  await makeUser('member', ['villa']);
  await makeUser('outsider', []); // a real account, member of nothing
  await makeUser('northwinder', ['northwind']);

  // 1. The right password, as a member → 200, and a cookie.
  const ok = await login('villa', users.member.email, users.member.password);
  const cookie = cookieOf(ok);
  check(ok.status === 200 && !!cookie, '1. right password, as a member → 200', `${ok.status}, cookie ${cookie ? `${cookie.split('.').length} parts` : 'MISSING'}`);

  // 2–4. Three different failures, ONE message.
  const wrong = await login('villa', users.member.email, 'not-the-password');
  const unknown = await login('villa', `nobody-${stamp}@example.com`, 'whatever-it-is');
  const outsider = await login('villa', users.outsider.email, users.outsider.password);
  const [m2, m3, m4] = await Promise.all([errorOf(wrong), errorOf(unknown), errorOf(outsider)]);
  check(wrong.status === 401, '2. wrong password → 401', `${wrong.status} "${m2}"`);
  check(unknown.status === 401 && m3 === m2, '3. unknown email → 401, same message', `${unknown.status}, same: ${m3 === m2}`);
  check(outsider.status === 401 && m4 === m2, '4. a valid user who is not a member → 401, same message', `${outsider.status}, same: ${m4 === m2}`);

  // The session works, and admin WRITES are back: a staff token under RLS.
  const listed = await asCookie(cookie, '/api/t/villa/documents');
  const docs = listed.ok ? await listed.json() : [];
  check(listed.status === 200 && docs.length > 0, 'the session lists documents', `${listed.status}, ${docs.length} documents`);
  const created = await asCookie(cookie, '/api/t/villa/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'staff-cases probe', content: 'The staff probe word is quartzlantern.' }),
  });
  const doc = created.ok ? await created.json() : null;
  const removed = doc ? await asCookie(cookie, `/api/t/villa/documents/${doc.id}`, { method: 'DELETE' }) : null;
  check(created.status === 201 && removed?.ok, 'a member can add and delete a document', `add ${created.status}${doc ? '' : ` "${await errorOf(created)}"`}, delete ${removed?.status}`);
  // Bookings: a chat token also gets `200 []` here (it reads no bookings row),
  // so "200 and an array" proves nothing. Book a real slot through the route,
  // then list it back, then hard-delete it.
  {
    const { data: unit } = await supabase.from('units').select('id').eq('tenant_id', idOf.villa).limit(1).single();
    const { data: slot } = await supabase.from('slots').select('id').eq('tenant_id', idOf.villa).eq('name', 'Day Tour').single();
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
    d.setDate(d.getDate() + 250);
    const date = d.toISOString().slice(0, 10);
    const booked = await asCookie(cookie, '/api/t/villa/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unitId: unit.id, slotId: slot.id, date, guestName: 'staff-cases probe' }),
    });
    const row = booked.ok ? await booked.json() : null;
    const listed = await asCookie(cookie, `/api/t/villa/bookings?from=${date}&to=${date}`);
    const rows = listed.ok ? await listed.json() : [];
    check(
      booked.status === 201 && rows.some((r) => r.id === row?.id && r.guestName === 'staff-cases probe'),
      'a member can book, and list the booking with its guest name',
      `book ${booked.status}${row ? ` #${row.id}` : ` "${await errorOf(booked)}"`}, list ${listed.status} (${rows.length} on ${date})`,
    );
    if (row) await supabase.from('bookings').delete().eq('tenant_id', idOf.villa).eq('id', row.id);
  }

  // 6. Another tenant's cookie, sent by hand to villa → 401.
  const nw = await login('northwind', users.northwinder.email, users.northwinder.password);
  const nwCookie = cookieOf(nw);
  const crossed = await asCookie(nwCookie, '/api/t/villa/documents');
  check(nw.status === 200 && crossed.status === 401, "6. another tenant's cookie sent by hand → 401", `northwind login ${nw.status}, at villa ${crossed.status} "${await errorOf(crossed)}"`);

  // 5. Removed mid-session: the SAME cookie, next request → 401.
  await supabase.from('memberships').delete().eq('user_id', users.member.id).eq('tenant_id', idOf.villa);
  const after = await asCookie(cookie, '/api/t/villa/documents');
  const session = await (await asCookie(cookie, '/api/t/villa/admin/session')).json();
  check(after.status === 401 && session.admin === false, '5. removed mid-session, next request → 401', `${after.status} "${await errorOf(after)}", session says admin ${session.admin}`);

  // The reset request, for an email with no account: the generic answer.
  // (Comparing it with a REAL account needs a deliverable inbox. Supabase's
  // sender refuses example.com addresses with "Email address … is invalid",
  // which the route surfaces as a 500. Observed on this script's first run,
  // and recorded in whats-done.md rather than swallowed.)
  const resetUnknown = await fetch(`${BASE}/api/t/villa/admin/password-reset`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `nobody-${stamp}@example.org` }),
  });
  const ru = await resetUnknown.json();
  check(resetUnknown.status === 200 && /If that email has a staff account/.test(ru.message ?? ''), 'password-reset for an unknown email: the generic answer', `${resetUnknown.status}: ${ru.message ?? ru.error}`);
} finally {
  for (const user of Object.values(users)) {
    const { error } = await supabase.auth.admin.deleteUser(user.id);
    if (error) console.log(`WARN  could not delete ${user.email}: ${error.message}`);
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nALL STAFF CASES PASS');
process.exit(failures ? 1 : 0);
