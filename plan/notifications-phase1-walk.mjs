// notifications-phase1-walk.mjs — the in-app layer (plan/notifications.md
// Phase 1): a staff tab hears a guest's web request within one poll.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/notifications-phase1-walk.mjs)
//
// Needs pnpm dev. A throwaway STAFF member of villa opens Bookings in a
// headless browser, turns the sound on (the click is the gesture a browser
// wants, § 2b.1), and reads the badge and the title. Then a guest, from
// "another browser" (plain fetch, no cookie), sends a web request on the
// booking page's route. Within 35 s the tab must show the badge one higher,
// "(n)" in the title, the "New booking request" toast, and the chime (its
// oscillators are counted by a wrapper installed before the page loads).
// Everything made is deleted at the end.

import { randomBytes } from 'node:crypto';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = 'http://localhost:3000';
const SLUG = 'villa';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', SLUG).single();
let userId;
let browser;
const madeEmail = `notify-walk-${Date.now()}@example.com`;
try {
  // A staff member, logged in.
  const email = `notify-staff-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data: u, error: ue } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (ue) throw new Error(ue.message);
  userId = u.user.id;
  const m = await supabase.from('memberships').insert({ user_id: userId, tenant_id: tenant.id, role: 'staff' });
  if (m.error) throw new Error(m.error.message);
  const login = await fetch(`${BASE}/api/t/${SLUG}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (login.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0];
  if (!cookie) throw new Error(`login failed: ${login.status}`);

  // 1. The route: a visitor gets 401; a member gets three numbers.
  const anon = await fetch(`${BASE}/api/t/${SLUG}/admin/attention`);
  const mine = await fetch(`${BASE}/api/t/${SLUG}/admin/attention`, { headers: { cookie } });
  const before = await mine.json();
  check(anon.status === 401 && mine.status === 200 && ['requests', 'proofs', 'changes'].every((k) => Number.isInteger(before[k])) && Object.keys(before).length === 3, '1. attention: 401 without a session, three counts with one', JSON.stringify(before));

  // A free night for the request, found with the open quote.
  const { data: slot } = await supabase.from('slots').select('id').eq('tenant_id', tenant.id).eq('active', true).order('id').limit(1).single();
  const { data: unit } = await supabase.from('units').select('id').eq('tenant_id', tenant.id).eq('active', true).order('id').limit(1).single();
  let checkIn = null;
  for (let days = 25; days < 70 && !checkIn; days += 3) {
    const date = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const q = await fetch(`${BASE}/api/t/${SLUG}/book/quote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slotId: slot.id, rooms: [{ unitId: unit.id, guests: 2 }], checkIn: date, nights: 1 }) });
    if (q.ok && (await q.json()).available) checkIn = date;
  }
  if (!checkIn) throw new Error('no free night in the next 70 days');

  // 2. The staff tab: Bookings, sound on.
  browser = await openBrowser({ scheme: 'light' });
  const page = browser.page;
  await page.send('Page.enable', {});
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "window.__oscillators = 0; const make = AudioContext.prototype.createOscillator; AudioContext.prototype.createOscillator = function () { window.__oscillators++; return make.call(this); };",
  });
  await page.send('Network.setCookie', { name: 'rag_admin', value: cookie.slice('rag_admin='.length), url: `${BASE}/api/t/${SLUG}/`, path: `/api/t/${SLUG}` });
  await page.viewport(1280);
  await page.goto(`${BASE}/t/${SLUG}/admin/bookings`);
  await page.until("!!document.querySelector('.sound-toggle')", 30000);
  await sleep(1500);
  // A REAL mouse click: element.click() is not a user gesture, and Chrome
  // keeps audio suspended without one (§ 2b.1), exactly as for a person.
  const box = await page.eval("(() => { const r = document.querySelector('.sound-toggle').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(300);
  const toggled = await page.eval("({ pressed: document.querySelector('.sound-toggle').getAttribute('aria-pressed'), text: document.querySelector('.sound-toggle').textContent, osc: window.__oscillators })");
  check(toggled.pressed === 'true' && toggled.text === 'Sound on' && toggled.osc === 2, '2. the Sound toggle turns on and plays the chime once (two tones)', JSON.stringify(toggled));
  const badgeOf = "(() => { const a = [...document.querySelectorAll('.sidebar-link')].find(l => l.getAttribute('href')?.endsWith('/admin/bookings')); return Number(a?.querySelector('.nav-badge')?.textContent ?? 0); })()";
  const startBadge = await page.eval(badgeOf);
  const startTitle = await page.eval('document.title');
  check(startBadge === before.requests + before.changes && (startBadge === 0 ? !/^\(\d+\)/.test(startTitle) : startTitle.startsWith(`(${startBadge + before.proofs}) `)), '3. on load: the badge is the count, and the title says it (no toast for what was already there)', `badge ${startBadge} · "${startTitle}"`);

  // 3. A guest's web request, from elsewhere.
  const sent = Date.now();
  const request = await fetch(`${BASE}/api/t/${SLUG}/book/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slotId: slot.id, rooms: [{ unitId: unit.id, guests: 2 }], checkIn, nights: 1, name: 'Notify Walk', phone: '09180009911', email: madeEmail }),
  });
  const made = await request.json();
  check(request.status === 201, '4. a guest sends a web request', `${request.status} ${made.reference ?? made.error}`);

  // 4. Within one poll: badge +1, title, toast, chime.
  const heard = await page.until(`${badgeOf} === ${startBadge + 1}`, 35000);
  const after = await page.eval(`({ badge: ${badgeOf}, title: document.title, toast: [...document.querySelectorAll('.toast-message')].map(t => t.textContent), osc: window.__oscillators })`);
  check(heard && after.badge === startBadge + 1, '5. the badge rises by one within 35 s', `${startBadge} → ${after.badge} after ${Math.round((Date.now() - sent) / 1000)} s`);
  check(after.title.startsWith(`(${startBadge + 1 + before.proofs}) `), '6. the title counts it', after.title);
  check(after.toast.includes('New booking request'), '7. a toast says so', JSON.stringify(after.toast));
  check(after.osc === 4, '8. the chime played (two more tones)', `oscillators ${after.osc}`);
} finally {
  browser?.close();
  if (madeEmail) {
    const { data: rows } = await supabase.from('bookings').select('group_id').eq('tenant_id', tenant.id).eq('guest_email', madeEmail);
    const groups = [...new Set((rows ?? []).map((r) => r.group_id))];
    if (groups.length) {
      await supabase.from('bookings').delete().eq('tenant_id', tenant.id).in('group_id', groups);
      await supabase.from('stays').delete().eq('tenant_id', tenant.id).in('group_id', groups);
    }
    console.log(`cleaned: ${groups.length} stay(s)`);
  }
  if (userId) await supabase.auth.admin.deleteUser(userId);
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
