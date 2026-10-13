// nav-layout-shots.mjs — the staff frame's navigation, photographed
// (plan/nav-layout.md). As harbor's OWNER (every link) and a STAFF member
// (the fewest), at 1280 and at 375 with the drawer open, light and dark.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/nav-layout-shots.mjs <label>)
//
// Writes plan/nav-layout/<label>-<role>-<scheme>-<width>[-menu].png. Needs
// pnpm dev. Two throwaway members, deleted at the end. Every non-GET request
// in the browser is caught, so nothing is changed by looking.

import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = 'http://localhost:3000';
const SLUG = 'harbor';
const LABEL = process.argv[2] ?? 'shot';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'nav-layout');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', SLUG).single();
const users = [];
let browser;
try {
  const login = async (role) => {
    const email = `nav-shots-${role}-${Date.now()}@example.com`;
    const password = randomBytes(18).toString('base64url');
    const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(error.message);
    users.push(data.user.id);
    await supabase.from('memberships').insert({ user_id: data.user.id, tenant_id: tenant.id, role });
    const r = await fetch(`${BASE}/api/t/${SLUG}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const cookie = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0];
    if (!cookie) throw new Error('login failed');
    return cookie.slice('rag_admin='.length);
  };
  const cookies = { owner: await login('owner'), staff: await login('staff') };

  for (const scheme of ['light', 'dark']) {
    for (const role of ['owner', 'staff']) {
      browser = await openBrowser({ scheme });
      const { page } = browser;
      await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] });
      page.on('Fetch.requestPaused', (p) =>
        p.request.method === 'GET'
          ? void page.send('Fetch.continueRequest', { requestId: p.requestId })
          : void page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from('{}').toString('base64') }),
      );
      await page.send('Network.setCookie', { name: 'rag_admin', value: cookies[role], url: `${BASE}/api/t/${SLUG}/`, path: `/api/t/${SLUG}` });
      for (const width of [1280, 375]) {
        await page.viewport(width);
        await page.goto(`${BASE}/t/${SLUG}/admin/bookings`);
        await page.until("!!document.querySelector('.staff-shell')", 60000);
        await sleep(1500);
        await page.shot(join(OUT, `${LABEL}-${role}-${scheme}-${width}.png`));
        if (await page.eval("!!document.querySelector('.account-button')")) {
          await page.eval("document.querySelector('.account-button').click(); true");
          await sleep(1200);
          await page.shot(join(OUT, `${LABEL}-${role}-${scheme}-${width}-account.png`));
          await page.eval("document.querySelector('.account-button').click(); true");
          await sleep(300);
        }
        if (width === 375) {
          await page.eval("document.querySelector('[aria-controls=\"staff-sidebar\"]')?.click(); true");
          await sleep(600);
          await page.shot(join(OUT, `${LABEL}-${role}-${scheme}-${width}-menu.png`));
        }
      }
      browser.close();
      browser = null;
    }
  }
  console.log(`written to ${OUT}`);
} finally {
  browser?.close();
  for (const id of users) await supabase.auth.admin.deleteUser(id);
}
