// Room types Phase 4 (D-133) in a browser, against pnpm dev: S-5 adds a
// second room to a type, the New booking form asks how many of that type,
// the calendar says "1/2", and S-15's Rooms card moves a stay between the
// two rooms through the Move drawer. On harbor, with a throwaway
// "Garden Room 2" and one stay, both removed at the end.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/room-types-walk.mjs)

import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const SLUG = 'harbor';
const TYPE = 'Garden Room';
const EXTRA = 'Garden Room 2';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'room-types', 'walk');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', SLUG).single();
const { data: unit } = await supabase.from('units').select('id').eq('tenant_id', tenant.id).eq('name', TYPE).single();
const users = [];
const groups = [];
let browser;

try {
  const email = `room-types-walk-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data: made, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  users.push(made.user.id);
  await supabase.from('memberships').insert({ user_id: made.user.id, tenant_id: tenant.id, role: 'admin' });
  const r = await fetch(`${BASE}/api/t/${SLUG}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0];
  if (!cookie) throw new Error('login failed');
  const call = (path, init = {}) => fetch(`${BASE}/api/t/${SLUG}${path}`, { ...init, headers: { 'Content-Type': 'application/json', cookie } });

  browser = await openBrowser({ scheme: 'light' });
  const page = browser.page;
  await page.viewport(1280);
  await page.send('Network.setCookie', { name: 'rag_admin', value: cookie.slice('rag_admin='.length), url: `${BASE}/api/t/${SLUG}/`, path: `/api/t/${SLUG}` });

  // 1. S-5: open the type, add a second room through the form.
  await page.goto(`${BASE}/t/${SLUG}/admin/accommodations`);
  await page.until(`[...document.querySelectorAll('.room-toggle')].some(b => b.textContent.includes(${JSON.stringify(TYPE)}))`, 30000);
  await page.eval(`[...document.querySelectorAll('.room-toggle')].find(b => b.querySelector('.room-name')?.textContent === ${JSON.stringify(TYPE)}).click()`);
  await page.until(`!!document.getElementById('new-room-${unit.id}')`, 10000);
  await page.type(`#new-room-${unit.id}`, EXTRA);
  await sleep(200);
  await page.eval(`document.getElementById('new-room-${unit.id}').closest('form').requestSubmit()`);
  const listed = await page.until(`[...document.querySelectorAll('.unit-room-name')].some(s => s.textContent === ${JSON.stringify(EXTRA)})`, 10000).then(() => true, () => false);
  check(listed, '1. S-5 adds "Garden Room 2" to Garden Room');
  const meta = await page.eval(`[...document.querySelectorAll('.room-toggle')].find(b => b.querySelector('.room-name')?.textContent === ${JSON.stringify(TYPE)}).querySelector('.room-meta').textContent`);
  check(/2 rooms/.test(meta), '1b. the row says 2 rooms', meta);
  const line = await page.eval(`document.getElementById('new-room-${unit.id}').closest('.room-section').querySelector('.room-section-head p').textContent`);
  check(/2 bookings per slot/.test(line), '1c. the section says it takes 2 bookings', line);
  await page.shot(join(OUT, 's5-rooms-1280.png'));

  // 2. New booking: Garden Room offers a Rooms count of up to 2.
  await page.goto(`${BASE}/t/${SLUG}/admin/bookings`);
  await page.until(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'New booking')`, 30000);
  await page.eval(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'New booking').click()`);
  const picks = await page.until(`[...document.querySelectorAll('.room-pick')].some(p => p.querySelector('.room-pick-name')?.textContent === ${JSON.stringify(TYPE)})`, 15000).then(() => true, () => false);
  if (picks) {
    await page.eval(`[...document.querySelectorAll('.room-pick')].find(p => p.querySelector('.room-pick-name')?.textContent === ${JSON.stringify(TYPE)}).querySelector('input[type=checkbox]').click()`);
    const max = await page.until(`document.querySelector('input[aria-label="How many ${TYPE} rooms, of 2"]')?.max === '2'`, 5000).then(() => true, () => false);
    check(max, '2. the staff form asks how many Garden Rooms, of 2');
  } else check(false, '2. the staff form lists Garden Room', 'no room picks appeared');
  await page.shot(join(OUT, 'staff-form-1280.png'));

  // 3. Seed one confirmed Garden Room stay; the calendar says 1/2.
  const setup = await (await call('/bookings/setup')).json();
  const night = setup.slots.find((x) => x.nightly);
  const day = (n) => { const d = new Date(`${setup.today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const checkIn = day(230);
  const res = await call('/bookings', { method: 'POST', body: JSON.stringify({ slotId: night.id, rooms: [{ unitId: unit.id, guests: 2 }], checkIn, nights: 2, name: 'Room Types Walk', phone: '0917 555 0133', email: 'room.types.walk@example.com' }) });
  const body = await res.json();
  if (res.status !== 201) throw new Error(`book: ${res.status} ${body.error}`);
  groups.push(body.groupId);
  const ref = body.bookings[0].reference;
  await call(`/bookings/requests/${body.groupId}`, { method: 'PATCH', body: JSON.stringify({ action: 'confirm', note: 'walk: room types' }) });

  await page.goto(`${BASE}/t/${SLUG}/admin/calendar?view=week&date=${checkIn}`);
  const cellSel = `[...document.querySelectorAll('button.wk-cell')].find(b => b.getAttribute('aria-label').startsWith(${JSON.stringify(`${TYPE}, ${night.name}`)}) && b.getAttribute('aria-label').includes('1 of 2 rooms booked'))`;
  const counted = await page.until(`!!${cellSel}`, 20000).then(() => true, () => false);
  check(counted, '3. the week calendar says Garden Room is 1 of 2 booked');
  if (counted) check((await page.eval(`${cellSel}.textContent`)).includes('1/2'), '3b. the cell shows "1/2"');
  await page.shot(join(OUT, 'calendar-week-1280.png'));

  // 4. S-15: the Rooms card, Move to Garden Room 2.
  await page.goto(`${BASE}/t/${SLUG}/admin/bookings/${ref}`);
  const card = await page.until(`!!document.querySelector('.stay-card-rooms button[aria-label="Move from ${TYPE}"]')`, 20000).then(() => true, () => false);
  check(card, '4. S-15 lists the room with a Move button');
  await page.shot(join(OUT, 's15-rooms-1280.png'));
  if (card) {
    await page.click(`.stay-card-rooms button[aria-label="Move from ${TYPE}"]`);
    const option = `[...document.querySelectorAll('.move-room')].find(l => l.textContent.includes(${JSON.stringify(EXTRA)}))`;
    const offered = await page.until(`!!${option} && !${option}.querySelector('input').disabled`, 10000).then(() => true, () => false);
    check(offered, '4b. the Move drawer offers Garden Room 2, free');
    await page.shot(join(OUT, 's15-move-drawer-1280.png'));
    if (offered) {
      await page.eval(`${option}.querySelector('input').click()`);
      await page.type('#move-note', 'walk: guest asked for the other garden room');
      await sleep(200);
      await page.eval(`document.getElementById('move-note').closest('form').requestSubmit()`);
      const moved = await page.until(`[...document.querySelectorAll('.stay-card-rooms strong')].some(s => s.textContent === ${JSON.stringify(EXTRA)})`, 10000).then(() => true, () => false);
      check(moved, '4c. after Move the Rooms card says Garden Room 2');
      const { data: rows } = await supabase.from('bookings').select('room_id, unit_rooms(name)').eq('tenant_id', tenant.id).eq('group_id', body.groupId);
      check(rows.length > 0 && rows.every((x) => x.unit_rooms?.name === EXTRA), '4d. every night of the stay is stored on Garden Room 2', rows.map((x) => x.unit_rooms?.name).join(', '));
      await page.shot(join(OUT, 's15-moved-1280.png'));
    }
  }

  // 5. A phone width look at S-5 and S-15.
  await page.viewport(375);
  await page.goto(`${BASE}/t/${SLUG}/admin/bookings/${ref}`);
  await page.until(`!!document.querySelector('.stay-card-rooms')`, 20000).catch(() => null);
  const overflow = await page.eval('document.documentElement.scrollWidth > window.innerWidth');
  check(!overflow, '5. S-15 at 375 px has no sideways scroll');
  await page.shot(join(OUT, 's15-375.png'));
} finally {
  browser?.close();
  for (const g of groups) await supabase.from('bookings').delete().eq('tenant_id', tenant.id).eq('group_id', g);
  const { count } = await supabase.from('unit_rooms').delete({ count: 'exact' }).eq('tenant_id', tenant.id).eq('unit_id', unit.id).eq('name', EXTRA);
  console.log(`cleanup: removed ${count ?? 0} extra room`);
  for (const u of users) await supabase.auth.admin.deleteUser(u);
}
console.log(`\n${failures === 0 ? 'all passed' : `${failures} FAILED`}`);
process.exit(failures ? 1 : 0);
