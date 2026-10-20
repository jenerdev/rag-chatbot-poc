// audit-log-a11y.mjs — axe over the pages D-138 added or changed: S-18
// Activity (with rows, and filtered to one area), the Members screen (its
// new link) as villa's owner, and the platform page with its Platform
// activity card as a super user; light and dark, 1280 and 375. The same
// rules and the same axe build as ui-refresh-a11y.mjs.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/audit-log-a11y.mjs)
//
// Needs pnpm dev, and axe unpacked as ui-refresh-a11y.mjs says. Every
// non-GET request is caught in the browser. A throwaway owner and a
// throwaway super user, deleted, and their audit rows with them.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const SLUG = 'villa';
const AXE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', 'axe', 'axe.min.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RUN_START = new Date().toISOString();
const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', SLUG).single();
const users = [];
let browser;
let audited = 0;
const found = [];
try {
  const user = async (prefix) => {
    const email = `${prefix}-${Date.now()}-${randomBytes(2).toString('hex')}@example.com`;
    const password = randomBytes(18).toString('base64url');
    const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(error.message);
    users.push(data.user.id);
    return { id: data.user.id, email, password };
  };
  const owner = await user('a11y-owner');
  const m = await supabase.from('memberships').insert({ user_id: owner.id, tenant_id: tenant.id, role: 'owner' });
  if (m.error) throw new Error(m.error.message);
  const su = await user('a11y-super');
  const pa = await supabase.from('platform_admins').insert({ user_id: su.id });
  if (pa.error) throw new Error(pa.error.message);
  const r = await fetch(`${BASE}/api/t/${SLUG}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: owner.email, password: owner.password }) });
  const cookie = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0]?.slice('rag_admin='.length);
  if (!cookie) throw new Error('login failed');
  const pr = await fetch(`${BASE}/api/platform/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: su.email, password: su.password }) });
  const platformCookie = (pr.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_platform='))?.split(';')[0]?.slice('rag_platform='.length);
  if (!platformCookie) throw new Error('platform login failed');

  for (const scheme of ['light', 'dark']) {
    browser = await openBrowser({ scheme });
    const { page } = browser;
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] });
    page.on('Fetch.requestPaused', (p) =>
      p.request.method === 'GET'
        ? void page.send('Fetch.continueRequest', { requestId: p.requestId })
        : void page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from('{}').toString('base64') }),
    );
    await page.send('Network.setCookie', { name: 'rag_admin', value: cookie, url: `${BASE}/api/t/${SLUG}/`, path: `/api/t/${SLUG}` });
    await page.send('Network.setCookie', { name: 'rag_platform', value: platformCookie, url: `${BASE}/api/platform/`, path: '/api/platform' });
    const audit = async (label) => {
      await page.eval(AXE);
      const violations = JSON.parse(
        await page.eval(`axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }).then(r => JSON.stringify(r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(' ') }))))`),
      );
      audited++;
      for (const v of violations) found.push(`${label} [${scheme}] ${v.id} (${v.impact}, ${v.nodes}): ${v.sample}`);
      console.log(`${violations.length === 0 ? 'clean' : `${violations.length} violation(s)`}  ${label} [${scheme}]`);
    };
    const words = "[...document.querySelectorAll('.activity-what')].some(e => e.textContent.trim())";
    for (const width of [1280, 375]) {
      await page.viewport(width);
      for (const [label, url, ready] of [
        ['activity', `/t/${SLUG}/admin/activity?days=30`, words],
        ['activity members', `/t/${SLUG}/admin/activity?days=30&area=members`, words],
        ['members', `/t/${SLUG}/admin/members`, '.members-activity-link'],
        ['platform', '/platform', `.platform-activity .activity-what`],
      ]) {
        await page.goto(`${BASE}${url}`);
        await page.until(ready.startsWith('[') ? ready : `!!document.querySelector(${JSON.stringify(ready)})`, 60000);
        await sleep(500);
        await audit(`${label} @${width}`);
      }
    }
    browser.close();
    browser = null;
  }
} finally {
  browser?.close();
  for (const id of users) {
    await supabase.from('platform_admins').delete().eq('user_id', id);
    await supabase.auth.admin.deleteUser(id);
  }
  if (users.length) {
    await supabase.from('audit_log').delete().in('actor_user', users);
    await supabase.from('audit_log').delete().in('subject', users);
  }
  // The cleanup's own deletes on service_role are 'system' rows too: swept, counted.
  const swept = await supabase.from('audit_log').delete({ count: 'exact' }).eq('actor_kind', 'system').gte('at', RUN_START).or(`tenant_id.is.null,tenant_id.eq.${tenant.id}`);
  console.log(`swept ${swept.count ?? 0} system row(s) this run wrote`);
}
console.log(`\n${audited} page states audited, ${found.length} violation(s)`);
for (const f of found) console.log(`  ${f}`);
process.exit(found.length === 0 ? 0 : 1);
