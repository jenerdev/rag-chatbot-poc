// dashboard-phase4-walk.mjs — the dashboard route over HTTP, by role, against
// a running `pnpm dev` (plan/dashboard.md Phase 4). Creates two throwaway
// users (a staff member and an admin of harbor, the admin also of villa and
// northwind), logs each in, reads the dashboard and checks the SHAPE the
// screen draws from; deletes the users at the end.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/dashboard-phase4-walk.mjs)

import { randomBytes } from 'node:crypto';
import { supabase } from '../packages/db/dist/service.js';

const BASE = process.argv[2] ?? 'http://localhost:3000';
let failures = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  — ${detail}`);
  if (!ok) failures++;
};

const { data: tenants } = await supabase.from('tenants').select('id, slug').in('slug', ['villa', 'northwind', 'harbor']);
const idOf = Object.fromEntries(tenants.map((t) => [t.slug, t.id]));
const stamp = Date.now();
const users = {};
async function makeUser(name, memberOf, role) {
  const email = `dash-walk-${name}-${stamp}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`create ${name}: ${error.message}`);
  for (const slug of memberOf) {
    const { error: e } = await supabase.from('memberships').insert({ user_id: data.user.id, tenant_id: idOf[slug], role });
    if (e) throw new Error(`membership ${name}/${slug}: ${e.message}`);
  }
  users[name] = { id: data.user.id, email, password };
}
const login = async (slug, u) => {
  const r = await fetch(`${BASE}/api/t/${slug}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: u.email, password: u.password }) });
  const cookie = (r.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('rag_admin='))?.split(';')[0];
  if (!cookie) throw new Error(`login ${slug}: ${r.status}`);
  return cookie;
};
const get = (cookie, path) => fetch(`${BASE}${path}`, { headers: { Cookie: cookie } });

try {
  await makeUser('staffer', ['harbor'], 'staff');
  await makeUser('admin', ['harbor', 'villa', 'northwind'], 'admin');

  // 1. harbor as STAFF: everything but money.
  let c = await login('harbor', users.staffer);
  let r = await get(c, '/api/t/harbor/dashboard');
  let d = await r.json();
  check(r.status === 200 && d.bookings && d.bookings.money === null, '1. harbor, staff → 200, bookings present, money null', `${r.status}, money=${JSON.stringify(d.bookings?.money)}`);
  check(d.days === 30 && Array.isArray(d.chat.perDay) && d.chat.perDay.length === 30, '2. the default window is 30 days with 30 perDay rows', `days=${d.days}, perDay=${d.chat.perDay?.length}`);
  check(/^\d{4}-\d{2}-\d{2}$/.test(d.chat.perDay[0].day) && /^\d{4}-\d{2}-\d{2}$/.test(d.bookings.stays.perWeek[0]?.weekOf ?? '0000-00-00'), '3. perDay.day and perWeek.weekOf are calendar dates', `${d.chat.perDay[0].day}, ${d.bookings.stays.perWeek[0]?.weekOf}`);
  check(d.bookings.occupancy !== null && typeof d.bookings.occupancy.percent === 'number', '4. harbor (per_room) has occupancy', `${JSON.stringify(d.bookings.occupancy && { percent: d.bookings.occupancy.percent, activeUnits: d.bookings.occupancy.activeUnits })}`);
  r = await get(c, '/api/t/harbor/dashboard?days=7');
  d = await r.json();
  check(d.days === 7 && d.chat.perDay.length === 7, '5. ?days=7 → 7 rows', `days=${d.days}, perDay=${d.chat.perDay.length}`);
  r = await get(c, '/api/t/harbor/dashboard?days=500');
  d = await r.json();
  check(r.status === 200 && d.days === 90 && d.chat.perDay.length === 90, '6. ?days=500 → clamped to 90 (plan § 4.2)', `${r.status}, days=${d.days}, perDay=${d.chat.perDay?.length}`);
  r = await get(c, '/api/t/villa/dashboard');
  check(r.status === 401 || r.status === 403, '7. the harbor cookie on villa → not 200', `${r.status}`);

  // 2. harbor as ADMIN: money present.
  c = await login('harbor', users.admin);
  r = await get(c, '/api/t/harbor/dashboard');
  d = await r.json();
  check(r.status === 200 && d.bookings?.money && typeof d.bookings.money.confirmed === 'number' && Array.isArray(d.bookings.money.perWeek), '8. harbor, admin → money present', `confirmed=${d.bookings?.money?.confirmed}, perWeek=${d.bookings?.money?.perWeek?.length}`);
  check(Array.isArray(d.bookings.promos), '9. promos is a list', `${d.bookings.promos.length} promos`);

  // 3. villa (whole_resort): bookings, no occupancy.
  c = await login('villa', users.admin);
  r = await get(c, '/api/t/villa/dashboard');
  d = await r.json();
  check(r.status === 200 && d.bookings && d.bookings.occupancy === null, '10. villa → bookings, occupancy null', `${r.status}, occupancy=${JSON.stringify(d.bookings?.occupancy)}`);

  // 4. northwind: no bookings application → bookings null, three cards.
  c = await login('northwind', users.admin);
  r = await get(c, '/api/t/northwind/dashboard');
  d = await r.json();
  check(r.status === 200 && d.bookings === null && typeof d.knowledge.documents === 'number' && typeof d.team.owners === 'number', '11. northwind → bookings null, knowledge and team present', `${r.status}, documents=${d.knowledge?.documents}, owners=${d.team?.owners}`);

  // 5. The pages themselves.
  for (const slug of ['harbor', 'villa', 'northwind']) {
    const page = await fetch(`${BASE}/t/${slug}/admin/dashboard`);
    const html = await page.text();
    check(page.status === 200 && html.includes('Dashboard'), `12. /t/${slug}/admin/dashboard → 200 with the title`, `${page.status}`);
  }
} finally {
  for (const u of Object.values(users)) {
    const { error } = await supabase.auth.admin.deleteUser(u.id);
    if (error) console.log(`cleanup: ${error.message}`);
  }
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
