// notifications-sound-walk.mjs — "click to allow" kept coming back
// (plan/notifications.md § 8, 2026-10-14). Two cases, in a browser:
//
//   A. Allowed once, then another staff page: the frame mounts again, and
//      the toggle must say "Sound on" at once, with no new click, and the
//      chime must still play.
//   B. A browser that already allows this site sound (Chrome's autoplay
//      flag stands in for a site's Sound: Allow): "Sound on" after a reload
//      with no click at all.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/notifications-sound-walk.mjs)
//
// Needs pnpm dev. One throwaway staff member of villa, deleted at the end.

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
const toggle = "({ text: document.querySelector('.sound-toggle')?.textContent, osc: window.__oscillators, path: location.pathname })";

const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', SLUG).single();
let userId;
let browser;
try {
  const email = `sound-walk-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data: u, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  userId = u.user.id;
  await supabase.from('memberships').insert({ user_id: userId, tenant_id: tenant.id, role: 'staff' });
  const login = await fetch(`${BASE}/api/t/${SLUG}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (login.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0];
  if (!cookie) throw new Error(`login failed: ${login.status}`);

  const open = async (args = []) => {
    const b = await openBrowser({ scheme: 'light', args });
    await b.page.send('Page.enable', {});
    await b.page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "window.__oscillators = 0; const make = AudioContext.prototype.createOscillator; AudioContext.prototype.createOscillator = function () { window.__oscillators++; return make.call(this); };",
    });
    await b.page.send('Network.setCookie', { name: 'rag_admin', value: cookie.slice('rag_admin='.length), url: `${BASE}/api/t/${SLUG}/`, path: `/api/t/${SLUG}` });
    await b.page.viewport(1280);
    return b;
  };
  const realClick = async (page, selector) => {
    const box = await page.eval(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  };

  // A. The ordinary browser: one click, then a page change.
  browser = await open();
  let page = browser.page;
  await page.goto(`${BASE}/t/${SLUG}/admin/bookings`);
  await page.until("!!document.querySelector('.sound-toggle')", 30000);
  await sleep(1000);
  const before = await page.eval(toggle);
  check(before.text === 'Sound on · click to allow', 'A1. a fresh tab asks for one click (the browser requires it)', before.text);
  await realClick(page, '.page-title');
  await page.until("document.querySelector('.sound-toggle').textContent === 'Sound on'", 5000);
  check((await page.eval(toggle)).text === 'Sound on', 'A2. one click anywhere allows it', (await page.eval(toggle)).text);

  // To another staff page by its sidebar link: client-side, so the tab (and its audio) stays.
  await page.eval("[...document.querySelectorAll('.sidebar-link')].find(l => l.getAttribute('href')?.endsWith('/admin/calendar')).setAttribute('data-walk', 'go'); true");
  await realClick(page, '.sidebar-link[data-walk="go"]');
  await page.until(`location.pathname === '/t/${SLUG}/admin/calendar' && !!document.querySelector('.sound-toggle')`, 30000);
  const moved = await page.eval(toggle);
  check(moved.text === 'Sound on', 'A3. another staff page: still "Sound on", no new click (the bug)', `${moved.path}: ${moved.text}`);
  // Off, a render, then on: two clicks in one tick would both see "on".
  await page.eval("document.querySelector('.sound-toggle').click(); true");
  await sleep(300);
  await page.eval("document.querySelector('.sound-toggle').click(); true");
  await sleep(500);
  const chimed = await page.eval(toggle);
  check(chimed.osc === 2 && chimed.text === 'Sound on', 'A4. the chime still plays there (off and on again chimes two tones)', `oscillators ${chimed.osc}`);
  browser.close();

  // B. A browser that already allows the site sound: no click after a load.
  browser = await open(['--autoplay-policy=no-user-gesture-required']);
  page = browser.page;
  await page.goto(`${BASE}/t/${SLUG}/admin/bookings`);
  await page.until("!!document.querySelector('.sound-toggle')", 30000);
  const allowed = await page.until("document.querySelector('.sound-toggle').textContent === 'Sound on'", 5000);
  check(allowed, 'B. where the browser allows the site sound, "Sound on" with no click at all', (await page.eval(toggle)).text);
} finally {
  browser?.close();
  if (userId) await supabase.auth.admin.deleteUser(userId);
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
