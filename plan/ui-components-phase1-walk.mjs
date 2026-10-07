// ui-components-phase1-walk.mjs — the toast in a real browser, against a
// running dev server (plan/ui-components.md Phase 1): a success toast in the
// viewport after a row action at the bottom of a page, gone by itself; an
// error toast that stays, reachable by Tab, closed by its button; a refusal
// inside an open drawer said IN the drawer, not as a toast; a confirmed
// request; one region per page, the platform's two panels included; the
// phone position; axe on the toasts, light and dark.
//
// Two throwaway users (an owner of harbor; a super user), deleted at the end.
// Nothing is changed: EVERY non-GET request is caught inside the browser and
// answered there, with the status and body the step asks for; reads go to
// the real server.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/ui-components-phase1-walk.mjs [base-url])

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'ui-refresh', 'components-1', 'walk');
const AXE = readFileSync(join(HERE, 'ui-refresh', 'axe', 'axe.min.js'), 'utf8');
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setInput = (selector, value) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`;
// The toast with this kind whose text starts with `start`: its role and its box.
const toastInfo = (kind, start) =>
  `(() => { const t = [...document.querySelectorAll('.toast.${kind}')].find(t => t.textContent.startsWith(${JSON.stringify(start)})); if (!t) return null; const r = t.getBoundingClientRect(); return { role: t.getAttribute('role'), text: t.textContent, top: r.top, bottom: r.bottom, left: r.left, right: r.right, vh: innerHeight, vw: innerWidth }; })()`;
const inView = (t) => !!t && t.top >= 0 && t.bottom <= t.vh && t.left >= 0 && t.right <= t.vw;

const { data: harbor } = await supabase.from('tenants').select('id').eq('slug', 'harbor').single();
const stamp = Date.now();
const made = [];
async function makeUser(name) {
  const email = `ui-comp1-${name}-${stamp}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`create ${name}: ${error.message}`);
  made.push(data.user.id);
  return { id: data.user.id, email, password };
}
const cookieOf = (r, name) => (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith(`${name}=`))?.split(';')[0]?.slice(name.length + 1);

let browser;
try {
  const owner = await makeUser('owner');
  const sup = await makeUser('super');
  const m = await supabase.from('memberships').insert({ user_id: owner.id, tenant_id: harbor.id, role: 'owner' });
  if (m.error) throw new Error(m.error.message);
  const pa = await supabase.from('platform_admins').insert({ user_id: sup.id });
  if (pa.error) throw new Error(pa.error.message);
  const ownerCookie = cookieOf(await fetch(`${BASE}/api/t/harbor/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: owner.email, password: owner.password }) }), 'rag_admin');
  const superCookie = cookieOf(await fetch(`${BASE}/api/platform/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: sup.email, password: sup.password }) }), 'rag_platform');
  if (!ownerCookie || !superCookie) throw new Error('login failed');
  // The tenant form's save answers with the tenant; the real one, read now.
  const harborDetail = await (await fetch(`${BASE}/api/platform/tenants/${harbor.id}`, { headers: { cookie: `rag_platform=${superCookie}` } })).text();

  browser = await openBrowser({ scheme: 'light' });
  const { page } = browser;
  const writes = [];
  // The answer the NEXT caught write gets; then back to 200 {}.
  let next = null;
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] });
  page.on('Fetch.requestPaused', (p) => {
    if (p.request.method === 'GET') return void page.send('Fetch.continueRequest', { requestId: p.requestId });
    writes.push({ method: p.request.method, path: new URL(p.request.url).pathname });
    const answer = next ?? { status: 200, body: '{}' };
    next = null;
    void page.send('Fetch.fulfillRequest', {
      requestId: p.requestId,
      responseCode: answer.status,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(answer.body).toString('base64'),
    });
  });
  await page.send('Network.setCookie', { name: 'rag_admin', value: ownerCookie, url: `${BASE}/api/t/harbor/`, path: '/api/t/harbor' });
  await page.send('Network.setCookie', { name: 'rag_platform', value: superCookie, url: `${BASE}/api/platform/`, path: '/api/platform' });
  const confirmDialog = async () => {
    await page.until("!!document.querySelector('dialog.dialog[open]')", 5000);
    await page.eval("document.querySelector('dialog.dialog button[type=submit]').click()");
    await page.until("!document.querySelector('dialog.dialog[open]')", 3000);
  };
  const deleteUnusedPromo = () =>
    page.eval("(() => { window.scrollTo(0, document.body.scrollHeight); const b = document.querySelector('.list-row-actions button[aria-label^=\"Delete\"]'); b?.click(); return !!b; })()");

  await page.viewport(1280);
  await page.goto(`${BASE}/t/harbor/admin/promos`);
  await page.until("!!document.querySelector('.list-row')", 30000);

  // 1. One region, open (a popover in the top layer), empty.
  const region = await page.eval("(() => { const r = document.querySelectorAll('.toasts'); return { n: r.length, open: r[0]?.matches(':popover-open'), label: r[0]?.getAttribute('aria-label'), kids: r[0]?.children.length }; })()");
  check(region.n === 1 && region.open && region.kids === 0, '1. one toast region on the page, shown as a popover, empty', JSON.stringify(region));
  check((await page.eval("document.querySelectorAll('.staff-content > .notice').length")) === 0, '1b. no page-top notice banner any more');

  // 2. A success after a row action at the bottom: in the viewport, a status.
  check(await deleteUnusedPromo(), '2. an unused promo has a Delete button');
  await confirmDialog();
  await page.until("!!document.querySelector('.toast.ok')", 5000);
  const ok = await page.eval(toastInfo('ok', 'Deleted "'));
  check(inView(ok) && ok.role === 'status' && writes.at(-1)?.method === 'DELETE', '2b. "Deleted …" shows in the viewport as a status', ok ? `${ok.text} @ ${Math.round(ok.top)}–${Math.round(ok.bottom)} of ${ok.vh}` : 'none');
  await page.shot(join(OUT, 'promo-deleted-1280.png'));
  await sleep(5600);
  check((await page.eval(toastInfo('ok', 'Deleted "'))) === null, '2c. the success goes by itself after 5 s');

  // 3. An error outside a drawer: a toast that stays, an alert, reachable by Tab.
  next = { status: 409, body: JSON.stringify({ error: 'Walk: the server refused.' }) };
  await deleteUnusedPromo();
  await confirmDialog();
  await page.until("!!document.querySelector('.toast.error')", 5000);
  const err = await page.eval(toastInfo('error', 'Walk: the server refused.'));
  check(inView(err) && err.role === 'alert', '3. a refusal is an error toast, an alert, in the viewport', err?.text ?? 'none');
  await sleep(6000);
  check((await page.eval(toastInfo('error', 'Walk: the server refused.'))) !== null, '3b. the error is still there after 6 s');
  let reached = false;
  for (let i = 0; i < 80 && !reached; i++) {
    await page.tab();
    reached = await page.eval("document.activeElement?.closest('.toast.error') !== null && document.activeElement?.getAttribute('aria-label') === 'Dismiss'");
  }
  check(reached, "3c. Tab reaches the error toast's Dismiss button");
  // With `text`, or Chrome does not press the focused button (the helper's key() sends none).
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: type === 'keyDown' ? String.fromCharCode(13) : undefined });
  await sleep(200);
  check((await page.eval(toastInfo('error', 'Walk: the server refused.'))) === null, '3d. Enter on Dismiss closes it');

  // 4. A refusal inside the open drawer: said in the drawer, not as a toast.
  await page.eval('window.scrollTo(0, 0)');
  await page.click('.page-actions button');
  await page.until("!!document.querySelector('dialog.drawer[open]')", 3000);
  await page.eval(setInput('#promo-name', 'Walk One'));
  await page.eval(setInput('#promo-value', '10'));
  await page.eval(setInput('#promo-from', '2026-11-01'));
  await page.eval(setInput('#promo-to', '2026-11-30'));
  next = { status: 409, body: JSON.stringify({ error: 'Walk: a promo by that name exists.' }) };
  await page.eval("document.querySelector('dialog.drawer[open] button[type=submit]').click()");
  await page.until("!!document.querySelector('dialog.drawer[open] .drawer-notice')", 5000);
  const inDrawer = await page.eval("document.querySelector('dialog.drawer[open] .drawer-notice')?.textContent ?? ''");
  const asToast = await page.eval(toastInfo('error', 'Walk: a promo by that name exists.'));
  check(inDrawer.includes('Walk: a promo by that name exists.') && asToast === null, '4. a refusal in the open drawer is said in the drawer, not as a toast', inDrawer);
  await page.shot(join(OUT, 'drawer-refusal-1280.png'));

  // 4b. Saved: the drawer closes and the success is a toast.
  await page.eval("document.querySelector('dialog.drawer[open] button[type=submit]').click()");
  await page.until("!document.querySelector('dialog.drawer[open]')", 5000);
  await page.until("!!document.querySelector('.toast.ok')", 5000);
  const added = await page.eval(toastInfo('ok', 'Added "Walk One"'));
  check(inView(added) && writes.filter((w) => w.method === 'POST').length === 2, '4b. saved: the drawer closes, "Added …" is a toast', added?.text ?? 'none');

  // 5. Bookings: decide a request, the decision's words as a toast. Decline:
  // harbor's pending request clashes with a confirmed one (D-099), so its
  // Confirm is disabled, as it should be; both go through the same decide().
  await page.goto(`${BASE}/t/harbor/admin/bookings`);
  await page.until("!!document.querySelector('.page-actions button')", 30000);
  const confirmable = await page.eval("(() => { const b = [...document.querySelectorAll('.booking.request .booking-actions button:not(:disabled)')].find(b => b.textContent.trim() === 'Decline'); b?.click(); return !!b; })()");
  if (confirmable) {
    await confirmDialog();
    await page.until("!!document.querySelector('.toast.ok')", 5000);
    const confirmed = await page.eval(toastInfo('ok', 'Declined '));
    check(inView(confirmed) && writes.at(-1)?.method === 'PATCH', '5. declining a request says so in a toast', confirmed?.text ?? 'none');
  } else check(false, '5. a pending request with Decline exists on harbor');
  check((await page.eval("document.querySelectorAll('.toasts').length")) === 1, '5b. one region on Bookings too');

  // 6. The phone: bottom-centre, inside the screen.
  await page.viewport(375);
  await page.goto(`${BASE}/t/harbor/admin/promos`);
  await page.until("!!document.querySelector('.list-row')", 30000);
  await deleteUnusedPromo();
  await confirmDialog();
  await page.until("!!document.querySelector('.toast.ok')", 5000);
  const phone = await page.eval(toastInfo('ok', 'Deleted "'));
  const centred = phone && Math.abs(phone.left - (phone.vw - phone.right)) <= 2;
  check(inView(phone) && centred && phone.bottom > phone.vh - 40, '6. on a phone: at the bottom, centred, inside the screen', phone ? `${Math.round(phone.left)}…${Math.round(phone.right)} of ${phone.vw}, bottom ${Math.round(phone.bottom)} of ${phone.vh}` : 'none');
  await page.shot(join(OUT, 'promo-deleted-375.png'));

  // 7. axe on the toasts (one of each kind), light and dark.
  await page.viewport(1280);
  next = { status: 409, body: JSON.stringify({ error: 'Walk: refused again.' }) };
  await deleteUnusedPromo();
  await confirmDialog();
  await page.until("document.querySelectorAll('.toast').length >= 2", 5000);
  await page.eval(AXE);
  for (const scheme of ['light', 'dark']) {
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    await sleep(300);
    const v = JSON.parse(await page.eval("axe.run(document.querySelector('.toasts'), { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }).then(r => JSON.stringify(r.violations.map(v => v.id + ' ' + v.nodes.length)))"));
    check(v.length === 0, `7. axe on an ok and an error toast, ${scheme}: no violation`, v.join(', '));
    if (scheme === 'dark') await page.shot(join(OUT, 'toasts-dark-1280.png'));
  }
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

  // 8. The platform: the tenant form and its members panel share ONE region.
  await page.goto(`${BASE}/platform`);
  await page.until("!!document.querySelector('.member-row')", 30000);
  await page.eval("[...document.querySelectorAll('.member-row')].find(r => r.textContent.includes('/t/harbor')).querySelector('button').click()");
  await page.until("!!document.querySelector('#theme-accent')", 15000);
  check((await page.eval("document.querySelectorAll('.toasts').length")) === 1, '8. platform tenant form + members: one region');
  next = { status: 404, body: JSON.stringify({ error: 'Walk: no account with that email.' }) };
  const memberEmail = await page.eval("(() => { const i = [...document.querySelectorAll('input[type=email]')].at(-1); return i ? '#' + (i.id || (i.id = 'walk-member-email')) : null; })()");
  await page.eval(setInput(memberEmail, 'nobody@example.com'));
  await page.eval("[...document.querySelectorAll('input[type=email]')].at(-1).form.querySelector('button[type=submit]').click()");
  await page.until("!!document.querySelector('.toast.error')", 5000);
  check((await page.eval(toastInfo('error', 'Walk: no account'))) !== null, "8b. the members panel's refusal is a toast");
  next = { status: 200, body: harborDetail };
  await page.eval("document.querySelector('section.card form button[type=submit]').click()");
  await page.until("!!document.querySelector('.toast.ok')", 5000);
  check((await page.eval(toastInfo('ok', 'Saved.'))) !== null, '8c. the tenant form\'s "Saved." is a toast');
  await page.shot(join(OUT, 'platform-1280.png'));
} finally {
  browser?.close();
  for (const id of made) {
    await supabase.from('platform_admins').delete().eq('user_id', id);
    await supabase.auth.admin.deleteUser(id);
  }
}

console.log(`\n${failures === 0 ? 'all passed' : `${failures} FAILED`}`);
process.exit(failures ? 1 : 0);
