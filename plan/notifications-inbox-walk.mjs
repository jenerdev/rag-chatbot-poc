// notifications-inbox-walk.mjs — the Notifications item (plan/notifications.md
// § 8): the two bugs the user found on 2026-10-14, walked in a browser.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/notifications-inbox-walk.mjs)
//
// Needs pnpm dev. A throwaway STAFF member of villa opens Bookings in a
// headless browser and never touches the Sound toggle: one real click on the
// page is all (the sound is on by default now, and any click wakes it). The
// tab is then made HIDDEN, as when staff are in another tab. A guest sends a
// web request from "another browser". Within 35 s the hidden tab must chime,
// toast, and put the count on Notifications (not on Bookings). Then the
// member opens Notifications, clicks the row (it is marked read and the link
// goes to the stay), and finally "Mark all read" clears the number.
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
const madeEmail = `inbox-walk-${Date.now()}@example.com`;
try {
  const email = `inbox-staff-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data: u, error: ue } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (ue) throw new Error(ue.message);
  userId = u.user.id;
  const m = await supabase.from('memberships').insert({ user_id: userId, tenant_id: tenant.id, role: 'staff' });
  if (m.error) throw new Error(m.error.message);
  const login = await fetch(`${BASE}/api/t/${SLUG}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (login.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0];
  if (!cookie) throw new Error(`login failed: ${login.status}`);

  // 1. The routes: 401 without a session; with one, the unread count and rows.
  const anon = await fetch(`${BASE}/api/t/${SLUG}/admin/attention`);
  const before = await (await fetch(`${BASE}/api/t/${SLUG}/admin/attention`, { headers: { cookie } })).json();
  const list = await fetch(`${BASE}/api/t/${SLUG}/admin/notifications`, { headers: { cookie } });
  const listed = await list.json();
  check(
    anon.status === 401 && Number.isInteger(before.unread) && Array.isArray(before.latest) && list.status === 200 && listed.unread === before.unread
      && listed.items.every((i) => i.kind !== 'proof'),
    '1. attention and notifications: 401 without a session; the unread count and rows with one; a staff member sees no proof',
    `unread ${before.unread} · latest ${before.latest.length} · list ${listed.items.length} [${[...new Set(listed.items.map((i) => i.kind))].join(',')}]`,
  );

  // A free night for the request, found with the open quote.
  const { data: slot } = await supabase.from('slots').select('id').eq('tenant_id', tenant.id).eq('active', true).order('id').limit(1).single();
  const { data: unit } = await supabase.from('units').select('id').eq('tenant_id', tenant.id).eq('active', true).order('id').limit(1).single();
  let checkIn = null;
  for (let days = 25; days < 90 && !checkIn; days += 3) {
    const date = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const q = await fetch(`${BASE}/api/t/${SLUG}/book/quote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slotId: slot.id, rooms: [{ unitId: unit.id, guests: 2 }], checkIn: date, nights: 1 }) });
    if (q.ok && (await q.json()).available) checkIn = date;
  }
  if (!checkIn) throw new Error('no free night in the next 90 days');

  // 2. The staff tab: Bookings. The toggle is never touched.
  browser = await openBrowser({ scheme: 'light' });
  const page = browser.page;
  await page.send('Page.enable', {});
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "window.__oscillators = 0; const make = AudioContext.prototype.createOscillator; AudioContext.prototype.createOscillator = function () { window.__oscillators++; return make.call(this); };",
  });
  await page.send('Network.setCookie', { name: 'rag_admin', value: cookie.slice('rag_admin='.length), url: `${BASE}/api/t/${SLUG}/`, path: `/api/t/${SLUG}` });
  await page.viewport(1280);
  const click = async (selector) => {
    const box = await page.eval(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  };
  await page.goto(`${BASE}/t/${SLUG}/admin/bookings`);
  await page.until("!!document.querySelector('.sound-toggle')", 30000);
  await sleep(1500);
  // One REAL click on the page title, not the toggle (§ 2b.1: a gesture).
  await click('.page-title');
  await sleep(300);
  const woke = await page.eval("({ pressed: document.querySelector('.sound-toggle').getAttribute('aria-pressed'), text: document.querySelector('.sound-toggle').textContent, osc: window.__oscillators })");
  check(woke.pressed === 'true' && woke.text === 'Sound on' && woke.osc === 0, '2. the sound is on by default, and a click anywhere wakes it (no chime for the click)', JSON.stringify(woke));

  // The link's own label is its first plain <span>; the badge and the screen-reader words are apart.
  const badges = "Object.fromEntries([...document.querySelectorAll('.sidebar-link')].filter(l => l.querySelector('.nav-badge')).map(l => [l.querySelector('span:not(.nav-badge):not(.visually-hidden)').textContent, Number(l.querySelector('.nav-badge').textContent)]))";
  const startBadges = await page.eval(badges);
  const startTitle = await page.eval('document.title');
  const order = await page.eval("[...document.querySelectorAll('.sidebar-group')][0].textContent");
  check(
    (before.unread === 0 ? Object.keys(startBadges).length === 0 : JSON.stringify(startBadges) === JSON.stringify({ Notifications: before.unread }))
      && (before.unread === 0 ? !/^\(\d+\)/.test(startTitle) : startTitle.startsWith(`(${before.unread}) `)) && /Dashboard.*Notifications/.test(order),
    '3. on load: the ONE badge is on Notifications (Overview, after Dashboard), and the title says it',
    `${JSON.stringify(startBadges)} · "${startTitle}"`,
  );

  // 3. The tab goes to the background. Before the fix the poll stopped here.
  await page.eval("Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); true");

  const sent = Date.now();
  const request = await fetch(`${BASE}/api/t/${SLUG}/book/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slotId: slot.id, rooms: [{ unitId: unit.id, guests: 2 }], checkIn, nights: 1, name: 'Inbox Walk', phone: '09180009912', email: madeEmail }),
  });
  const made = await request.json();
  check(request.status === 201, '4. a guest sends a web request', `${request.status} ${made.reference ?? made.error}`);

  const notifBadge = "Number([...document.querySelectorAll('.sidebar-link')].find(l => l.getAttribute('href')?.endsWith('/admin/notifications'))?.querySelector('.nav-badge')?.textContent ?? 0)";
  const heard = await page.until(`${notifBadge} === ${before.unread + 1}`, 40000);
  const after = await page.eval(`({ badges: ${badges}, title: document.title, toast: [...document.querySelectorAll('.toast-message')].map(t => t.textContent), osc: window.__oscillators, hidden: document.visibilityState })`);
  check(heard && after.badges.Notifications === before.unread + 1 && after.hidden === 'hidden', '5. a HIDDEN tab still hears it: Notifications +1 within 40 s', `${before.unread} → ${after.badges.Notifications} after ${Math.round((Date.now() - sent) / 1000)} s, ${after.hidden}`);
  check(!('Bookings' in after.badges) && !('Payments' in after.badges) && after.title.startsWith(`(${before.unread + 1}) `), '6. no badge on Bookings or Payments; the title counts the unread', `${JSON.stringify(after.badges)} · "${after.title}"`);
  check(after.toast.some((t) => t.startsWith('New booking request · ') && t.includes(made.reference)), '7. a toast names it', JSON.stringify(after.toast));
  check(after.osc === 2, '8. the chime played (two tones) without the toggle ever being clicked', `oscillators ${after.osc}`);

  // 4. Notifications: the row is there, unread; clicking it opens the stay and marks it read.
  await page.goto(`${BASE}/t/${SLUG}/admin/notifications`);
  await page.until("document.querySelectorAll('.notification').length > 0", 30000);
  const row = await page.eval(`(() => { const li = [...document.querySelectorAll('.notification')].find(l => l.textContent.includes(${JSON.stringify(made.reference)})); return li ? { unread: li.classList.contains('unread'), href: li.querySelector('a').getAttribute('href'), title: li.querySelector('.notification-title').textContent } : null; })()`);
  check(row?.unread === true && row.href === `/t/${SLUG}/admin/bookings/${made.reference}`, '9. Notifications lists it, unread, linking to the stay', JSON.stringify(row));

  await page.eval(`(() => { [...document.querySelectorAll('.notification')].find(l => l.textContent.includes(${JSON.stringify(made.reference)})).setAttribute('data-walk', 'target'); return true; })()`);
  await click('.notification[data-walk="target"] .notification-text');
  const went = await page.until(`location.pathname === '/t/${SLUG}/admin/bookings/${made.reference}'`, 30000);
  await sleep(1500);
  const stored = (await (await fetch(`${BASE}/api/t/${SLUG}/admin/notifications`, { headers: { cookie } })).json());
  const mine = stored.items.find((i) => i.reference === made.reference);
  await page.until(`${notifBadge} === ${before.unread}`, 15000);
  const onStay = await page.eval(`({ badge: ${notifBadge}, title: document.title })`);
  check(went && mine?.read === true && stored.unread === before.unread && onStay.badge === before.unread, '10. clicking it opens the stay and marks it read: the number falls by one (the request is still pending)', `at stay ${went} · read ${mine?.read} · unread ${stored.unread} · badge ${onStay.badge} · "${onStay.title}"`);

  // 5. Mark all read: the number is gone.
  await page.goto(`${BASE}/t/${SLUG}/admin/notifications`);
  await page.until("document.querySelectorAll('.notification').length > 0", 30000);
  await sleep(500);
  const canMarkAll = await page.eval("!document.querySelector('.page-actions button').disabled");
  if (canMarkAll) await click('.page-actions button');
  await page.until(`${notifBadge} === 0`, 15000);
  const cleared = await page.eval(`({ badge: ${notifBadge}, title: document.title, unread: document.querySelectorAll('.notification.unread').length, disabled: document.querySelector('.page-actions button').disabled })`);
  const server = (await (await fetch(`${BASE}/api/t/${SLUG}/admin/notifications`, { headers: { cookie } })).json()).unread;
  check(cleared.badge === 0 && cleared.unread === 0 && cleared.disabled && !/^\(\d+\)/.test(cleared.title) && server === 0, '11. Mark all read: no badge, no "(n)", no unread row, and the server agrees', `${JSON.stringify(cleared)} · server ${server}`);

  // 6. Reading is per member: villa's other members still have theirs unread.
  const { count: othersRead } = await supabase.from('notification_reads').select('outbox_id', { count: 'exact', head: true }).eq('tenant_id', tenant.id).neq('user_id', userId).eq('outbox_id', mine?.id ?? 0);
  check(othersRead === 0, "12. this member's reading marked nothing for anyone else", `other members' marks on it: ${othersRead}`);
} finally {
  browser?.close();
  const { data: rows } = await supabase.from('bookings').select('group_id').eq('tenant_id', tenant.id).eq('guest_email', madeEmail);
  const groups = [...new Set((rows ?? []).map((r) => r.group_id))];
  if (groups.length) {
    await supabase.from('bookings').delete().eq('tenant_id', tenant.id).in('group_id', groups);
    await supabase.from('stays').delete().eq('tenant_id', tenant.id).in('group_id', groups);
  }
  console.log(`cleaned: ${groups.length} stay(s)`);
  if (userId) await supabase.auth.admin.deleteUser(userId);
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
