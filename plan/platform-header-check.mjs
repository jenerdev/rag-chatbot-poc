// platform-header-check.mjs — /platform's top bar (plan/platform-header.md):
// a walk (the breadcrumb leads back, the account menu logs out) and axe over
// the login, the list, a tenant and the menu open, 1280 and 375, light and
// dark (16 states). A throwaway super user, deleted at the end. In the axe
// pass every non-GET request is caught; the walk logs out for real.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/platform-header-check.mjs)

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = 'http://localhost:3000';
const AXE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', 'axe', 'axe.min.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

let userId = null;
let browser;
let audited = 0;
const found = [];
try {
  const email = `platform-check-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  userId = data.user.id;
  await supabase.from('platform_admins').insert({ user_id: userId });
  const login = async () => {
    const r = await fetch(`${BASE}/api/platform/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    return (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_platform='))?.split(';')[0]?.slice('rag_platform='.length);
  };
  const ready = "!!document.querySelector('.platform-tenants') && !document.querySelector('.skeleton') && [...document.querySelectorAll('.platform-tenants button')].some(b => b.textContent.trim() === 'Edit')";
  const editFirst = "[...document.querySelectorAll('.platform-tenants button')].find(b => b.textContent.trim() === 'Edit').click(); true";

  // 1. The walk, at 1280.
  browser = await openBrowser();
  let { page } = browser;
  await page.viewport(1280);
  await page.send('Network.setCookie', { name: 'rag_platform', value: await login(), url: `${BASE}/api/platform/`, path: '/api/platform' });
  await page.goto(`${BASE}/platform`);
  await page.until(ready, 30000);
  const listBar = await page.eval("({ name: document.querySelector('.platform-name')?.textContent, crumbs: document.querySelector('.topbar-crumbs')?.textContent, account: document.querySelector('.account-role')?.textContent })");
  check(listBar.name === 'Platform' && listBar.crumbs === 'Tenants' && listBar.account === 'Super user', '1. the list: Platform, the breadcrumb says Tenants, the account says Super user', JSON.stringify(listBar));
  await page.eval(editFirst);
  await page.until("!!document.querySelector('.tenant-edit') && !!document.querySelector('.crumb-link') && !document.querySelector('.topbar-here')?.textContent.includes('…')", 30000);
  const tenantBar = await page.eval("({ crumbs: document.querySelector('.topbar-crumbs').textContent, title: document.querySelector('.tenant-edit h1, .tenant-edit h2')?.textContent })");
  check(/^Tenants.+/.test(tenantBar.crumbs) && !!tenantBar.title && tenantBar.title.startsWith(tenantBar.crumbs.slice('Tenants'.length)), '2. a tenant: Tenants › its name', JSON.stringify(tenantBar));
  const edges = await page.eval("({ mark: Math.round(document.querySelector('.platform-mark').getBoundingClientRect().left), page: Math.round(document.querySelector('main').getBoundingClientRect().left + parseFloat(getComputedStyle(document.querySelector('main')).paddingLeft)) })");
  check(edges.mark === edges.page, '3. the bar lines up with the page under it', JSON.stringify(edges));
  await page.click('.crumb-link');
  check(await page.until(`${ready} && document.querySelector('.topbar-crumbs').textContent === 'Tenants'`, 30000), '4. the breadcrumb leads back to the list');
  await page.click('.account-button');
  await page.eval("[...document.querySelectorAll('.account-panel button')].find(b => b.textContent === 'Log out').click(); true");
  check(await page.until("!!document.querySelector('form input[type=email]') && !document.querySelector('.account-button')", 15000), '5. Log out from the account menu: the login, no account button');
  browser.close();
  browser = null;

  // 2. axe, 16 states.
  const cookie = await login();
  for (const scheme of ['light', 'dark']) {
    browser = await openBrowser({ scheme });
    page = browser.page;
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] });
    page.on('Fetch.requestPaused', (p) =>
      p.request.method === 'GET'
        ? void page.send('Fetch.continueRequest', { requestId: p.requestId })
        : void page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from('{}').toString('base64') }),
    );
    const audit = async (label) => {
      await page.eval(AXE);
      const violations = JSON.parse(
        await page.eval(`axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }).then(r => JSON.stringify(r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(' ') }))))`),
      );
      audited++;
      for (const v of violations) found.push(`${label} [${scheme}] ${v.id} (${v.impact}, ${v.nodes}): ${v.sample}`);
      console.log(`${violations.length === 0 ? 'clean' : `${violations.length} violation(s)`}  ${label} [${scheme}]`);
    };
    for (const width of [1280, 375]) {
      await page.viewport(width);
      await page.send('Network.clearBrowserCookies');
      await page.goto(`${BASE}/platform`);
      await page.until("!!document.querySelector('form input[type=email]')", 30000);
      await sleep(500);
      await audit(`login @${width}`);
      await page.send('Network.setCookie', { name: 'rag_platform', value: cookie, url: `${BASE}/api/platform/`, path: '/api/platform' });
      await page.goto(`${BASE}/platform`);
      await page.until(ready, 30000);
      await sleep(500);
      await audit(`list @${width}`);
      await page.eval("document.querySelector('.account-button').click(); true");
      await sleep(300);
      await audit(`account menu @${width}`);
      await page.eval("document.querySelector('.account-button').click(); true");
      await page.eval(editFirst);
      await page.until("!!document.querySelector('.tenant-edit') && !document.querySelector('.skeleton')", 30000);
      await sleep(800);
      await audit(`tenant @${width}`);
    }
    browser.close();
    browser = null;
  }
} finally {
  browser?.close();
  if (userId) {
    await supabase.from('platform_admins').delete().eq('user_id', userId);
    await supabase.auth.admin.deleteUser(userId);
  }
}
console.log(`\n${audited} page states audited, ${found.length} violation(s)`);
for (const f of found) console.log(`  ${f}`);
console.log(failures ? `${failures} FAILED` : 'walk: all passed');
process.exit(failures === 0 && found.length === 0 && audited === 16 ? 0 : 1);
