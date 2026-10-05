// ui-refresh-phase6-walk.mjs — the dashboard in a real browser, against a
// running dev server (plan/ui-refresh.md Phase 6): the to-do tiles, the
// window control, the charts drawn at their real width and read by hover AND
// keyboard, money withheld from staff. Three throwaway users (an owner and a
// staff member of harbor, an admin of northwind), deleted at the end.
// Screenshots into plan/ui-refresh/phase6/walk/.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/ui-refresh-phase6-walk.mjs [base-url])

import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', 'phase6', 'walk');
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

const { data: tenants } = await supabase.from('tenants').select('id, slug').in('slug', ['harbor', 'northwind']);
const idOf = Object.fromEntries(tenants.map((t) => [t.slug, t.id]));
const stamp = Date.now();
const users = {};
async function makeUser(name, slug, role) {
  const email = `ui-walk6-${name}-${stamp}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`create ${name}: ${error.message}`);
  users[name] = { id: data.user.id, email, password };
  const { error: e } = await supabase.from('memberships').insert({ user_id: data.user.id, tenant_id: idOf[slug], role });
  if (e) throw new Error(`membership ${name}: ${e.message}`);
}
async function cookieFor(slug, user) {
  const r = await fetch(`${BASE}/api/t/${slug}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: user.email, password: user.password }) });
  const c = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0];
  if (!c) throw new Error(`login ${slug}: ${r.status}`);
  return c.slice('rag_admin='.length);
}

let browser;
try {
  await makeUser('owner', 'harbor', 'owner');
  await makeUser('staffer', 'harbor', 'staff');
  await makeUser('nwadmin', 'northwind', 'admin');
  const cookies = { owner: await cookieFor('harbor', users.owner), staffer: await cookieFor('harbor', users.staffer), nwadmin: await cookieFor('northwind', users.nwadmin) };

  for (const scheme of ['light', 'dark']) {
    browser = await openBrowser({ scheme });
    const { page } = browser;
    const loud = scheme === 'light';
    const dir = scheme === 'dark' ? `${OUT}-dark` : OUT;
    const open = async (slug, who, width) => {
      await page.send('Network.clearBrowserCookies');
      await page.send('Network.setCookie', { name: 'rag_admin', value: cookies[who], url: `${BASE}/api/t/${slug}/`, path: `/api/t/${slug}` });
      await page.viewport(width);
      await page.goto(`${BASE}/t/${slug}/admin/dashboard`);
      await page.until("!!document.querySelector('.stat-tiles') && !!document.querySelector('.bar-chart svg')", 30000);
      await new Promise((r) => setTimeout(r, 300)); // the first measurement
      // Every dashboard on a phone, not one: a hidden table once widened harbor's page to 453px.
      if (loud && width === 375) {
        const wide = await page.eval('document.documentElement.scrollWidth');
        check(wide <= 375, `p. ${slug} as ${who}, phone: nothing wider than the screen`, `${wide}px`);
      }
    };

    for (const width of [1280, 375]) {
      const first = loud && width === 1280;

      // 1. The owner of harbor: four tiles, the window, the charts, the money.
      await open('harbor', 'owner', width);
      await page.shot(join(dir, `harbor-owner-${width}.png`));
      if (first) {
        const tiles = await page.eval("[...document.querySelectorAll('.stat-tile')].map(t => t.querySelector('.stat-tile-label').textContent + '=' + t.querySelector('.stat-tile-value').textContent + '>' + new URL(t.href).pathname.split('/').pop())");
        check(tiles.length === 4 && tiles[0].startsWith('Requests waiting=') && tiles[3].startsWith('Unanswered questions=') && tiles[3].endsWith('>unanswered'), '1. four to-do tiles, each a link to its screen', tiles.join(' | '));
        check(await page.eval("[...document.querySelectorAll('.stat-tile.warn')].every(t => !!t.querySelector('.stat-tile-label svg'))"), '1b. a count needing eyes carries an icon, not colour alone');
        check(await page.eval("document.querySelector('.segmented [aria-pressed=true]')?.textContent === '30 days'"), '1c. the window: 30 days pressed');
        const sizes = await page.eval("[...document.querySelectorAll('.bar-chart')].map(f => { const s = f.querySelector('svg'); return [Number(s.getAttribute('width')), Math.round(f.clientWidth), s.getAttribute('preserveAspectRatio')]; })");
        check(sizes.length > 0 && sizes.every(([w, c, par]) => Math.abs(w - c) <= 1 && par === null), '1d. every chart drawn at its real width, nothing stretched', JSON.stringify(sizes));
        check(await page.eval("[...document.querySelectorAll('.card h2')].some(h => h.textContent.startsWith('Revenue'))"), '1e. the owner sees Revenue');

        // 2. Hover a bar: the readout, value first.
        const box = await page.eval("(() => { const r = document.querySelector('.bar-chart svg').getBoundingClientRect(); return { x: r.right - 6, y: r.top + r.height / 2 }; })()");
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
        check(await page.until("!!document.querySelector('.bar-chart-tip strong')", 2000), '2. hover: a readout', await page.eval("document.querySelector('.bar-chart-tip')?.innerText.replace(/\\n/g, ' · ')"));
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });

        // 3. The keyboard: one tab stop, the arrows step, a live region says it.
        await page.eval("document.querySelector('.bar-chart svg').focus()");
        const last = await page.eval("document.querySelector('.bar-chart [aria-live]').textContent");
        await page.key('ArrowLeft', 'ArrowLeft', 37);
        const prev = await page.eval("document.querySelector('.bar-chart [aria-live]').textContent");
        await page.key('Home', 'Home', 36);
        const home = await page.eval("document.querySelector('.bar-chart [aria-live]').textContent");
        check(last !== '' && prev !== last && home !== prev, '3. keyboard: focus reads the last bar, ← and Home step', `${last} → ${prev} → ${home}`);
        await page.shot(join(dir, `harbor-keyboard-${width}.png`));
        await page.eval("document.activeElement.blur()");

        // 4. The window control changes the window.
        await page.eval("[...document.querySelectorAll('.segmented button')].find(b => b.textContent === '7 days').click()");
        check(await page.until("document.querySelector('.segmented [aria-pressed=true]')?.textContent === '7 days' && [...document.querySelectorAll('.card h2')].some(h => h.textContent === 'Chat, last 7 days')", 10000), '4. 7 days: pressed, and the cards say "last 7 days"');
      }

      // 5. A staff member: no Revenue (the function withholds it).
      await open('harbor', 'staffer', width);
      await page.shot(join(dir, `harbor-staff-${width}.png`));
      if (first) check(await page.eval("![...document.querySelectorAll('.card h2')].some(h => h.textContent.startsWith('Revenue')) && document.querySelectorAll('.stat-tile').length === 4"), '5. staff: the four tiles, no Revenue card');

      // 6. northwind, no bookings: one tile.
      await open('northwind', 'nwadmin', width);
      await page.shot(join(dir, `northwind-${width}.png`));
      if (first) check(await page.eval("document.querySelectorAll('.stat-tile').length === 1 && document.querySelector('.stat-tile-label').textContent === 'Unanswered questions'"), '6. northwind: one tile, Unanswered questions');
    }
    browser.close();
    browser = null;
  }
} finally {
  browser?.close();
  for (const u of Object.values(users)) {
    const { error } = await supabase.auth.admin.deleteUser(u.id);
    console.log(error ? `cleanup: ${error.message}` : `cleanup: ${u.email} deleted`);
  }
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
