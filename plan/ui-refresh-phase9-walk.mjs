// ui-refresh-phase9-walk.mjs — the remaining staff screens and the platform
// in a real browser, against a running dev server (plan/ui-refresh.md
// Phase 9): slots, promos, holidays, rooms (with a photo DROPPED on its
// tile), members, the platform's tenant list and its contrast advice.
// Two throwaway users (an owner of harbor; a super user, with a
// platform_admins row), deleted at the end. Screenshots into
// plan/ui-refresh/phase9/walk/.
//
// Nothing is changed: EVERY non-GET request the page makes is caught inside
// the browser, recorded and answered there; reads go to the real server.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/ui-refresh-phase9-walk.mjs [base-url])

import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', 'phase9', 'walk');
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const setInput = (selector, value) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`;

const { data: harbor } = await supabase.from('tenants').select('id').eq('slug', 'harbor').single();
const stamp = Date.now();
const made = [];
async function makeUser(name) {
  const email = `ui-walk9-${name}-${stamp}@example.com`;
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

  for (const scheme of ['light', 'dark']) {
    browser = await openBrowser({ scheme });
    const { page } = browser;
    const loud = scheme === 'light';
    const dir = scheme === 'dark' ? `${OUT}-dark` : OUT;
    const writes = [];
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] });
    page.on('Fetch.requestPaused', (p) => {
      if (p.request.method === 'GET') return void page.send('Fetch.continueRequest', { requestId: p.requestId });
      writes.push({ method: p.request.method, path: new URL(p.request.url).pathname });
      void page.send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from('{}').toString('base64'),
      });
    });
    await page.send('Network.setCookie', { name: 'rag_admin', value: ownerCookie, url: `${BASE}/api/t/harbor/`, path: '/api/t/harbor' });
    await page.send('Network.setCookie', { name: 'rag_platform', value: superCookie, url: `${BASE}/api/platform/`, path: '/api/platform' });
    const dialogBack = async () => {
      await page.until("!!document.querySelector('dialog.dialog[open]')", 5000);
      const title = await page.eval("document.querySelector('dialog.dialog h2').textContent");
      await page.eval("document.querySelector('dialog.dialog .dialog-actions button[type=button]').click()");
      await page.until("!document.querySelector('dialog.dialog[open]')", 3000);
      return title;
    };
    const drawerOpenClose = async () => {
      await page.click('.page-actions button');
      const opened = await page.until("!!document.querySelector('dialog.drawer[open]')", 3000);
      await page.key('Escape', 'Escape', 27);
      await page.until("!document.querySelector('dialog.drawer[open]')", 3000);
      return opened;
    };

    for (const width of [1280, 375]) {
      await page.viewport(width);
      const first = loud && width === 1280;
      const shot = (name) => page.shot(join(dir, `${name}-${width}.png`));
      const go = async (path, ready) => {
        await page.goto(`${BASE}${path}`);
        await page.until(ready, 30000);
        if (loud && width === 375) {
          const wide = await page.eval('document.documentElement.scrollWidth');
          check(wide <= 375, `p. ${path}, phone: nothing wider than the screen`, `${wide}px`);
        }
      };

      // 1. Slots.
      await go('/t/harbor/admin/slots', "!!document.querySelector('.list-row')");
      await shot('slots');
      if (first) {
        check((await page.eval("document.querySelector('.page-actions button').textContent.trim()")) === 'Add a slot' && (await drawerOpenClose()), '1. slots: "Add a slot" opens the drawer');
        await page.click('.list-row-actions button[aria-label^="Edit"]');
        check(await page.until("document.querySelector('dialog.drawer[open] h2')?.textContent.startsWith('Edit')", 3000), '1b. Edit opens the same drawer, titled Edit');
        await page.key('Escape', 'Escape', 27);
        const folded = await page.eval("(() => { const d = document.querySelector('details.folded'); return d ? (d.open ? 'open' : 'closed') : 'none'; })()");
        check(folded !== 'open', '1c. retired slots folded away', folded);
        await page.eval("[...document.querySelectorAll('.list-row-actions button')].find(b => b.textContent === 'Retire' || b.getAttribute('aria-label')?.startsWith('Delete')).click()");
        const t = await dialogBack();
        check(/^(Retire|Delete) "/.test(t) && writes.length === 0, '1d. Retire/Delete asks; Back sends nothing', t);
      }

      // 2. Promos.
      await go('/t/harbor/admin/promos', "!!document.querySelector('.list-row') || !!document.querySelector('.page-actions')");
      await shot('promos');
      if (first) {
        check(await page.eval("[...document.querySelectorAll('.list-row .badge.ok')].every(b => / off$/.test(b.textContent)) && document.querySelectorAll('.list-row .badge.ok').length > 0"), '2. promos: the value is a badge in words', await page.eval("[...document.querySelectorAll('.list-row .badge.ok')].map(b => b.textContent).join(' | ')"));
        check(await drawerOpenClose(), '2b. "Add a promo" opens the drawer');
      }

      // 3. Holidays.
      await go('/t/harbor/admin/holidays', "!!document.querySelector('.page-actions')");
      await shot('holidays');
      if (first) {
        check(await drawerOpenClose(), '3. holidays: "Add a date" opens the drawer');
        const months = await page.eval("[...document.querySelectorAll('.month-label')].map(h => h.textContent)");
        check(months.length === 0 || months.every((m) => /^[A-Z][a-z]+ \d{4}$/.test(m)), '3b. the dates grouped by month', months.join(', ') || '(none listed)');
      }

      // 4. Rooms: the drawer, Retire asks, a photo DROPPED on the tile goes up.
      await go('/t/harbor/admin/accommodations', "!!document.querySelector('.room-head')");
      await shot('rooms');
      if (first) {
        check(await drawerOpenClose(), '4. rooms: "Add a room" opens the drawer');
        await page.eval("[...document.querySelectorAll('.room-head button')].find(b => b.textContent === 'Retire').click()");
        const t = await dialogBack();
        check(t.startsWith('Retire') && !writes.some((w) => w.method !== 'GET'), '4b. Retire asks; Back sends nothing', t);
        const tile = await page.eval("!!document.querySelector('.photo-add') && document.querySelector('.photo-add-text').textContent === 'Add a photo'");
        if (tile) {
          const before = writes.length;
          await page.eval(`(async () => {
            const c = document.createElement('canvas'); c.width = 64; c.height = 48;
            const g = c.getContext('2d'); g.fillStyle = '#3a8'; g.fillRect(0, 0, 64, 48);
            const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
            const dt = new DataTransfer(); dt.items.add(new File([blob], 'walk9.png', { type: 'image/png' }));
            document.querySelector('.photo-add').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
          })()`);
          const up = await page.until(`${before} < 0 || true`, 100) && (await (async () => { for (let i = 0; i < 25; i++) { if (writes.length > before) return true; await new Promise((r) => setTimeout(r, 200)); } return false; })());
          const w = writes[before];
          check(up && w?.method === 'POST' && /\/accommodations\/\d+\/images$/.test(w.path), '4c. a photo dropped on the tile is resized and sent (caught)', JSON.stringify(w));
        } else {
          check(false, '4c. a room has the photo tile');
        }
      }

      // 5. Members.
      await go('/t/harbor/admin/members', "!!document.querySelector('.member-row')");
      await shot('members');
      if (first) {
        // "You" is marked only where the panel knows the viewer's id (the platform passes it; the session route does not return one).
        check(await page.eval("[...document.querySelectorAll('.member-row')].every(r => /^[A-Z0-9]$/i.test(r.querySelector('.member-avatar').textContent))"), '5. members: an initial each', `${await page.eval("document.querySelectorAll('.member-row').length")} members`);
        const before = writes.length;
        await page.click('.member-row button[aria-label^="Remove"]');
        const t = await dialogBack();
        check(t.startsWith('Remove ') && writes.length === before, '5b. Remove asks; Back sends nothing', t);
      }

      // 6. The platform: the tenant list, then harbor's form and its contrast advice.
      await go('/platform', "!!document.querySelector('.member-row')");
      await shot('platform');
      if (first) {
        check(await page.eval("document.querySelectorAll('.member-row .member-avatar').length >= 3"), '6. platform: tenants as rows with an initial', `${await page.eval("document.querySelectorAll('.member-row').length")} tenants`);
        await page.eval("[...document.querySelectorAll('.member-row')].find(r => r.textContent.includes('/t/harbor')).querySelector('button').click()");
        await page.until("!!document.querySelector('#theme-accent')", 15000);
        check(await page.eval("/passes the 4.5:1/.test(document.querySelector('.hint.met')?.textContent ?? '')"), '6b. harbor\'s colours pass the contrast check');
        await page.eval(setInput('#theme-accent', '#ffd400'));
        const warn = await page.until("/White button text on the accent is 1\\.\\d:1/.test(document.querySelector('.notice.warn')?.textContent ?? '')", 3000);
        await page.eval("document.querySelector('.notice.warn').scrollIntoView()");
        await shot('platform-contrast');
        check(warn, '6c. a pale accent: the form names the pair and its ratio, as it is typed');
        const before = writes.length;
        await page.eval("[...document.querySelectorAll('button')].find(b => b.textContent === 'Archive').click()");
        const t = await dialogBack();
        check(t.startsWith('Archive ') && writes.length === before, '6d. Archive asks; Back sends nothing', t);
      }
    }
    if (loud) check(writes.every((w) => w.method !== 'GET'), `7. ${writes.length} write(s) made, all caught in the browser`, writes.map((w) => `${w.method} ${w.path}`).join(', '));
    browser.close();
    browser = null;
  }
} finally {
  browser?.close();
  for (const id of made) {
    await supabase.from('platform_admins').delete().eq('user_id', id);
    const { error } = await supabase.auth.admin.deleteUser(id);
    console.log(error ? `cleanup: ${error.message}` : `cleanup: user ${id.slice(0, 8)} deleted`);
  }
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
