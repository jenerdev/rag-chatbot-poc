// nav-layout-a11y.mjs — axe over the staff frame after plan/nav-layout.md:
// the top bar, the account menu open, and the phone drawer open, as harbor's
// owner on Bookings, light and dark. The same rules and axe build as
// ui-refresh-a11y.mjs; this is the slice for this change.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/nav-layout-a11y.mjs)
//
// Needs pnpm dev, and axe unpacked as ui-refresh-a11y.mjs says. One
// throwaway owner, deleted. Every non-GET request in the browser is caught.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const AXE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', 'axe', 'axe.min.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { data: harbor } = await supabase.from('tenants').select('id').eq('slug', 'harbor').single();
let userId;
let browser;
let audited = 0;
const found = [];
try {
  const email = `nav-a11y-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  userId = data.user.id;
  await supabase.from('memberships').insert({ user_id: userId, tenant_id: harbor.id, role: 'owner' });
  const r = await fetch(`${BASE}/api/t/harbor/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0]?.slice('rag_admin='.length);
  if (!cookie) throw new Error('login failed');

  for (const scheme of ['light', 'dark']) {
    browser = await openBrowser({ scheme });
    const { page } = browser;
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] });
    page.on('Fetch.requestPaused', (p) =>
      p.request.method === 'GET'
        ? void page.send('Fetch.continueRequest', { requestId: p.requestId })
        : void page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from('{}').toString('base64') }),
    );
    await page.send('Network.setCookie', { name: 'rag_admin', value: cookie, url: `${BASE}/api/t/harbor/`, path: '/api/t/harbor' });
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
      await page.goto(`${BASE}/t/harbor/admin/bookings`);
      await page.until("!!document.querySelector('.account-button') && !document.querySelector('.skeleton')", 60000);
      await sleep(500);
      await audit(`frame @${width}`);
      await page.eval("document.querySelector('.account-button').click(); true");
      await sleep(400);
      await audit(`account menu open @${width}`);
      await page.eval("document.querySelector('.account-button').click(); true");
      if (width === 375) {
        await page.eval("document.querySelector('.topbar-menu').click(); true");
        await sleep(500);
        await audit(`drawer open @${width}`);
      }
    }
    browser.close();
    browser = null;
  }
} finally {
  browser?.close();
  if (userId) await supabase.auth.admin.deleteUser(userId);
}
console.log(`\n${audited} page states audited, ${found.length} violation(s)`);
for (const f of found) console.log(`  ${f}`);
process.exit(found.length === 0 && audited === 10 ? 0 : 1);
