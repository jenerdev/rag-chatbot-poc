// ui-refresh-phase7-walk.mjs — the Bookings screen in a real browser, against
// a running dev server (plan/ui-refresh.md Phase 7): the decision dialog
// (Escape is "no"), the New booking drawer, the status filter. One throwaway
// harbor owner, deleted at the end. Screenshots into
// plan/ui-refresh/phase7/walk/.
//
// No booking is changed. Every WRITE this screen makes (PATCH a decision,
// POST a booking) is caught inside the browser, its body recorded, and
// answered there; every read, and the quote, go to the real server.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/ui-refresh-phase7-walk.mjs [base-url])

import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', 'phase7', 'walk');
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const setValue = (selector, value) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`;

const { data: harbor } = await supabase.from('tenants').select('id').eq('slug', 'harbor').single();
const email = `ui-walk7-${Date.now()}@example.com`;
const password = randomBytes(18).toString('base64url');
const { data: created, error: createError } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
if (createError) throw new Error(createError.message);
const userId = created.user.id;

let browser;
try {
  const { error: e } = await supabase.from('memberships').insert({ user_id: userId, tenant_id: harbor.id, role: 'owner' });
  if (e) throw new Error(e.message);
  const r = await fetch(`${BASE}/api/t/harbor/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0]?.slice('rag_admin='.length);
  if (!cookie) throw new Error(`login: ${r.status}`);

  for (const scheme of ['light', 'dark']) {
    browser = await openBrowser({ scheme });
    const { page } = browser;
    const loud = scheme === 'light';
    const dir = scheme === 'dark' ? `${OUT}-dark` : OUT;
    const writes = [];
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/t/harbor/bookings*' }] });
    page.on('Fetch.requestPaused', (p) => {
      const url = new URL(p.request.url);
      const isWrite = p.request.method === 'PATCH' || (p.request.method === 'POST' && url.pathname.endsWith('/bookings'));
      if (!isWrite) return void page.send('Fetch.continueRequest', { requestId: p.requestId });
      const body = p.request.postData ? JSON.parse(p.request.postData) : null;
      writes.push({ method: p.request.method, path: url.pathname, body });
      const answer = p.request.method === 'POST'
        ? { bookings: [{ unit: 'Garden Room', slot: 'Night', date: body?.date, guestName: body?.guestName }], total: 350000 }
        : {};
      void page.send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify(answer)).toString('base64'),
      });
    });
    await page.send('Network.setCookie', { name: 'rag_admin', value: cookie, url: `${BASE}/api/t/harbor/`, path: '/api/t/harbor' });

    for (const width of [1280, 375]) {
      const first = loud && width === 1280;
      const shot = (name) => page.shot(join(dir, `${name}-${width}.png`));
      await page.viewport(width);
      await page.goto(`${BASE}/t/harbor/admin/bookings`);
      await page.until("!!document.querySelector('.day') && !!document.querySelector('.page-actions')", 30000);
      await shot('bookings');

      if (first) {
        check(await page.eval("document.querySelector('.page-actions button')?.textContent.trim() === 'New booking'"), '1. "New booking" beside the page title');
        const row = await page.eval("(() => { const r = document.querySelector('.booking.request'); if (!r) return null; return { badges: [...r.querySelectorAll('.badge')].map(b => b.textContent.trim()), confirmOff: r.querySelector('.booking-actions .primary')?.disabled }; })()");
        check(!!row && row.badges.length >= 2, '1b. a request row: reference and source as badges', JSON.stringify(row));

        // 2. Decline, then Escape: no write, focus back on Decline.
        await page.eval("[...document.querySelectorAll('.booking.request .booking-actions button')].find(b => b.textContent === 'Decline').focus()");
        await page.eval("document.activeElement.click()");
        await page.until("!!document.querySelector('dialog.dialog[open]')", 3000);
        check(await page.eval("document.activeElement?.tagName === 'TEXTAREA' && !!document.activeElement.closest('dialog')"), '2. Decline opens the dialog; focus in its note');
        await shot('decline-dialog');
        await page.key('Escape', 'Escape', 27);
        await page.until("!document.querySelector('dialog.dialog[open]')", 3000);
        check(writes.length === 0 && (await page.eval("document.activeElement?.textContent === 'Decline'")), '2b. Escape: nothing sent, focus back on Decline', `${writes.length} writes`);

        // 3. Decline with a note: one PATCH, the note in its body.
        await page.eval("document.activeElement.click()");
        await page.until("!!document.querySelector('dialog.dialog[open] textarea')", 3000);
        await page.type('dialog.dialog textarea', 'walk7: dates no longer wanted');
        await page.click('dialog.dialog button[type=submit]');
        await page.until("document.querySelector('.notice.ok')?.textContent.startsWith('Declined')", 5000);
        const w = writes[0];
        check(writes.length === 1 && w.method === 'PATCH' && w.path.includes('/bookings/requests/') && w.body?.action === 'decline' && w.body?.note === 'walk7: dates no longer wanted', '3. Decline with a note: one PATCH, action and note in its body', JSON.stringify(w));

        // 4. Cancel on a booking, then "Keep it": nothing sent.
        await page.eval("[...document.querySelectorAll('.booking:not(.request) .booking-actions button')].find(b => b.textContent === 'Cancel').click()");
        await page.until("!!document.querySelector('dialog.dialog[open]')", 3000);
        check(await page.eval("document.querySelector('dialog.dialog h2').textContent === 'Cancel this booking?' && [...document.querySelectorAll('dialog.dialog button')].map(b => b.textContent).join('|') === 'Keep it|Cancel booking'"), '4. Cancel asks, with "Keep it" and "Cancel booking"');
        await shot('cancel-dialog');
        await page.eval("[...document.querySelectorAll('dialog.dialog button')].find(b => b.textContent === 'Keep it').click()");
        check(writes.length === 1, '4b. "Keep it": nothing sent');

        // 5. The drawer keeps what was typed when closed; Book sends one POST and closes it.
        await page.click('.page-actions button');
        await page.until("!!document.querySelector('dialog.drawer[open]')", 3000);
        await page.type('#guest-name', 'Walk Seven');
        await page.key('Escape', 'Escape', 27);
        await page.until("!document.querySelector('dialog.drawer[open]')", 3000);
        await page.click('.page-actions button');
        await page.until("!!document.querySelector('dialog.drawer[open]')", 3000);
        check(await page.eval("document.querySelector('#guest-name').value === 'Walk Seven'"), '5. closed and reopened, the drawer kept the guest name');
        // Night: harbor prices its rooms by the night; its Day Tour slot has no rate yet.
        await page.eval("(() => { const s = document.querySelector('dialog.drawer #slot'); const night = [...s.options].find(o => o.textContent.startsWith('Night')); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, night.value); s.dispatchEvent(new Event('change', { bubbles: true })); })()");
        await page.eval("document.querySelector('dialog.drawer .room-pick input[type=checkbox]').click()");
        await page.until("!!document.querySelector('dialog.drawer .room-pick.picked input[type=number]')", 3000);
        await page.eval(setValue('dialog.drawer .room-pick.picked input[type=number]', '2'));
        const priced = await page.until("!!document.querySelector('dialog.drawer .quote-total')", 15000);
        await shot('drawer');
        check(priced, '5b. the drawer shows the server\'s quote', await page.eval("document.querySelector('dialog.drawer .quote-total')?.textContent"));
        await page.click('dialog.drawer button[type=submit]');
        await page.until("!document.querySelector('dialog.drawer[open]') && document.querySelector('.notice.ok')?.textContent.startsWith('Booked')", 5000);
        const post = writes[1];
        check(writes.length === 2 && post.method === 'POST' && post.body?.guestName === 'Walk Seven' && post.body?.rooms?.[0]?.guestCount === 2, '5c. Book: one POST with the room and its guests; the drawer closed; the notice says Booked', JSON.stringify(post?.body));

        // 6. The status filter narrows the drawn rows only.
        const allRows = await page.eval("document.querySelectorAll('.day .booking').length");
        await page.eval("[...document.querySelectorAll('.segmented button')].find(b => b.textContent === 'Cancelled').click()");
        const cancelledOnly = await page.eval("(() => { const rows = [...document.querySelectorAll('.day .booking')]; return { n: rows.length, all: rows.every(r => r.classList.contains('cancelled')) }; })()");
        await shot('filter-cancelled');
        check(cancelledOnly.n > 0 && cancelledOnly.all && cancelledOnly.n < allRows, '6. Cancelled: only cancelled rows', `${cancelledOnly.n} of ${allRows}`);
        await page.eval("[...document.querySelectorAll('.segmented button')].find(b => b.textContent === 'All').click()");
      }
      if (loud && width === 375) {
        await page.click('.page-actions button');
        await page.until("!!document.querySelector('dialog.drawer[open]')", 3000);
        await new Promise((r) => setTimeout(r, 300));
        await shot('drawer');
        const full = await page.eval("Math.round(document.querySelector('dialog.drawer').getBoundingClientRect().width)");
        check(full === 375, '7. phone: the drawer is the full width', `${full}px`);
        await page.key('Escape', 'Escape', 27);
        check((await page.eval('document.documentElement.scrollWidth')) <= 375, '7b. phone: nothing wider than the screen', `${await page.eval('document.documentElement.scrollWidth')}px`);
      }
    }
    if (loud) check(writes.every((w) => w.method === 'PATCH' || w.method === 'POST'), '8. every write was caught in the browser', `${writes.length} caught`);
    browser.close();
    browser = null;
  }
} finally {
  browser?.close();
  const { error } = await supabase.auth.admin.deleteUser(userId);
  console.log(error ? `cleanup: ${error.message}` : `cleanup: ${email} deleted`);
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
