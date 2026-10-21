// nav-layout-walk.mjs — the staff navigation after plan/nav-layout.md, in a
// real browser against pnpm dev: the sidebar's four sections by role, the top
// bar on every width (breadcrumb, bell, account menu), the account menu by
// keyboard and pointer, the phone drawer, and Log out from the menu.
// Replaces ui-refresh-phase2-walk.mjs's sidebar checks (its footer is gone).
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/nav-layout-walk.mjs [base-url])
//
// Two throwaway users (an OWNER of harbor, a STAFF member of villa), deleted
// at the end.

import { randomBytes } from 'node:crypto';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

const { data: tenants } = await supabase.from('tenants').select('id, slug').in('slug', ['villa', 'harbor']);
const idOf = Object.fromEntries(tenants.map((t) => [t.slug, t.id]));
const stamp = Date.now();
const users = {};
async function makeUser(name, slug, role) {
  const email = `nav-walk-${name}-${stamp}@example.com`;
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
  await makeUser('staffer', 'villa', 'staff');
  const ownerCookie = await cookieFor('harbor', users.owner);
  const staffCookie = await cookieFor('villa', users.staffer);

  browser = await openBrowser();
  const { page } = browser;
  const signIn = async (slug, value) => {
    await page.send('Network.clearBrowserCookies');
    if (value) await page.send('Network.setCookie', { name: 'rag_admin', value, url: `${BASE}/api/t/${slug}/`, path: `/api/t/${slug}` });
  };
  const visible = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const s = getComputedStyle(e); const r = e.getBoundingClientRect(); return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.right > 0; })()`;
  const sections = "[...document.querySelectorAll('.sidebar-group')].map(g => g.querySelector('.sidebar-group-label').textContent + ': ' + [...g.querySelectorAll('.sidebar-link')].map(a => a.textContent).join(', '))";
  const panelOpen = "!document.querySelector('.account-panel').hidden";

  // 1. The owner on harbor, desktop: four sections, the daily work first.
  await signIn('harbor', ownerCookie);
  await page.viewport(1280);
  await page.goto(`${BASE}/t/harbor/admin/bookings`);
  await page.until("!!document.querySelector('.staff-sidebar') && !!document.querySelector('.account-button')", 30000);
  const ownerSections = await page.eval(sections);
  check(
    JSON.stringify(ownerSections) === JSON.stringify(['Overview: Dashboard', 'Front desk: Bookings, Calendar, Payments', 'Assistant: Conversations, Unanswered, Knowledge base', 'Setup: Rooms, Slots, Holidays, Promos, Members']),
    '1. owner: Overview · Front desk · Assistant · Setup',
    ownerSections.join(' | '),
  );
  check(await page.eval("!document.querySelector('.sidebar-footer') && ![...document.querySelectorAll('.sidebar-link')].some(a => /Notifications|Chat|Book$/.test(a.textContent))"), '1b. the sidebar is navigation only: no footer, no Notifications, Chat or Book in it');
  const crumbs = await page.eval("document.querySelector('.topbar-crumbs').textContent");
  check(await page.eval(`${visible('.staff-topbar')} && ${visible('.topbar-crumbs')} && !${visible('.topbar-menu')}`) && crumbs === 'Front deskBookings', '1c. desktop: a top bar with the breadcrumb, no menu button', crumbs);
  const edges = await page.eval("({ crumb: Math.round(document.querySelector('.topbar-crumbs').getBoundingClientRect().left), title: Math.round(document.querySelector('.page-title').getBoundingClientRect().left) })");
  check(edges.crumb === edges.title, '1d. the breadcrumb lines up with the page title', JSON.stringify(edges));
  check(await page.eval("document.querySelector('.topbar-bell')?.getAttribute('href') === '/t/harbor/admin/notifications' && /^Notifications/.test(document.querySelector('.topbar-bell').getAttribute('aria-label'))"), '1e. the bell links to Notifications and is named');

  // 2. The account menu, by keyboard and pointer.
  check(await page.eval(`!(${panelOpen}) && document.querySelector('.account-button').getAttribute('aria-expanded') === 'false'`), '2. closed on load');
  await page.click('.account-button');
  const panel = await page.eval("({ open: !document.querySelector('.account-panel').hidden, expanded: document.querySelector('.account-button').getAttribute('aria-expanded'), role: document.querySelector('.account-panel .badge')?.textContent, links: [...document.querySelectorAll('.account-panel a')].map(a => a.textContent.replace(' (opens in a new tab)', '') + ' ' + a.getAttribute('href')), sound: !!document.querySelector('.account-panel .sound-toggle'), logout: [...document.querySelectorAll('.account-panel button')].some(b => b.textContent === 'Log out') })");
  check(
    panel.open && panel.expanded === 'true' && panel.role === 'Owner' && panel.links.join(',') === 'Chat page /t/harbor,Booking page /t/harbor/book,Manage booking /t/harbor/manage' && panel.sound && panel.logout,
    '2b. open: the role, the guest pages, this device, Log out',
    JSON.stringify(panel),
  );
  await page.key('Escape', 'Escape', 27);
  check(await page.eval(`!(${panelOpen}) && document.activeElement === document.querySelector('.account-button')`), '2c. Escape closes it, focus back on the button');
  // A REAL press outside (the harness's click() is element.click(), which fires no pointerdown).
  await page.click('.account-button');
  const at = await page.eval("(() => { const r = document.querySelector('.page-title').getBoundingClientRect(); return { x: r.x + 10, y: r.y + r.height / 2 }; })()");
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  check(await page.eval(`!(${panelOpen})`), '2d. a press outside closes it');
  await page.click('.account-button');
  await page.eval("document.querySelector('.sidebar-link').focus(); true");
  check(await page.eval(`!(${panelOpen})`), '2e. focus moving out of it (Tab away) closes it');

  // 3. The staff member on villa: no Setup, Payments read-only still listed.
  await signIn('villa', staffCookie);
  await page.goto(`${BASE}/t/villa/admin/conversations`);
  await page.until("!!document.querySelector('.staff-sidebar') && !!document.querySelector('.account-button')", 30000);
  const staffSections = await page.eval(sections);
  check(
    JSON.stringify(staffSections) === JSON.stringify(['Overview: Dashboard', 'Front desk: Bookings, Calendar, Payments', 'Assistant: Conversations, Unanswered, Knowledge base']),
    '3. staff: no Setup section',
    staffSections.join(' | '),
  );
  check((await page.eval("document.querySelector('.topbar-crumbs').textContent")) === 'AssistantConversations', '3b. the breadcrumb follows the page', await page.eval("document.querySelector('.topbar-crumbs').textContent"));
  check((await page.eval("document.querySelector('.account-role').textContent")) === 'Staff', '3c. the account button says Staff');

  // 4. The phone: the top bar keeps the bell and the account; the drawer holds the sections.
  await signIn('harbor', ownerCookie);
  await page.viewport(375);
  await page.goto(`${BASE}/t/harbor/admin/bookings`);
  await page.until("!!document.querySelector('.account-button')", 30000);
  check(await page.eval(`!${visible('.staff-sidebar')} && ${visible('.topbar-menu')} && ${visible('.topbar-bell')} && ${visible('.account-button')} && !${visible('.topbar-crumbs')}`), '4. phone: menu, business, bell and account in the top bar; no breadcrumb');
  await page.click('.topbar-menu');
  await page.until("document.querySelector('.staff-shell').classList.contains('drawer-open')");
  await new Promise((r) => setTimeout(r, 400));
  check(await page.eval("!!document.activeElement?.closest('#staff-sidebar') && document.querySelector('.staff-main').inert === true"), '4b. the drawer takes focus, the page behind is inert');
  const drawerBottom = await page.eval("Math.round([...document.querySelectorAll('.sidebar-link')].pop().getBoundingClientRect().bottom)");
  check(drawerBottom <= 812, '4c. every link fits in a 375 × 812 drawer without scrolling', `last link ends at ${drawerBottom}px`);
  await page.key('Escape', 'Escape', 27);
  check(await page.until("!document.querySelector('.staff-shell').classList.contains('drawer-open') && document.activeElement === document.querySelector('.topbar-menu')", 3000), '4d. Escape closes it, focus back on the menu button');
  await page.click('.account-button');
  const box = await page.eval("(() => { const r = document.querySelector('.account-panel').getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right) }; })()");
  check(box.left >= 0 && box.right <= 375, '4e. the account panel fits the phone screen', JSON.stringify(box));

  // 5. Log out from the account menu: the login card, no sidebar.
  await page.viewport(1280);
  await page.goto(`${BASE}/t/harbor/admin/slots`);
  await page.until("!!document.querySelector('.account-button')", 30000);
  await page.click('.account-button');
  await page.eval("[...document.querySelectorAll('.account-panel button')].find(b => b.textContent === 'Log out').click(); true");
  check(await page.until("!!document.querySelector('.auth-card') && !document.querySelector('.staff-sidebar') && !document.querySelector('.staff-topbar')", 10000), '5. Log out: the login card, no sidebar, no top bar');
} finally {
  browser?.close();
  for (const u of Object.values(users)) await supabase.auth.admin.deleteUser(u.id);
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
