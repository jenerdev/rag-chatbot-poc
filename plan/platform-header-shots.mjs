// platform-header-shots.mjs — /platform photographed (plan/platform-header.md):
// signed out (the login), the tenant list, and one tenant's form, at 1280
// and 375, light and dark.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/platform-header-shots.mjs <label> [business name])
//
// The form photographed is the first tenant's, or the one named (e.g. a tenant with a logo).
//
// Writes plan/platform-header/<label>-<state>-<scheme>-<width>.png. A
// throwaway SUPER USER (an auth user and a platform_admins row), deleted at
// the end. Every non-GET request in the browser is caught, so looking
// changes nothing. Needs pnpm dev.

import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = 'http://localhost:3000';
const LABEL = process.argv[2] ?? 'shot';
const OPEN = process.argv[3] ?? null;
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'platform-header');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let userId = null;
let browser;
try {
  const email = `platform-shots-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  userId = data.user.id;
  const pa = await supabase.from('platform_admins').insert({ user_id: userId });
  if (pa.error) throw new Error(`platform_admins: ${pa.error.message}`);
  const r = await fetch(`${BASE}/api/platform/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_platform='))?.split(';')[0]?.slice('rag_platform='.length);
  if (!cookie) throw new Error(`platform login failed: ${r.status}`);

  for (const scheme of ['light', 'dark']) {
    browser = await openBrowser({ scheme });
    const { page } = browser;
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] });
    page.on('Fetch.requestPaused', (p) =>
      p.request.method === 'GET' || p.request.url.endsWith('/api/platform/session')
        ? void page.send('Fetch.continueRequest', { requestId: p.requestId })
        : void page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from('{}').toString('base64') }),
    );
    for (const width of [1280, 375]) {
      await page.viewport(width);
      // Signed out: the login.
      await page.send('Network.clearBrowserCookies');
      await page.goto(`${BASE}/platform`);
      await page.until("!!document.querySelector('.auth-card, form')", 30000);
      await sleep(800);
      await page.shot(join(OUT, `${LABEL}-login-${scheme}-${width}.png`));
      // Signed in: the list, then one tenant.
      await page.send('Network.setCookie', { name: 'rag_platform', value: cookie, url: `${BASE}/api/platform/`, path: '/api/platform' });
      await page.goto(`${BASE}/platform`);
      await page.until("!!document.querySelector('.platform-tenants') && !document.querySelector('.skeleton')", 30000);
      await sleep(1200);
      await page.shot(join(OUT, `${LABEL}-list-${scheme}-${width}.png`));
      await page.eval(OPEN
        ? `document.querySelector(${JSON.stringify(`[aria-label="Edit ${OPEN}"]`)})?.click(); true`
        : "[...document.querySelectorAll('.platform-tenants button, .platform-tenants a')].find(b => b.textContent.trim() === 'Edit')?.click(); true");
      await page.until("!!document.querySelector('.tenant-edit') && !document.querySelector('.skeleton')", 30000);
      await sleep(1200);
      await page.shot(join(OUT, `${LABEL}-tenant-${scheme}-${width}.png`));
    }
    browser.close();
    browser = null;
  }
  console.log(`written to ${OUT}`);
} finally {
  browser?.close();
  if (userId) {
    await supabase.from('platform_admins').delete().eq('user_id', userId);
    await supabase.auth.admin.deleteUser(userId);
  }
}
