// unanswered-bulk-walk.mjs — S-4's checkboxes over HTTP, against a running dev
// server (2026-10-09): unanswered/resolutions resolves and reopens a SET of
// questions in one request.
//
// On harbor's REAL open questions, as a throwaway STAFF member (the lowest
// role that may write them): two open ids, plus an id that does not exist
// and one of villa's refusals, are PUT; exactly the two come back resolved,
// and villa's stays open (wall 1 and 2 together: it is not harbor's). The
// Resolved list has them; a DELETE of the same set reopens exactly the two,
// so harbor ends as it began. Then the refusals: no session 401, an empty
// set 400, a string 400, 201 ids 400.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/unanswered-bulk-walk.mjs [base-url])

import { randomBytes } from 'node:crypto';
import { supabase } from '../packages/db/dist/service.js';
import { NO_ANSWER } from '../packages/rag/dist/constants.js';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const API = `${BASE}/api/t/harbor`;
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const same = (a, b) => JSON.stringify([...a].sort((x, y) => x - y)) === JSON.stringify([...b].sort((x, y) => x - y));

const { data: tenants } = await supabase.from('tenants').select('id, slug').in('slug', ['harbor', 'villa']);
const harbor = tenants.find((t) => t.slug === 'harbor');
const villa = tenants.find((t) => t.slug === 'villa');
const { data: villaRefusal } = await supabase
  .from('messages')
  .select('id')
  .eq('tenant_id', villa.id)
  .eq('role', 'assistant')
  .eq('content', NO_ANSWER)
  .limit(1)
  .maybeSingle();

let userId;
try {
  const email = `unanswered-bulk-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  userId = data.user.id;
  const m = await supabase.from('memberships').insert({ user_id: userId, tenant_id: harbor.id, role: 'staff' });
  if (m.error) throw new Error(m.error.message);
  const login = await fetch(`${API}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (login.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0];
  if (!cookie) throw new Error('login failed');
  const send = (method, body, withCookie = true) =>
    fetch(`${API}/unanswered/resolutions`, { method, headers: { 'Content-Type': 'application/json', ...(withCookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const list = async (resolved) => (await (await fetch(`${API}/unanswered${resolved ? '?resolved=1' : ''}`, { headers: { cookie } })).json()).map((q) => q.id);

  const open = await list(false);
  check(open.length >= 2, '0. harbor has at least two open questions', `${open.length}`);
  const two = open.slice(0, 2);
  const foreign = villaRefusal?.id ?? null;
  check(foreign !== null, '0b. villa has a refusal to try', String(foreign));

  // 1. Resolve the set: only harbor's two come back.
  const put = await send('PUT', { ids: [...two, 999999999, ...(foreign ? [foreign] : [])] });
  const putBody = await put.json();
  check(put.status === 200 && same(putBody.resolved, two), '1. PUT resolves exactly the two', `${put.status} ${JSON.stringify(putBody)}`);
  const nowOpen = await list(false);
  const nowResolved = await list(true);
  check(two.every((id) => !nowOpen.includes(id) && nowResolved.includes(id)), '1b. they moved from Open to Resolved');
  if (foreign) {
    const { count } = await supabase.from('unanswered_resolutions').select('message_id', { count: 'exact', head: true }).eq('message_id', foreign);
    check(count === 0, "1c. villa's refusal got no resolution", `${count} rows`);
  }

  // 2. Reopen the same set: harbor is back as it was.
  const del = await send('DELETE', { ids: [...two, 999999999, ...(foreign ? [foreign] : [])] });
  const delBody = await del.json();
  check(del.status === 200 && same(delBody.reopened, two), '2. DELETE reopens exactly the two', `${del.status} ${JSON.stringify(delBody)}`);
  check(same(await list(false), open), '2b. the Open list is what it was');

  // 3. Refusals.
  check((await send('PUT', { ids: two }, false)).status === 401, '3. no session: 401');
  const empty = await send('PUT', { ids: [] });
  check(empty.status === 400, '3b. an empty set: 400', JSON.stringify(await empty.json()));
  check((await send('PUT', { ids: 'all' })).status === 400, '3c. not a list: 400');
  const many = await send('PUT', { ids: Array.from({ length: 201 }, (_, i) => i + 1) });
  check(many.status === 400, '3d. 201 ids: 400', JSON.stringify(await many.json()));
} finally {
  if (userId) await supabase.auth.admin.deleteUser(userId);
}

console.log(`\n${failures === 0 ? 'all passed' : `${failures} FAILED`}`);
process.exit(failures ? 1 : 0);
