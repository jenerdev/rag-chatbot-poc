// features-walk.mjs — feature flags (D-127) end to end, against pnpm dev.
//
// On a THROWAWAY tenant (`feat-walk-…`, deleted at the end with everything
// it owns): bookings on, one priced room, one document, suggested questions, and an
// OWNER who logs in. A throwaway SUPER USER drives the platform form.
//   1. the platform's Features tab lists every feature, each On;
//   2. a click on Calendar's switch says "Switched off." and writes the row;
//   3. the calendar page and its route answer 404, and the owner's sidebar
//      has no Calendar link (Bookings still there);
//   4. booking_page, manage_booking, dashboard and suggested_questions off:
//      /book and /manage are 404, their routes are 404, the chat has no
//      "Book your stay" and no suggestions, /admin opens on Bookings;
//   5. everything back on: every page is 200 again, the chat has both;
//   6. axe over the Features tab, 1280 and 375, light and dark (4 states).
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/features-walk.mjs)

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = 'http://localhost:3000';
const HERE = dirname(fileURLToPath(import.meta.url));
const AXE = readFileSync(join(HERE, 'ui-refresh', 'axe', 'axe.min.js'), 'utf8');
const SHOTS = join(HERE, 'features');
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const users = [];
let tenantId = null;
let browser;
let audited = 0;
const found = [];
const slug = `feat-walk-${randomBytes(3).toString('hex')}`;
const NAME = 'Feature Walk Resort';
try {
  // The tenant.
  const { data: t, error } = await supabase
    .from('tenants')
    .insert({ slug, business_name: NAME, assistant_name: 'Walker', suggested_questions: ['What rooms are there?', 'How do I book?'] })
    .select('id')
    .single();
  if (error) throw new Error(`tenant: ${error.message}`);
  tenantId = t.id;
  const app = await supabase.from('tenant_applications').insert({ tenant_id: tenantId, application_key: 'bookings', config: { timezone: 'Asia/Manila' } });
  if (app.error) throw new Error(`application: ${app.error.message}`);
  const { data: unit } = await supabase.from('units').insert({ tenant_id: tenantId, name: 'Garden Room', capacity: 4, sort_order: 1, active: true }).select('id').single();
  const { data: slot } = await supabase.from('slots').insert({ tenant_id: tenantId, name: 'Overnight', start_time: '14:00', duration: '22 hours', nightly: true }).select('id').single();
  const rate = await supabase.from('unit_rates').insert({ tenant_id: tenantId, unit_id: unit.id, slot_id: slot.id, weekday_price: 300000, weekend_price: 350000 });
  if (rate.error) throw new Error(`rate: ${rate.error.message}`);
  // One document: the chat shows its suggestions only once the knowledge
  // base is not empty, so without it "no suggestions" would pass for the
  // wrong reason (trap 12). No chunks are needed for the welcome to count it.
  const doc = await supabase.from('documents').insert({ tenant_id: tenantId, title: 'About', content: 'A garden room for four.' });
  if (doc.error) throw new Error(`document: ${doc.error.message}`);

  // The people: a super user and the tenant's owner.
  const person = async (tag) => {
    const email = `${tag}-${Date.now()}-${randomBytes(2).toString('hex')}@example.com`;
    const password = randomBytes(18).toString('base64url');
    const { data, error: e } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (e) throw new Error(e.message);
    users.push(data.user.id);
    return { id: data.user.id, email, password };
  };
  const sup = await person('feat-super');
  const owner = await person('feat-owner');
  await supabase.from('platform_admins').insert({ user_id: sup.id });
  const m = await supabase.from('memberships').insert({ user_id: owner.id, tenant_id: tenantId, role: 'owner' });
  if (m.error) throw new Error(`membership: ${m.error.message}`);
  const cookieOf = (r, name) => (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith(`${name}=`))?.split(';')[0]?.slice(name.length + 1);
  const platformCookie = cookieOf(
    await fetch(`${BASE}/api/platform/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: sup.email, password: sup.password }) }),
    'rag_platform',
  );
  const adminCookie = cookieOf(
    await fetch(`${BASE}/api/t/${slug}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: owner.email, password: owner.password }) }),
    'rag_admin',
  );
  if (!platformCookie || !adminCookie) throw new Error(`login: platform ${!!platformCookie} admin ${!!adminCookie}`);

  const status = async (path, init = {}) => (await fetch(`${BASE}${path}`, { redirect: 'manual', ...init })).status;
  const asOwner = (path, init = {}) => status(path, { ...init, headers: { ...(init.headers ?? {}), cookie: `rag_admin=${adminCookie}` } });
  const flip = async (key, enabled) => {
    const r = await fetch(`${BASE}/api/platform/tenants/${tenantId}/features/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: `rag_platform=${platformCookie}` },
      body: JSON.stringify({ enabled }),
    });
    if (!r.ok) throw new Error(`flip ${key}: ${r.status} ${await r.text()}`);
  };
  const html = async (path) => (await fetch(`${BASE}${path}`)).text();
  const post = (path, body) => status(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  browser = await openBrowser();
  let { page } = browser;
  await page.viewport(1280);
  await page.send('Network.setCookie', { name: 'rag_platform', value: platformCookie, url: `${BASE}/api/platform/`, path: '/api/platform' });
  await page.send('Network.setCookie', { name: 'rag_admin', value: adminCookie, url: `${BASE}/api/t/${slug}/`, path: `/api/t/${slug}` });
  const openFeatures = async () => {
    await page.goto(`${BASE}/platform`);
    await page.until(`!!document.querySelector('[aria-label="Edit ${NAME}"]')`, 45000);
    await page.eval(`document.querySelector('[aria-label="Edit ${NAME}"]').click(); true`);
    await page.until("!!document.querySelector('.tenant-edit') && [...document.querySelectorAll('[role=tab]')].some(t => t.textContent.trim() === 'Features')", 30000);
    await page.eval("[...document.querySelectorAll('[role=tab]')].find(t => t.textContent.trim() === 'Features').click(); true");
    await page.until("document.querySelectorAll('button[role=switch]').length > 0", 15000);
  };

  // 1
  await openFeatures();
  const listed = await page.eval("[...document.querySelectorAll('button[role=switch]')].filter(b => b.offsetParent).map(b => b.getAttribute('aria-checked'))");
  check(listed.length === 8 && listed.every((v) => v === 'true'), '1. the Features tab lists the 8 features, each On', listed.join(','));
  await page.shot(join(SHOTS, 'features-tab-1280.png'));

  // 2
  await page.eval(`document.querySelector('button[role=switch][aria-labelledby="feat-name-calendar"]').click(); true`);
  const toast = await page.until("[...document.querySelectorAll('.toast-message')].some(t => t.textContent === 'Switched off.')", 15000);
  await page.until(`document.querySelector('button[role=switch][aria-labelledby="feat-name-calendar"]')?.getAttribute('aria-checked') === 'false'`, 15000);
  const { data: row } = await supabase.from('tenant_features').select('enabled').eq('tenant_id', tenantId).eq('feature', 'calendar').single();
  check(toast && row?.enabled === false, '2. a click on Calendar\'s switch says "Switched off." and writes the row (enabled false)', `toast ${toast} · row ${JSON.stringify(row)}`);

  // 3
  {
    const pageStatus = await status(`/t/${slug}/admin/calendar`);
    const routeStatus = await asOwner(`/api/t/${slug}/calendar?view=month&date=2026-11-01`);
    await page.goto(`${BASE}/t/${slug}/admin/bookings`);
    await page.until("document.querySelectorAll('.sidebar-link').length > 0", 45000);
    const links = await page.eval("[...document.querySelectorAll('.sidebar-link')].map(a => a.textContent.trim())");
    check(pageStatus === 404 && routeStatus === 404 && !links.includes('Calendar') && links.includes('Bookings'), '3. calendar off: its page and route are 404, and the sidebar has no Calendar (Bookings stays)', `page ${pageStatus} · route ${routeStatus} · links ${links.join(', ')}`);
  }

  // 4
  {
    for (const key of ['booking_page', 'manage_booking', 'dashboard', 'suggested_questions']) await flip(key, false);
    const book = await status(`/t/${slug}/book`);
    const manage = await status(`/t/${slug}/manage`);
    const quote = await post(`/api/t/${slug}/book/quote`, {});
    const lookup = await post(`/api/t/${slug}/manage`, { reference: 'FEA-AAAAAA', contact: 'x@example.com' });
    const adminDoor = await fetch(`${BASE}/t/${slug}/admin`, { redirect: 'manual' });
    const dashboard = await status(`/t/${slug}/admin/dashboard`);
    await page.goto(`${BASE}/t/${slug}`);
    await page.until("!!document.querySelector('.composer')", 45000);
    await sleep(800);
    const chat = await page.eval("({ book: document.body.innerText.includes('Book your stay'), suggestions: !!document.querySelector('.suggestions') })");
    check(
      book === 404 && manage === 404 && quote === 404 && lookup === 404 && /\/admin\/bookings$/.test(adminDoor.headers.get('location') ?? '') && dashboard === 404 && !chat.book && !chat.suggestions,
      '4. booking page, manage booking, dashboard and suggestions off: /book, /manage and their routes 404, /admin opens on Bookings, the chat has neither',
      `book ${book} · manage ${manage} · quote ${quote} · lookup ${lookup} · /admin → ${adminDoor.status} ${adminDoor.headers.get('location')} · dashboard ${dashboard} · chat ${JSON.stringify(chat)}`,
    );
  }

  // 5
  {
    for (const key of ['calendar', 'booking_page', 'manage_booking', 'dashboard', 'suggested_questions']) await flip(key, true);
    const pages = await Promise.all([`/t/${slug}/book`, `/t/${slug}/manage`, `/t/${slug}/admin/calendar`, `/t/${slug}/admin/dashboard`].map((p) => status(p)));
    await page.goto(`${BASE}/t/${slug}`);
    await page.until("!!document.querySelector('.composer')", 45000);
    await sleep(800);
    const chat = await page.eval("({ book: document.body.innerText.includes('Book your stay'), suggestions: !!document.querySelector('.suggestions') })");
    check(pages.every((s) => s === 200) && chat.book && chat.suggestions, '5. everything back on: book, manage, calendar and dashboard are 200; the chat has "Book your stay" and its suggestions', `${pages.join(' ')} · chat ${JSON.stringify(chat)}`);
  }
  browser.close();
  browser = null;

  // 6
  for (const scheme of ['light', 'dark']) {
    browser = await openBrowser({ scheme });
    page = browser.page;
    await page.send('Network.setCookie', { name: 'rag_platform', value: platformCookie, url: `${BASE}/api/platform/`, path: '/api/platform' });
    for (const width of [1280, 375]) {
      await page.viewport(width);
      await openFeatures();
      await sleep(600);
      await page.eval(AXE);
      const violations = JSON.parse(
        await page.eval(`axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }).then(r => JSON.stringify(r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(' ') }))))`),
      );
      audited++;
      for (const v of violations) found.push(`features tab @${width} [${scheme}] ${v.id} (${v.impact}, ${v.nodes}): ${v.sample}`);
      await page.shot(join(SHOTS, `features-tab-${scheme}-${width}.png`));
    }
    browser.close();
    browser = null;
  }
} catch (error) {
  check(false, 'setup', error.message);
} finally {
  browser?.close();
  if (tenantId) await supabase.from('tenants').delete().eq('id', tenantId);
  for (const id of users) {
    await supabase.from('platform_admins').delete().eq('user_id', id);
    await supabase.auth.admin.deleteUser(id);
  }
}
console.log(`\naxe: ${audited} states, ${found.length} violation(s)`);
for (const f of found) console.log(`  ${f}`);
console.log(failures ? `${failures} FAILED` : 'walk: all passed');
process.exit(failures === 0 && found.length === 0 && audited === 4 ? 0 : 1);
