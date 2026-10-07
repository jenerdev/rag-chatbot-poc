// ui-components-phase2-3-walk.mjs — load states and empty states in a real
// browser, against a running dev server (plan/ui-components.md Phases 2–3).
//
// Phase 2, on every staff list of harbor and the platform's: while the
// list's read is held, a skeleton (role status); when it answers 500, an
// alert in the server's words with a Retry button; Retry with the read let
// through draws the real list. Phase 3: the same reads answered with [],
// so each list shows its empty state, with the page's own add button where
// the member may add, and that button opens the drawer; a staff member gets
// no button on the knowledge base.
//
// Three throwaway users (a harbor owner, a harbor staff member, a super
// user), deleted at the end. Nothing is changed: reads are held, failed or
// emptied INSIDE the browser; every non-GET is caught there too.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/ui-components-phase2-3-walk.mjs [base-url])

import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', 'components-2', 'walk');
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { data: harbor } = await supabase.from('tenants').select('id').eq('slug', 'harbor').single();
const stamp = Date.now();
const made = [];
async function makeUser(name) {
  const email = `ui-comp2-${name}-${stamp}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`create ${name}: ${error.message}`);
  made.push(data.user.id);
  return { id: data.user.id, email, password };
}
const cookieOf = (r, name) => (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith(`${name}=`))?.split(';')[0]?.slice(name.length + 1);
const login = async (u) => cookieOf(await fetch(`${BASE}/api/t/harbor/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: u.email, password: u.password }) }), 'rag_admin');

// Each list: its page, the read that fills it (a pathname test), what to
// wait for once it is drawn, and its empty state's title and add button.
const T = '/api/t/harbor';
const LISTS = [
  { page: '/t/harbor/admin/promos', read: (p) => p === `${T}/promos`, drawn: '.list-row', empty: 'No promos', add: 'Add a promo' },
  { page: '/t/harbor/admin/slots', read: (p) => p === `${T}/slots`, drawn: '.list-row', empty: 'No slots offered', add: 'Add a slot' },
  { page: '/t/harbor/admin/holidays', read: (p) => p === `${T}/holidays`, drawn: '.month-label, .empty-list', empty: 'No holidays or closed dates', add: 'Add a date' },
  { page: '/t/harbor/admin', read: (p) => p === `${T}/documents`, drawn: '.doc', empty: 'No documents yet', add: 'Add a document' },
  { page: '/t/harbor/admin/unanswered', read: (p) => p === `${T}/unanswered`, drawn: '.unanswered-question, .empty-list', empty: null },
  { page: '/t/harbor/admin/accommodations', read: (p) => p === `${T}/accommodations`, drawn: '.room', empty: 'No rooms yet', add: 'Add a room' },
  { page: '/t/harbor/admin/members', read: (p) => p === `${T}/members`, drawn: '.member-row', empty: null },
  { page: '/t/harbor/admin/bookings', read: (p) => p === `${T}/bookings/requests`, drawn: '.day', empty: null }, // [] hides the Requests section; its empty state is for all-decided lists
  { page: '/t/harbor/admin/dashboard', read: (p) => p === `${T}/dashboard`, drawn: '.stat-tile', empty: null },
  { page: '/platform', read: (p) => p === '/api/platform/tenants', drawn: '.member-row', empty: 'No tenants yet', add: 'New tenant' },
];

let browser;
try {
  const owner = await makeUser('owner');
  const staff = await makeUser('staff');
  const sup = await makeUser('super');
  for (const [u, role] of [[owner, 'owner'], [staff, 'staff']]) {
    const m = await supabase.from('memberships').insert({ user_id: u.id, tenant_id: harbor.id, role });
    if (m.error) throw new Error(m.error.message);
  }
  const pa = await supabase.from('platform_admins').insert({ user_id: sup.id });
  if (pa.error) throw new Error(pa.error.message);
  const ownerCookie = await login(owner);
  const staffCookie = await login(staff);
  const superCookie = cookieOf(await fetch(`${BASE}/api/platform/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: sup.email, password: sup.password }) }), 'rag_platform');
  if (!ownerCookie || !staffCookie || !superCookie) throw new Error('login failed');

  browser = await openBrowser({ scheme: 'light' });
  const { page } = browser;
  // What the browser does with a read that `rule.read` matches: 'pass',
  // 'hold' (kept until released), 'fail' (500 with words) or 'empty' ([]).
  let rule = null;
  let mode = 'pass';
  const held = [];
  const answer = (requestId, status, body) =>
    page.send('Fetch.fulfillRequest', { requestId, responseCode: status, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(body).toString('base64') });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] });
  page.on('Fetch.requestPaused', (p) => {
    const path = new URL(p.request.url).pathname;
    if (p.request.method !== 'GET') return void answer(p.requestId, 200, '{}');
    if (!rule?.read(path) || mode === 'pass') return void page.send('Fetch.continueRequest', { requestId: p.requestId });
    if (mode === 'hold') return void held.push(p.requestId);
    if (mode === 'fail') return void answer(p.requestId, 500, JSON.stringify({ error: 'Walk: the list is down.' }));
    return void answer(p.requestId, 200, '[]');
  });
  const cookies = async (admin) => {
    await page.send('Network.clearBrowserCookies');
    await page.send('Network.setCookie', { name: 'rag_admin', value: admin, url: `${BASE}/api/t/harbor/`, path: '/api/t/harbor' });
    await page.send('Network.setCookie', { name: 'rag_platform', value: superCookie, url: `${BASE}/api/platform/`, path: '/api/platform' });
  };
  await cookies(ownerCookie);
  await page.viewport(1280);

  for (const list of LISTS) {
    const name = list.page.replace('/t/harbor/admin', '') || 'knowledge base';
    rule = list;

    // Phase 2: held → skeleton; failed → alert + Retry; Retry → the list.
    mode = 'hold';
    await page.goto(`${BASE}${list.page}`);
    const skeleton = await page.until("!!document.querySelector('.skeleton-list[role=status]')", 20000);
    check(skeleton, `2. ${name}: a skeleton while the read is held`);
    mode = 'fail';
    for (const id of held.splice(0)) await answer(id, 500, JSON.stringify({ error: 'Walk: the list is down.' }));
    const alert = await page.until("!!document.querySelector('.load-error[role=alert]')", 10000);
    const words = alert ? await page.eval("document.querySelector('.load-error').textContent") : '';
    check(alert && words.includes('Walk: the list is down.') && words.includes('Retry'), `2b. ${name}: a failed read is an alert in its words, with Retry`, words.slice(0, 80));
    if (list.page === '/t/harbor/admin/bookings') await page.shot(join(OUT, 'bookings-load-error-1280.png'));
    mode = 'pass';
    await page.eval("[...document.querySelectorAll('.load-error button')].find(b => b.textContent === 'Retry').click()");
    const back = await page.until(`!document.querySelector('.load-error') && !!document.querySelector(${JSON.stringify(list.drawn)})`, 15000);
    check(back, `2c. ${name}: Retry draws the list`);

    // Phase 3: answered [] → the empty state, with the page's add button.
    if (list.empty) {
      mode = 'empty';
      await page.goto(`${BASE}${list.page}`);
      const shown = await page.until(`[...document.querySelectorAll('.empty-list strong')].some(s => s.textContent === ${JSON.stringify(list.empty)})`, 20000);
      const button = await page.eval(`(() => { const e = [...document.querySelectorAll('.empty-list')].find(e => e.querySelector('strong')?.textContent === ${JSON.stringify(list.empty)}); return e?.querySelector('.empty-list-action button')?.textContent.trim() ?? null; })()`);
      check(shown && (list.add ? button?.endsWith(list.add) : button === null), `3. ${name}: empty, "${list.empty}"${list.add ? ` with "${list.add}"` : ', no button'}`, button ?? 'no button');
      if (list.add && list.page !== '/platform') {
        await page.eval(`[...document.querySelectorAll('.empty-list-action button')][0].click()`);
        check(await page.until("!!document.querySelector('dialog.drawer[open]')", 3000), `3b. ${name}: the empty state's button opens the drawer`);
        await page.key('Escape', 'Escape', 27);
      } else if (list.page === '/platform') {
        await page.eval(`[...document.querySelectorAll('.empty-list-action button')][0].click()`);
        check(await page.until("!!document.querySelector('#tenant-slug')", 3000), '3b. platform: the empty state\'s button opens the new-tenant form');
      }
      if (list.page === '/t/harbor/admin/promos') await page.shot(join(OUT, 'promos-empty-1280.png'));
      mode = 'pass';
    }
  }

  // 3c. Staff may not add a document: the empty state has no button.
  await cookies(staffCookie);
  rule = LISTS.find((l) => l.page === '/t/harbor/admin');
  mode = 'empty';
  await page.goto(`${BASE}/t/harbor/admin`);
  await page.until("[...document.querySelectorAll('.empty-list strong')].some(s => s.textContent === 'No documents yet')", 20000);
  check((await page.eval("document.querySelector('.empty-list .empty-list-action')")) === null, '3c. knowledge base as staff: empty, and no add button');

  // 3d. Phone width: the empty state fits.
  await cookies(ownerCookie);
  rule = LISTS[0];
  await page.viewport(375);
  await page.goto(`${BASE}/t/harbor/admin/promos`);
  await page.until("!!document.querySelector('.empty-list')", 20000);
  const wide = await page.eval('document.documentElement.scrollWidth');
  check(wide <= 375, '3d. promos empty on a phone: nothing wider than the screen', `${wide}px`);
  await page.shot(join(OUT, 'promos-empty-375.png'));
} finally {
  browser?.close();
  for (const id of made) {
    await supabase.from('platform_admins').delete().eq('user_id', id);
    await supabase.auth.admin.deleteUser(id);
  }
}

console.log(`\n${failures === 0 ? 'all passed' : `${failures} FAILED`}`);
process.exit(failures ? 1 : 0);
