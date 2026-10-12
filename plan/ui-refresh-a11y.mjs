// ui-refresh-a11y.mjs — an automated accessibility audit of every screen
// (plan/ui-refresh.md Phase 10), with axe-core in a real browser, light and
// dark, at 1280 and 375 px: the public pages, every staff page as an owner,
// the platform, and the two modal states (a drawer and a dialog open).
//
// axe-core is NOT a dependency: unpack it into the git-ignored folder first,
//   (cd plan/ui-refresh && npm pack axe-core && tar -xzf axe-core-*.tgz && mv package axe)
// then
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/ui-refresh-a11y.mjs [base-url])
//
// Rules: WCAG 2.0/2.1 A and AA, and axe's best practices. Every non-GET
// request is caught in the browser, so nothing is changed. Two throwaway
// users (an owner of all three tenants; a super user), deleted at the end.

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const HERE = dirname(fileURLToPath(import.meta.url));
const AXE = readFileSync(join(HERE, 'ui-refresh', 'axe', 'axe.min.js'), 'utf8');
const SLUGS = ['villa', 'harbor', 'northwind'];
const STAFF = ['/admin/dashboard', '/admin/documents', '/admin/unanswered', '/admin/conversations', '/admin/bookings', '/admin/calendar', '/admin/calendar?view=week', '/admin/calendar?view=day', '/admin/accommodations', '/admin/holidays', '/admin/slots', '/admin/promos', '/admin/members'];

const { data: tenants } = await supabase.from('tenants').select('id, slug').in('slug', SLUGS);
const stamp = Date.now();
const made = [];
async function makeUser(name) {
  const email = `ui-a11y-${name}-${stamp}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  made.push(data.user.id);
  return { id: data.user.id, email, password };
}
const cookieOf = (r, name) => (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith(`${name}=`))?.split(';')[0]?.slice(name.length + 1);

// violation id → { impact, help, pages: Set, nodes, sample }
const found = new Map();
let audited = 0;
let browser;
try {
  const owner = await makeUser('owner');
  const sup = await makeUser('super');
  for (const t of tenants) await supabase.from('memberships').insert({ user_id: owner.id, tenant_id: t.id, role: 'owner' });
  await supabase.from('platform_admins').insert({ user_id: sup.id });
  const cookies = {};
  for (const slug of SLUGS) cookies[slug] = cookieOf(await fetch(`${BASE}/api/t/${slug}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: owner.email, password: owner.password }) }), 'rag_admin');
  const platformCookie = cookieOf(await fetch(`${BASE}/api/platform/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: sup.email, password: sup.password }) }), 'rag_platform');

  for (const scheme of ['light', 'dark']) {
    browser = await openBrowser({ scheme });
    const { page } = browser;
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] });
    page.on('Fetch.requestPaused', (p) =>
      p.request.method === 'GET'
        ? void page.send('Fetch.continueRequest', { requestId: p.requestId })
        : void page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from('{}').toString('base64') }),
    );
    const audit = async (label) => {
      await page.eval(AXE);
      const result = JSON.parse(
        await page.eval(`axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }).then(r => JSON.stringify(r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.map(n => n.target.join(' ')), sample: v.nodes[0]?.target?.join(' ') + ' :: ' + (v.nodes[0]?.failureSummary ?? '').split('\\n').slice(1, 2).join('') }))))`),
      );
      audited++;
      for (const v of result) {
        const key = v.id;
        const entry = found.get(key) ?? { impact: v.impact, help: v.help, pages: new Set(), targets: new Set(), nodes: 0, sample: v.sample };
        for (const t of v.targets) entry.targets.add(t);
        entry.pages.add(`${label} [${scheme}]`);
        entry.nodes += v.nodes;
        found.set(key, entry);
      }
    };
    const open = async (url, ready, label) => {
      await page.goto(url);
      await page.until(ready, 30000);
      await new Promise((r) => setTimeout(r, 400));
      await audit(label);
    };

    for (const width of [1280, 375]) {
      await page.viewport(width);
      for (const slug of SLUGS) {
        await page.send('Network.clearBrowserCookies');
        await open(`${BASE}/t/${slug}`, "!!document.querySelector('.composer')", `${slug} chat @${width}`);
        await open(`${BASE}/t/${slug}/book`, 'true', `${slug} book @${width}`);
        await open(`${BASE}/t/${slug}/admin`, "!!document.querySelector('.auth-card')", `${slug} login @${width}`);
        await page.send('Network.setCookie', { name: 'rag_admin', value: cookies[slug], url: `${BASE}/api/t/${slug}/`, path: `/api/t/${slug}` });
        for (const path of STAFF) await open(`${BASE}/t/${slug}${path}`, "!!document.querySelector('.staff-sidebar') || !!document.querySelector('main h1, main h2')", `${slug} ${path} @${width}`);
      }
      // S-16a (D-115): one transcript, the newest of harbor's chats (90 days).
      await page.send('Network.setCookie', { name: 'rag_admin', value: cookies.harbor, url: `${BASE}/api/t/harbor/`, path: '/api/t/harbor' });
      await page.goto(`${BASE}/t/harbor/admin/conversations?days=90`);
      if (await page.until("!!document.querySelector('.conversation-row-link')", 30000)) {
        await page.click('.conversation-row-link');
        await page.until("!!document.querySelector('.transcript')", 30000);
        await new Promise((r) => setTimeout(r, 400));
        await audit(`harbor transcript @${width}`);
      }
      // The modal states: a drawer (New booking) and a dialog (Decline), as harbor's owner.
      await page.send('Network.setCookie', { name: 'rag_admin', value: cookies.harbor, url: `${BASE}/api/t/harbor/`, path: '/api/t/harbor' });
      await page.goto(`${BASE}/t/harbor/admin/bookings`);
      await page.until("!!document.querySelector('.page-actions button')", 30000);
      await page.click('.page-actions button');
      await page.until("!!document.querySelector('dialog.drawer[open]')", 5000);
      await new Promise((r) => setTimeout(r, 400));
      await audit(`harbor bookings, drawer open @${width}`);
      await page.key('Escape', 'Escape', 27);
      await page.eval("[...document.querySelectorAll('.booking-actions button')].find(b => b.textContent === 'Decline' || b.textContent === 'Cancel')?.click()");
      if (await page.until("!!document.querySelector('dialog.dialog[open]')", 5000)) {
        await new Promise((r) => setTimeout(r, 400));
        await audit(`harbor bookings, dialog open @${width}`);
        await page.key('Escape', 'Escape', 27);
      }
      // The platform.
      await page.send('Network.setCookie', { name: 'rag_platform', value: platformCookie, url: `${BASE}/api/platform/`, path: '/api/platform' });
      await open(`${BASE}/platform`, "!!document.querySelector('.tenant-row')", `platform list @${width}`);
      await page.eval("[...document.querySelectorAll('.tenant-row')].find(r => r.textContent.includes('/t/harbor')).querySelector('button').click()");
      await page.until("!!document.querySelector('#theme-accent')", 15000);
      await new Promise((r) => setTimeout(r, 600));
      await audit(`platform tenant form @${width}`);
    }
    browser.close();
    browser = null;
  }
} finally {
  browser?.close();
  for (const id of made) {
    await supabase.from('platform_admins').delete().eq('user_id', id);
    await supabase.auth.admin.deleteUser(id);
  }
}

const order = { critical: 0, serious: 1, moderate: 2, minor: 3 };
const rows = [...found.entries()].sort((a, b) => (order[a[1].impact] ?? 9) - (order[b[1].impact] ?? 9));
console.log(`${audited} page states audited; ${rows.length} distinct violation(s)\n`);
for (const [id, v] of rows) {
  console.log(`${v.impact.toUpperCase().padEnd(9)} ${id} — ${v.help}`);
  console.log(`          ${v.nodes} node(s) on ${v.pages.size} page state(s), e.g. ${[...v.pages].slice(0, 3).join('; ')}`);
  console.log(`          ${v.sample}`);
}
writeFileSync(join(HERE, 'ui-refresh', 'a11y-report.json'), JSON.stringify(rows.map(([id, v]) => ({ id, ...v, pages: [...v.pages], targets: [...v.targets] })), null, 2));
process.exit(rows.some(([, v]) => v.impact === 'critical' || v.impact === 'serious') ? 1 : 0);
