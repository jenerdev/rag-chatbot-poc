// Screenshots of the Calendar (S-12) on harbor, desktop and phone: the
// month, the week and a day, with a few stays seeded through the staff
// route (pending and confirmed, over several rooms and dates), deleted at
// the end. Prints the page width and any console error.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/calendar-shots.mjs)
//
// Needs pnpm dev.

import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = 'http://localhost:3000';
const SLUG = 'harbor';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', 'calendar');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', SLUG).single();
const groups = [];
let userId;
let browser;
try {
  const email = `calendar-shots-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data: u, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  userId = u.user.id;
  await supabase.from('memberships').insert({ user_id: userId, tenant_id: tenant.id, role: 'admin' });
  const r = await fetch(`${BASE}/api/t/${SLUG}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0];
  if (!cookie) throw new Error('login failed');
  const call = (path, init = {}) => fetch(`${BASE}/api/t/${SLUG}${path}`, { ...init, headers: { 'Content-Type': 'application/json', cookie } });

  const setup = await (await call('/bookings/setup')).json();
  const night = setup.slots.find((x) => x.nightly);
  const { data: units } = await supabase.from('units').select('id').eq('tenant_id', tenant.id).eq('active', true).order('sort_order');
  const day = (n) => { const d = new Date(`${setup.today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const seeds = [
    { offset: 0, unit: 0, nights: 2, name: 'Ana Cruz', confirm: true },
    { offset: 1, unit: 1, nights: 3, name: 'Jose Reyes', confirm: true },
    { offset: 2, unit: 2, nights: 1, name: 'Maria Santos', confirm: false },
    { offset: 5, unit: 0, nights: 2, name: 'Liza Tan', confirm: true },
    { offset: 5, unit: 1, nights: 2, name: 'Ben Ramos', confirm: true },
    { offset: 5, unit: 2, nights: 2, name: 'Carla Diaz', confirm: true },
    { offset: 5, unit: 3, nights: 2, name: 'Dan Uy', confirm: true },
    { offset: 9, unit: 3, nights: 1, name: 'Ella Lim', confirm: false },
  ];
  for (const s of seeds) {
    if (!units[s.unit]) continue;
    const res = await call('/bookings', { method: 'POST', body: JSON.stringify({ slotId: night.id, rooms: [{ unitId: units[s.unit].id, guests: 2 }], checkIn: day(s.offset), nights: s.nights, name: s.name, phone: '0917 555 0130', email: 'calendar.shots@example.com' }) });
    const body = await res.json();
    if (res.status !== 201) { console.log(`seed ${s.name}: ${res.status} ${body.error}`); continue; }
    groups.push(body.groupId);
    if (s.confirm) await call(`/bookings/requests/${body.groupId}`, { method: 'PATCH', body: JSON.stringify({ action: 'confirm', note: 'calendar shots' }) });
  }

  browser = await openBrowser({ scheme: 'light' });
  const page = browser.page;
  const errors = [];
  await page.send('Runtime.enable', {});
  page.on('Runtime.consoleAPICalled', (e) => { if (e.type === 'error') errors.push(e.args.map((x) => x.value ?? x.description ?? '').join(' ').slice(0, 300)); });
  page.on('Runtime.exceptionThrown', (e) => errors.push((e.exceptionDetails.exception?.description ?? e.exceptionDetails.text).slice(0, 300)));
  await page.send('Network.setCookie', { name: 'rag_admin', value: cookie.slice('rag_admin='.length), url: `${BASE}/api/t/${SLUG}/`, path: `/api/t/${SLUG}` });

  for (const width of [1280, 390]) {
    await page.viewport(width);
    for (const [name, q] of [
      ['month', `?view=month&date=${setup.today}`],
      ['week', `?view=week&date=${day(1)}`],
      ['day', `?view=day&date=${day(5)}`],
    ]) {
      await page.goto(`${BASE}/t/${SLUG}/admin/calendar${q}`);
      await page.until("!!document.querySelector('.cal-month, .cal-week, .cal-dayview')", 30000);
      await sleep(1200);
      await page.shot(join(OUT, `${name}-${width}.png`));
      console.log(`${name} ${width}: page ${await page.eval('document.documentElement.scrollWidth')}px wide`);
    }
  }
  console.log(errors.length ? `console errors:\n  ${errors.join('\n  ')}` : 'no console errors');
} finally {
  browser?.close();
  for (const g of groups) await supabase.from('bookings').delete().eq('tenant_id', tenant.id).eq('group_id', g);
  if (userId) await supabase.auth.admin.deleteUser(userId);
}
console.log(`shots in ${OUT}`);
