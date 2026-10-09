// ui-refresh-phase10-walk.mjs — the two Phase 10 checks the axe audit cannot
// make (plan/ui-refresh.md Phase 10): 200 % zoom and reduced motion.
//
// 200 % zoom = a 1280 px window at deviceScaleFactor 2, i.e. a 640 CSS px
// layout. WCAG 1.4.10 (reflow): no page may scroll sideways, and the page's
// heading must still be on screen. Every public page, every staff page as an
// owner, on the three tenants, light scheme.
// Reduced motion: with `prefers-reduced-motion: reduce` emulated, an open
// drawer and an open dialog have no running animation, and no element on the
// chat has a transition longer than 0 s.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/ui-refresh-phase10-walk.mjs [base-url])
//
// Every non-GET request is caught in the browser, so nothing is changed. One
// throwaway owner of all three tenants, deleted at the end.

import { randomBytes } from 'node:crypto';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const SLUGS = ['villa', 'harbor', 'northwind'];
const STAFF = ['/admin/dashboard', '/admin/documents', '/admin/unanswered', '/admin/bookings', '/admin/accommodations', '/admin/holidays', '/admin/slots', '/admin/promos', '/admin/members'];

const { data: tenants } = await supabase.from('tenants').select('id, slug').in('slug', SLUGS);
const cookieOf = (r, name) => (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith(`${name}=`))?.split(';')[0]?.slice(name.length + 1);

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

let userId;
let browser;
try {
  const email = `ui-p10-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  userId = data.user.id;
  for (const t of tenants) await supabase.from('memberships').insert({ user_id: userId, tenant_id: t.id, role: 'owner' });
  const cookies = {};
  for (const slug of SLUGS) cookies[slug] = cookieOf(await fetch(`${BASE}/api/t/${slug}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }), 'rag_admin');

  browser = await openBrowser({ scheme: 'light' });
  const { page } = browser;
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] });
  page.on('Fetch.requestPaused', (p) =>
    p.request.method === 'GET'
      ? void page.send('Fetch.continueRequest', { requestId: p.requestId })
      : void page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from('{}').toString('base64') }),
  );

  // --- 200 % zoom -----------------------------------------------------------
  await page.send('Emulation.setDeviceMetricsOverride', { width: 640, height: 450, deviceScaleFactor: 2, mobile: false });
  const reflow = async (label) => {
    await new Promise((r) => setTimeout(r, 400));
    const r = await page.eval(`(() => {
      const el = document.scrollingElement;
      const h = document.querySelector('main h1, main h2, h1, .auth-card h2');
      const box = h?.getBoundingClientRect();
      return { over: el.scrollWidth - el.clientWidth, heading: !!box && box.left >= 0 && box.right <= innerWidth + 1 };
    })()`);
    check(`zoom 200 %: ${label}`, r.over <= 1 && r.heading, r.over > 1 ? `scrolls sideways by ${r.over}px` : r.heading ? '' : 'heading off screen');
  };
  for (const slug of SLUGS) {
    await page.send('Network.clearBrowserCookies');
    await page.goto(`${BASE}/t/${slug}`);
    await page.until("!!document.querySelector('.composer')", 30000);
    await reflow(`${slug} chat`);
    await page.goto(`${BASE}/t/${slug}/book`);
    await reflow(`${slug} book`);
    await page.goto(`${BASE}/t/${slug}/admin`);
    await page.until("!!document.querySelector('.auth-card')", 30000);
    await reflow(`${slug} login`);
    await page.send('Network.setCookie', { name: 'rag_admin', value: cookies[slug], url: `${BASE}/api/t/${slug}/`, path: `/api/t/${slug}` });
    for (const path of STAFF) {
      await page.goto(`${BASE}/t/${slug}${path}`);
      await page.until("!!document.querySelector('.staff-sidebar') || !!document.querySelector('main h1, main h2')", 30000);
      await reflow(`${slug} ${path}`);
    }
  }

  // --- reduced motion ---------------------------------------------------------
  await page.viewport(1280);
  const still = `(() => {
    const moving = document.getAnimations().filter((a) => a.playState === 'running' && (a.effect?.getComputedTiming().duration ?? 0) > 0);
    const slow = [...document.querySelectorAll('*')].filter((e) => getComputedStyle(e).transitionDuration.split(',').some((d) => parseFloat(d) > 0));
    return { moving: moving.length, slow: slow.length };
  })()`;
  const motionless = async (label) => {
    await new Promise((r) => setTimeout(r, 300));
    const r = await page.eval(still);
    check(`reduced motion: ${label}`, r.moving === 0 && r.slow === 0, `${r.moving} running animation(s), ${r.slow} element(s) with a transition`);
  };
  // The positive twin (CLAUDE.md trap 12): WITHOUT the preference, the chat
  // has transitions, so the zero below is the preference's doing.
  await page.send('Network.clearBrowserCookies');
  await page.goto(`${BASE}/t/villa`);
  await page.until("!!document.querySelector('.composer')", 30000);
  const control = await page.eval(still);
  check('control: villa chat moves without the preference', control.slow > 0, `${control.slow} element(s) with a transition`);
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
  await page.send('Network.setCookie', { name: 'rag_admin', value: cookies.harbor, url: `${BASE}/api/t/harbor/`, path: '/api/t/harbor' });
  await page.goto(`${BASE}/t/harbor/admin/bookings`);
  await page.until("!!document.querySelector('.page-actions button')", 30000);
  await page.click('.page-actions button');
  await page.until("!!document.querySelector('dialog.drawer[open]')", 5000);
  await motionless('harbor bookings, drawer open');
  await page.key('Escape', 'Escape', 27);
  await page.eval("[...document.querySelectorAll('.booking-actions button')].find(b => b.textContent === 'Decline' || b.textContent === 'Cancel')?.click()");
  if (await page.until("!!document.querySelector('dialog.dialog[open]')", 5000)) {
    await motionless('harbor bookings, dialog open');
    await page.key('Escape', 'Escape', 27);
  } else check('reduced motion: harbor bookings, dialog open', false, 'no Decline or Cancel button to open it');
  await page.send('Network.clearBrowserCookies');
  await page.goto(`${BASE}/t/villa`);
  await page.until("!!document.querySelector('.composer')", 30000);
  await motionless('villa chat');
} finally {
  browser?.close();
  if (userId) await supabase.auth.admin.deleteUser(userId);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
