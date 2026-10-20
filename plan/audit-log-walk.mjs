// audit-log-walk.mjs — S-18 Activity and the platform's log over HTTP and
// in a browser (plan/audit-log.md Phase 4, D-138), against pnpm dev.
//
// On villa, as a throwaway OWNER (activity:read), a throwaway STAFF member
// (none) and a throwaway SUPER USER: the owner logs in, sets and removes a
// holiday, promotes and demotes the staff member, books a stay and writes
// a staff note; then the log is read by the route (the owner's rows, with
// the owner's email, the note's body nowhere), refused to staff (403),
// read by the platform for villa and for itself; then the page in a
// browser at 1280 and 390 (the rows, the area filter, one person, the
// search), the platform's own card, and the logout row. Everything it
// made is removed by the ids it made (trap 26), the audit rows included.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/audit-log-walk.mjs)
//
// Needs pnpm dev.

import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const SLUG = 'villa';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'audit-log', 'walk');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const realClick = async (page, sel) => {
  const box = await page.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
};

const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', SLUG).single();
const users = [];
const groups = [];
let superId = null;
let browser;
const NOTE = `walk note ${Date.now()}`;
const LABEL = `Walk Day ${randomBytes(2).toString('hex')}`;

try {
  const user = async (prefix) => {
    const email = `${prefix}-${Date.now()}-${randomBytes(2).toString('hex')}@example.com`;
    const password = randomBytes(18).toString('base64url');
    const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(error.message);
    users.push(data.user.id);
    return { id: data.user.id, email, password };
  };
  const member = async (prefix, role) => {
    const u = await user(prefix);
    const m = await supabase.from('memberships').insert({ user_id: u.id, tenant_id: tenant.id, role });
    if (m.error) throw new Error(m.error.message);
    return u;
  };
  const login = async (u) => {
    const r = await fetch(`${BASE}/api/t/${SLUG}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: u.email, password: u.password }) });
    const cookie = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0];
    if (!cookie) throw new Error(`login failed (${u.email}): ${r.status}`);
    return cookie;
  };
  const owner = await member('audit-owner', 'owner');
  const staff = await member('audit-staff', 'staff');
  const su = await user('audit-super');
  const pa = await supabase.from('platform_admins').insert({ user_id: su.id });
  if (pa.error) throw new Error(pa.error.message);
  superId = su.id;

  // 1. The owner's actions, over the routes, as a browser would send them.
  const ownerCookie = await login(owner);
  const call = (cookie, path, init = {}) => fetch(`${BASE}/api/t/${SLUG}${path}`, { ...init, headers: { 'Content-Type': 'application/json', cookie } });
  const setup = await (await call(ownerCookie, '/bookings/setup')).json();
  const night = setup.slots.find((x) => x.nightly);
  const day = (n) => { const d = new Date(`${setup.today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const { data: units } = await supabase.from('units').select('id').eq('tenant_id', tenant.id).eq('active', true).order('sort_order');
  const holiday = await call(ownerCookie, '/holidays', { method: 'PUT', body: JSON.stringify({ day: day(300), kind: 'holiday', label: LABEL, surcharge: 50000 }) });
  const promote = await call(ownerCookie, '/members', { method: 'PATCH', body: JSON.stringify({ userId: staff.id, role: 'admin' }) });
  const demote = await call(ownerCookie, '/members', { method: 'PATCH', body: JSON.stringify({ userId: staff.id, role: 'staff' }) });
  const unholiday = await call(ownerCookie, `/holidays/${day(300)}`, { method: 'DELETE' });
  const booked = await call(ownerCookie, '/bookings', { method: 'POST', body: JSON.stringify({ slotId: night.id, rooms: [{ unitId: units[0].id, guests: 2 }], checkIn: day(302), nights: 1, name: 'Audit Walk Guest', phone: '0917 555 0177', email: 'audit.walk@example.com' }) });
  const bookedBody = await booked.json();
  if (booked.status !== 201) throw new Error(`book: ${booked.status} ${bookedBody.error}`);
  groups.push(bookedBody.groupId);
  const ref = bookedBody.bookings[0].reference;
  const noted = await call(ownerCookie, `/bookings/stay/${encodeURIComponent(ref)}/notes`, { method: 'POST', body: JSON.stringify({ body: NOTE }) });
  check(holiday.ok && promote.ok && demote.ok && unholiday.ok && noted.ok, '1. the owner set and removed a holiday, promoted and demoted a member, booked a stay and wrote a note', `${holiday.status} ${promote.status} ${demote.status} ${unholiday.status} ${booked.status} ${noted.status}`);

  // 2. The route, as the owner: every action is a row, in the owner's name, with the note's body nowhere.
  const page1 = await (await call(ownerCookie, '/admin/activity?days=7')).json();
  const mine = (page1.rows ?? []).filter((r) => r.actorUser === owner.id);
  const kinds = mine.map((r) => `${r.area}:${r.action}`);
  const has = (k) => kinds.includes(k);
  const text = JSON.stringify(page1.rows);
  check(
    has('session:login') && has('holidays:insert') && has('holidays:delete') && kinds.filter((k) => k === 'members:update').length === 2 && has('stay_notes:insert') && has('bookings:created')
      && mine.every((r) => r.actorEmail === owner.email) && !text.includes(NOTE) && !text.includes('Audit Walk Guest') && !text.includes('0917 555 0177'),
    "2. the owner's log has the login, the holiday set and removed, two role changes, the note and the booking, each in the owner's name; the note's body, the guest's name and phone appear nowhere",
    `${kinds.join(', ')} · email ${mine.every((r) => r.actorEmail === owner.email)}`,
  );
  const holidayRow = mine.find((r) => r.area === 'holidays' && r.action === 'insert');
  const roleRow = mine.find((r) => r.area === 'members' && r.action === 'update');
  check(
    holidayRow?.label === LABEL && holidayRow.after?.kind === 'holiday' && holidayRow.after?.surcharge === 50000 && roleRow?.changed?.join() === 'role' && (roleRow.before?.role === 'staff' || roleRow.before?.role === 'admin'),
    "3. a row holds what changed: the holiday's label, kind and surcharge; the role change's before and after",
    `${holidayRow?.label} ${JSON.stringify(holidayRow?.after)} · role ${JSON.stringify(roleRow?.before)} → ${JSON.stringify(roleRow?.after)}`,
  );

  // 4. Staff: the route is a 403 that names the permission.
  const staffCookie = await login(staff);
  const staffTry = await call(staffCookie, '/admin/activity');
  const staffBody = await staffTry.json();
  check(staffTry.status === 403 && /activity:read/.test(staffBody.error ?? ''), '4. a staff member gets 403 from the route, with the permission named', `${staffTry.status} ${staffBody.error?.slice(0, 80)}`);

  // 5. The platform: villa's log as a super user (the same rows), and its own log (the super user's login).
  const pr = await fetch(`${BASE}/api/platform/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: su.email, password: su.password }) });
  const platformCookie = (pr.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_platform='))?.split(';')[0];
  if (!platformCookie) throw new Error(`platform login failed: ${pr.status}`);
  const pCall = (path) => fetch(`${BASE}/api/platform${path}`, { headers: { cookie: platformCookie } });
  const pVilla = await (await pCall(`/tenants/${tenant.id}/activity?days=7`)).json();
  const pOwn = await (await pCall('/activity?days=7')).json();
  // D-076 holds: the platform token has no policy on booking_events, so its view of villa is the audit rows alone.
  const pMine = (pVilla.rows ?? []).filter((r) => r.actorUser === owner.id);
  const mineAudit = mine.filter((r) => r.source === 'audit');
  const superLogin = (pOwn.rows ?? []).find((r) => r.actorUser === su.id && r.area === 'session' && r.action === 'login');
  check(
    pMine.length === mineAudit.length && pMine.every((r) => r.source === 'audit' && r.actorEmail === owner.email) && !(pVilla.rows ?? []).some((r) => r.source === 'bookings') && superLogin?.actorKind === 'super' && (pOwn.rows ?? []).every((r) => r.area === 'session' || r.area === 'platform' || r.area === 'tenant'),
    "5. the platform reads villa's audit rows (the owner's, with the email) and none of its stay log (D-076), and its own log (the super user's login, kind 'super')",
    `villa ${pMine.length}/${mineAudit.length} · own ${pOwn.rows?.length} rows, login ${superLogin ? 'found' : 'MISSING'}`,
  );

  // 6–9. The page, as the owner.
  browser = await openBrowser({ scheme: 'light' });
  const page = browser.page;
  await page.viewport(1280);
  await page.send('Network.setCookie', { name: 'rag_admin', value: ownerCookie.slice('rag_admin='.length), url: `${BASE}/api/t/${SLUG}/`, path: `/api/t/${SLUG}` });
  await page.goto(`${BASE}/t/${SLUG}/admin/activity?days=7`);
  await page.until("[...document.querySelectorAll('.activity-what')].some(e => e.textContent.trim())", 30000);
  await sleep(300);
  const rows = await page.eval("[...document.querySelectorAll('.activity-row')].map(li => li.querySelector('.activity-what').textContent)");
  const sidebar = await page.eval("[...document.querySelectorAll('a')].some(a => a.getAttribute('href') === '/t/villa/admin/activity' && /Activity/.test(a.textContent))");
  check(rows.length >= 7 && rows.some((t) => /set .* as a holiday/.test(t)) && rows.some((t) => /made a member admin \(was staff\)/.test(t)) && rows.some((t) => /booked booking VIL-/.test(t)) && sidebar,
    '6. the page lists the actions in words, and the sidebar has Activity', `${rows.length} rows · ${rows.slice(0, 3).join(' | ')}`);
  await page.shot(join(OUT, 'activity-1280.png'));

  // 7. The area filter: Members only.
  await page.eval("(() => { const s = document.querySelector('.activity-area select'); s.value = 'members'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
  await sleep(800);
  await page.until("[...document.querySelectorAll('.activity-what')].some(e => e.textContent.trim())", 15000);
  const membersOnly = await page.eval("[...document.querySelectorAll('.activity-row .activity-what')].map(e => e.textContent)");
  const url7 = await page.eval('location.search');
  check(membersOnly.length >= 2 && membersOnly.every((t) => /member/.test(t)) && /area=members/.test(url7), '7. the area filter keeps members rows alone, and the URL carries it', `${membersOnly.length} rows · ${url7}`);

  // 8. One person: a click on the owner's name filters to them; the search finds the holiday by its label.
  await page.eval("(() => { const s = document.querySelector('.activity-area select'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
  await sleep(800);
  await page.until("!!document.querySelector('.activity-who button')", 15000);
  // The owner's own name (the staff member's sign-in is the newest row, so the first button is theirs).
  await page.until(`[...document.querySelectorAll('.activity-who button')].some(b => b.textContent === ${JSON.stringify(owner.email)})`, 15000);
  await page.eval(`[...document.querySelectorAll('.activity-who button')].find(b => b.textContent === ${JSON.stringify(owner.email)}).click()`);
  const pressed = await page.until("!!document.querySelector('.activity-who button[aria-pressed=\"true\"]')", 10000);
  await sleep(800);
  const onePerson = await page.eval("({ url: location.search, chip: !!document.querySelector('.conversations-toolbar button[type=button]') })");
  onePerson.pressed = pressed;
  await page.type('.list-search input', LABEL);
  await sleep(900);
  const searched = await page.eval("[...document.querySelectorAll('.activity-row .activity-what')].map(e => e.textContent)");
  check(onePerson.pressed && /actor=/.test(onePerson.url) && searched.length === 2 && searched.every((t) => t.includes(LABEL)), '8. a click on a name filters to that person (in the URL); the search finds the holiday by its label, set and removed', `${JSON.stringify(onePerson)} · ${searched.join(' | ')}`);
  await page.shot(join(OUT, 'activity-filtered-1280.png'));

  // 9. A phone: the rows stack, no sideways scroll.
  await page.viewport(390);
  await page.goto(`${BASE}/t/${SLUG}/admin/activity?days=7`);
  await page.until("[...document.querySelectorAll('.activity-what')].some(e => e.textContent.trim())", 30000);
  await sleep(400);
  const width = await page.eval('document.documentElement.scrollWidth');
  check(width <= 390, '9. the page fits a phone', `scrollWidth ${width}`);
  await page.shot(join(OUT, 'activity-390.png'));

  // 10. Staff in the browser: no Activity in the sidebar, one sentence on the page.
  await page.viewport(1280);
  await page.send('Network.setCookie', { name: 'rag_admin', value: staffCookie.slice('rag_admin='.length), url: `${BASE}/api/t/${SLUG}/`, path: `/api/t/${SLUG}` });
  await page.goto(`${BASE}/t/${SLUG}/admin/activity`);
  await page.until("!!document.querySelector('main .card p')", 30000);
  await sleep(300);
  const staffView = await page.eval("({ sentence: document.querySelector('main .card p')?.textContent, link: [...document.querySelectorAll('a')].some(a => a.getAttribute('href') === '/t/villa/admin/activity') })");
  check(/read by an owner/.test(staffView.sentence ?? '') && !staffView.link, '10. staff see one sentence and no Activity link', JSON.stringify(staffView));

  // 11. The platform's own card.
  await page.send('Network.setCookie', { name: 'rag_platform', value: platformCookie.slice('rag_platform='.length), url: `${BASE}/api/platform/`, path: '/api/platform' });
  await page.goto(`${BASE}/platform`);
  await page.until("[...document.querySelectorAll('.platform-activity .activity-what')].some(e => e.textContent.trim())", 30000);
  await sleep(300);
  const platformRows = await page.eval("[...document.querySelectorAll('.platform-activity .activity-row')].map(li => li.querySelector('.activity-who').textContent + ' ' + li.querySelector('.activity-what').textContent)");
  check(platformRows.some((t) => /^Super user signed in/.test(t)), "11. the platform page's card lists the super user's sign-in as 'Super user'", platformRows.slice(0, 2).join(' | '));
  await page.shot(join(OUT, 'platform-1280.png'));

  // 12. The logout is a row.
  await call(ownerCookie, '/admin/session', { method: 'DELETE' });
  const after = await (await fetch(`${BASE}/api/platform/tenants/${tenant.id}/activity?days=7`, { headers: { cookie: platformCookie } })).json();
  const logoutRow = (after.rows ?? []).find((r) => r.actorUser === owner.id && r.action === 'logout');
  check(!!logoutRow, "12. the owner's logout is a row", logoutRow ? `${logoutRow.area}:${logoutRow.action} at ${logoutRow.at}` : 'MISSING');
} catch (error) {
  check(false, 'walk: setup', error.stack ?? error.message);
} finally {
  browser?.close();
  for (const g of groups) {
    await supabase.from('stay_notes').delete().eq('tenant_id', tenant.id).eq('group_id', g);
    const { count } = await supabase.from('bookings').delete({ count: 'exact' }).eq('tenant_id', tenant.id).eq('group_id', g);
    console.log(`cleaned group ${g}: ${count ?? 0} bookings`);
  }
  if (superId) await supabase.from('platform_admins').delete().eq('user_id', superId);
  for (const id of users) await supabase.auth.admin.deleteUser(id);
  // The walk's own audit rows: the actors' (owner, staff, super), the memberships made and removed about them, and the platform_admins row.
  if (users.length) {
    const a = await supabase.from('audit_log').delete({ count: 'exact' }).in('actor_user', users);
    const b = await supabase.from('audit_log').delete({ count: 'exact' }).in('subject', users);
    console.log(`cleaned audit rows: ${(a.count ?? 0) + (b.count ?? 0)}`);
  }
}
console.log(failures === 0 ? 'audit log walk: all pass' : `audit log walk: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
