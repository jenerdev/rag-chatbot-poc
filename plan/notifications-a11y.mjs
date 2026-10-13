// notifications-a11y.mjs — axe over what plan/notifications.md § 8 added:
// S-17 Notifications (one unread row and one read row, so both looks are
// audited) and the Dashboard with the sidebar's Notifications badge, as
// villa's owner, light and dark, at 1280 and 375. The same rules and axe
// build as ui-refresh-a11y.mjs; this is the slice for this change.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/notifications-a11y.mjs)
//
// Needs pnpm dev, and axe unpacked as ui-refresh-a11y.mjs says. Two guest
// requests are made (the notifications to show) and deleted at the end,
// with the throwaway owner. Every non-GET request in the browser is caught.
// Screenshots of S-17 go to plan/notifications/inbox-<scheme>-<width>.png.

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

const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', SLUG).single();
const madeEmail = `notifications-a11y-${Date.now()}@example.com`;
let userId;
let browser;
let audited = 0;
const found = [];
try {
  const email = `notifications-a11y-owner-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  userId = data.user.id;
  const m = await supabase.from('memberships').insert({ user_id: userId, tenant_id: tenant.id, role: 'owner' });
  if (m.error) throw new Error(m.error.message);
  const r = await fetch(`${BASE}/api/t/${SLUG}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0];
  if (!cookie) throw new Error('login failed');

  // Two notifications: two guest requests on free nights; the first is then read.
  const { data: slot } = await supabase.from('slots').select('id').eq('tenant_id', tenant.id).eq('active', true).order('id').limit(1).single();
  const { data: unit } = await supabase.from('units').select('id').eq('tenant_id', tenant.id).eq('active', true).order('id').limit(1).single();
  const made = [];
  for (let days = 40; days < 120 && made.length < 2; days += 3) {
    const date = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const q = await fetch(`${BASE}/api/t/${SLUG}/book/quote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slotId: slot.id, rooms: [{ unitId: unit.id, guests: 2 }], checkIn: date, nights: 1 }) });
    if (!q.ok || !(await q.json()).available) continue;
    const req = await fetch(`${BASE}/api/t/${SLUG}/book/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slotId: slot.id, rooms: [{ unitId: unit.id, guests: 2 }], checkIn: date, nights: 1, name: 'A11y Probe', phone: `0918000${String(made.length).padStart(4, '0')}`, email: madeEmail }),
    });
    if (req.status === 201) made.push((await req.json()).reference);
  }
  if (made.length < 2) throw new Error(`made ${made.length} requests, need 2`);
  const feed = await (await fetch(`${BASE}/api/t/${SLUG}/admin/notifications`, { headers: { cookie } })).json();
  const first = feed.items.find((i) => i.reference === made[0]);
  await fetch(`${BASE}/api/t/${SLUG}/admin/notifications`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [first.id] }) });

  for (const scheme of ['light', 'dark']) {
    browser = await openBrowser({ scheme });
    const { page } = browser;
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] });
    page.on('Fetch.requestPaused', (p) =>
      p.request.method === 'GET'
        ? void page.send('Fetch.continueRequest', { requestId: p.requestId })
        : void page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from('{}').toString('base64') }),
    );
    await page.send('Network.setCookie', { name: 'rag_admin', value: cookie.slice('rag_admin='.length), url: `${BASE}/api/t/${SLUG}/`, path: `/api/t/${SLUG}` });
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
      await page.goto(`${BASE}/t/${SLUG}/admin/notifications`);
      await page.until("!!document.querySelector('.notification.unread') && !!document.querySelector('.notification:not(.unread)')", 60000);
      await sleep(400);
      await audit(`notifications @${width}`);
      await page.shot(join(dirname(fileURLToPath(import.meta.url)), 'notifications', `inbox-${scheme}-${width}.png`));
      await page.goto(`${BASE}/t/${SLUG}/admin/dashboard`);
      // The badge is on the top bar's bell at both widths (plan/nav-layout.md).
      await page.until("!!document.querySelector('.topbar-bell .nav-badge')", 60000);
      await sleep(400);
      await audit(`dashboard with the badge @${width}`);
    }
    browser.close();
    browser = null;
  }
} finally {
  browser?.close();
  const { data: rows } = await supabase.from('bookings').select('group_id').eq('tenant_id', tenant.id).eq('guest_email', madeEmail);
  const groups = [...new Set((rows ?? []).map((r) => r.group_id))];
  if (groups.length) {
    await supabase.from('bookings').delete().eq('tenant_id', tenant.id).in('group_id', groups);
    await supabase.from('stays').delete().eq('tenant_id', tenant.id).in('group_id', groups);
  }
  console.log(`cleaned: ${groups.length} stay(s)`);
  if (userId) await supabase.auth.admin.deleteUser(userId);
}
console.log(`\n${audited} page states audited, ${found.length} violation(s)`);
for (const f of found) console.log(`  ${f}`);
process.exit(found.length === 0 && audited === 8 ? 0 : 1);
