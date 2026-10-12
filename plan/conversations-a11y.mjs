// conversations-a11y.mjs — axe over the pages D-115 added or changed:
// Conversations, one transcript, Unanswered (its new link) and the
// Dashboard (its linked count), as harbor's owner, light and dark, at 1280
// and 375. The same rules and the same axe build as ui-refresh-a11y.mjs,
// which audits every screen and takes far longer; this is the slice to run
// after a change to these four.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/conversations-a11y.mjs)
//
// Needs pnpm dev, and axe unpacked as ui-refresh-a11y.mjs says. Every
// non-GET request is caught in the browser. One throwaway owner, deleted.

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
  const email = `conversations-a11y-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  userId = data.user.id;
  const m = await supabase.from('memberships').insert({ user_id: userId, tenant_id: harbor.id, role: 'owner' });
  if (m.error) throw new Error(m.error.message);
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
      for (const [label, path, ready] of [
        ['conversations', '/admin/conversations?days=90', '.conversation-row'],
        ['unanswered', '/admin/unanswered', '.unanswered, .empty-list'],
        ['dashboard', '/admin/dashboard', '.stat-row'],
      ]) {
        await page.goto(`${BASE}/t/harbor${path}`);
        await page.until(`!!document.querySelector(${JSON.stringify(ready)})`, 60000);
        await sleep(400);
        await audit(`${label} @${width}`);
      }
      await page.goto(`${BASE}/t/harbor/admin/conversations?days=90`);
      if (await page.until("!!document.querySelector('.conversation-row-link')", 60000)) {
        await page.click('.conversation-row-link');
        await page.until("!!document.querySelector('.transcript')", 60000);
        await sleep(400);
        await audit(`transcript @${width}`);
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
process.exit(found.length === 0 && audited === 16 ? 0 : 1);
