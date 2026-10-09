// calendar-phase2-walk.mjs — the calendar route over HTTP, against a running
// dev server (plan/calendar.md Phase 2).
//
// As a throwaway STAFF member of harbor (the lowest role; bookings:read):
// the month is its whole grid (Monday to Sunday, 35 or 42 days) with every
// date's state and no `slots`; the week is 7 days with 7 × rooms × slots slot
// rows; the day is 1 date; no date means the tenant's today. A `unit` narrows
// the sellable count. Then the refusals: no session 401, a made-up view 400,
// a bad date 400, northwind (no bookings application) 404.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/calendar-phase2-walk.mjs [base-url])

import { randomBytes } from 'node:crypto';
import { supabase } from '../packages/db/dist/service.js';

const BASE = process.argv[2] ?? 'http://localhost:3000';
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

const { data: harbor } = await supabase.from('tenants').select('id').eq('slug', 'harbor').single();
const { count: rooms } = await supabase.from('units').select('id', { count: 'exact', head: true }).eq('tenant_id', harbor.id).eq('active', true);
const { count: slots } = await supabase.from('slots').select('id', { count: 'exact', head: true }).eq('tenant_id', harbor.id).eq('active', true);
const { data: room } = await supabase.from('units').select('id').eq('tenant_id', harbor.id).eq('active', true).limit(1).single();

let userId;
try {
  const email = `calendar-walk-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  userId = data.user.id;
  const m = await supabase.from('memberships').insert({ user_id: userId, tenant_id: harbor.id, role: 'staff' });
  if (m.error) throw new Error(m.error.message);
  const login = await fetch(`${BASE}/api/t/harbor/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (login.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0];
  if (!cookie) throw new Error('login failed');
  const get = (query, slug = 'harbor', withCookie = true) => fetch(`${BASE}/api/t/${slug}/calendar${query}`, { headers: withCookie ? { cookie } : {} });

  // 1. The month: October 2026's grid is 28 Sep to 1 Nov, 35 days.
  const month = await (await get('?view=month&date=2026-10-15')).json();
  const states = new Set(month.days?.map((d) => d.state));
  check(
    month.from === '2026-09-28' && month.to === '2026-11-01' && month.days?.length === 35 && month.slots === null
      && month.days.every((d) => d.sellable === rooms * slots || d.state === 'closed' || d.state === 'none'),
    '1. month: the whole grid, 35 dates, sellable = rooms × slots, no slot rows',
    `${month.from}..${month.to} ${month.days?.length} days · states ${[...states].join(',')} · sellable ${rooms}×${slots}`,
  );

  // 2. The week and the day.
  const week = await (await get('?view=week&date=2026-10-15')).json();
  const day = await (await get('?view=day&date=2026-10-15')).json();
  check(
    week.from === '2026-10-12' && week.to === '2026-10-18' && week.days.length === 7 && week.slots.length === 7 * rooms * slots,
    '2. week: Monday to Sunday, 7 × rooms × slots slot rows',
    `${week.from}..${week.to} · ${week.slots?.length} slot rows`,
  );
  check(day.days.length === 1 && day.slots.length === rooms * slots && day.days[0].day === '2026-10-15', '2b. day: one date, its slot rows', `${day.slots?.length} slot rows`);

  // 3. No date: the tenant's today, inside the returned grid.
  const now = await (await get('')).json();
  check(now.view === 'month' && now.date === now.today && now.from <= now.today && now.today <= now.to, '3. no view, no date: the month of the tenant\'s today', `${now.view} ${now.date} today ${now.today}`);

  // 4. One room.
  const one = await (await get(`?view=week&date=2026-10-15&unit=${room.id}`)).json();
  check(one.days.every((d) => d.sellable === slots || d.state === 'closed') && one.slots.every((s) => s.unitId === room.id), '4. one room: sellable = slots, every slot row that room\'s', `${one.days.map((d) => d.sellable).join('')}`);

  // 5. Refusals.
  const noSession = await get('?view=month', 'harbor', false);
  const badView = await get('?view=year');
  const badDate = await get('?date=15-10-2026');
  const northwind = await fetch(`${BASE}/api/t/northwind/calendar`);
  check(noSession.status === 401 && badView.status === 400 && badDate.status === 400, '5. no session 401, a made-up view 400, a bad date 400', `${noSession.status} · ${badView.status} ${(await badView.json()).error} · ${badDate.status}`);
  check([401, 404].includes(northwind.status), '5b. northwind (no bookings application, no session) is refused', String(northwind.status));
} finally {
  if (userId) await supabase.auth.admin.deleteUser(userId);
}

console.log(`\n${failures === 0 ? 'all passed' : `${failures} FAILED`}`);
process.exit(failures ? 1 : 0);
