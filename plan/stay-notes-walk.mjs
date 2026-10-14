// stay-notes-walk.mjs — the staff notes routes over HTTP (D-132), against pnpm dev.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/stay-notes-walk.mjs [base])
//
// Two throwaway members of villa (a staff and an admin), on villa's newest
// stay. Adds, reads, refuses and deletes notes through the routes the page
// uses; removes its notes and both accounts at the end, whatever happened.

import { randomBytes } from 'node:crypto';
import { supabase } from '../packages/db/dist/service.js';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const stamp = Date.now();
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const { data: villa } = await supabase.from('tenants').select('id').eq('slug', 'villa').single();
const { data: stay } = await supabase.from('stays').select('reference, group_id').eq('tenant_id', villa.id).order('created_at', { ascending: false }).limit(1).single();
const users = {};

async function makeUser(name, role) {
  const email = `stay-notes-${name}-${stamp}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`create ${name}: ${error.message}`);
  users[name] = { id: data.user.id, email };
  const m = await supabase.from('memberships').insert({ user_id: data.user.id, tenant_id: villa.id, role });
  if (m.error) throw new Error(`membership ${name}: ${m.error.message}`);
  const r = await fetch(`${BASE}/api/t/villa/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  users[name].cookie = (r.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('rag_admin='))?.split(';')[0];
  if (!users[name].cookie) throw new Error(`login ${name}: ${r.status}`);
}

const api = (who, path, method = 'GET', body) =>
  fetch(`${BASE}/api/t/villa/bookings/stay/${path}`, {
    method,
    headers: { ...(who ? { Cookie: users[who].cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
const json = (r) => r.clone().json().catch(() => ({}));

try {
  await makeUser('staff', 'staff');
  await makeUser('admin', 'admin');
  const ref = stay.reference;

  const added = await api('staff', `${ref}/notes`, 'POST', { body: '  Asked for an early check-in  ' });
  const second = await api('staff', `${ref}/notes`, 'POST', { body: 'Line one\nLine two' });
  const id = (await json(added)).id;
  check(added.status === 201 && second.status === 201 && Number.isInteger(id), '1. staff add two notes: 201 with an id', `${added.status}/${second.status} id ${id}`);

  const empty = await api('staff', `${ref}/notes`, 'POST', { body: '   ' });
  const long = await api('staff', `${ref}/notes`, 'POST', { body: 'x'.repeat(2001) });
  const missing = await api('staff', `${ref}/notes`, 'POST', {});
  check(
    empty.status === 400 && (await json(empty)).error === 'Write the note first.' && long.status === 400 && /2000/.test((await json(long)).error) && missing.status === 400,
    '2. empty, 2001 characters and no body are 400, in words',
    `${empty.status} "${(await json(empty)).error}" · ${long.status} "${(await json(long)).error}" · ${missing.status}`,
  );

  const mine = (await json(await api('staff', ref))).staffNotes ?? [];
  const theirs = (await json(await api('admin', ref))).staffNotes ?? [];
  const n = mine.find((x) => x.id === id);
  const t = theirs.find((x) => x.id === id);
  check(
    n?.body === 'Asked for an early check-in' && n.mine === true && n.author === users.staff.email && t?.mine === false && t.author === users.staff.email && mine.length === theirs.length && mine.some((x) => x.body === 'Line one\nLine two'),
    "3. the stay's read carries the notes, trimmed and multi-line: mine for the author, the author's email for a colleague",
    `staff ${JSON.stringify(n)} · admin mine=${t?.mine} · counts ${mine.length}/${theirs.length}`,
  );

  const byAdmin = await api('admin', `${ref}/notes/${id}`, 'DELETE');
  const byStaff = await api('staff', `${ref}/notes/${id}`, 'DELETE');
  const again = await api('staff', `${ref}/notes/${id}`, 'DELETE');
  check(byAdmin.status === 404 && byStaff.status === 200 && again.status === 404, "4. an admin's delete of a staff member's note is 404; the author's is 200; again 404", `${byAdmin.status}/${byStaff.status}/${again.status}`);

  const unknown = await api('staff', 'XXX-NOPE00/notes', 'POST', { body: 'hello' });
  const badId = await api('staff', `${ref}/notes/abc`, 'DELETE');
  const anon = await api(null, `${ref}/notes`, 'POST', { body: 'hello' });
  check(unknown.status === 404 && badId.status === 400 && anon.status === 401, '5. an unknown reference is 404, a bad note id 400, no session 401', `${unknown.status}/${badId.status}/${anon.status}`);
} catch (error) {
  check(false, 'setup', error.message);
} finally {
  const ids = Object.values(users).map((u) => u.id);
  if (ids.length) {
    const { count } = await supabase.from('stay_notes').delete({ count: 'exact' }).eq('tenant_id', villa.id).in('author', ids);
    console.log(`cleaned: ${count ?? 0} notes`);
  }
  for (const u of Object.values(users)) await supabase.auth.admin.deleteUser(u.id);
}
console.log(failures === 0 ? '\nOK — 5 of 5.' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
