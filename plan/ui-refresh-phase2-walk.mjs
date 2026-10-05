// ui-refresh-phase2-walk.mjs — the navigation in a real browser, against a
// running dev server (plan/ui-refresh.md Phase 2): the staff sidebar by role,
// the phone drawer by keyboard, the slim public header, the chat's height.
// Creates two throwaway users (an OWNER of harbor, a STAFF member of villa),
// deletes them at the end, and screenshots every state into
// plan/ui-refresh/phase2/walk/.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/ui-refresh-phase2-walk.mjs [base-url])

import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', 'phase2', 'walk');
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
  const email = `ui-walk2-${name}-${stamp}@example.com`;
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
  const inSidebar = "!!document.activeElement?.closest('#staff-sidebar')";

  // 1. The owner's sidebar on harbor, desktop.
  await signIn('harbor', ownerCookie);
  await page.viewport(1280);
  await page.goto(`${BASE}/t/harbor/admin/dashboard`);
  await page.until("!!document.querySelector('.staff-sidebar')", 30000);
  await page.shot(join(OUT, 'owner-harbor-dashboard-1280.png'));
  const ownerSections = await page.eval(sections);
  check(
    JSON.stringify(ownerSections) === JSON.stringify(['Overview: Dashboard', 'Content: Knowledge base, Unanswered', 'Bookings: Bookings, Rooms, Holidays, Slots, Promos', 'Team: Members']),
    '1. owner, harbor: four sections in order',
    ownerSections.join(' | '),
  );
  check(await page.eval("document.querySelector('.sidebar-link[aria-current=page]')?.textContent === 'Dashboard'"), '1b. Dashboard is the current page');
  check(await page.eval("document.querySelector('.page-title')?.textContent === 'Dashboard'"), '1c. the page title row');
  check(await page.eval(`${visible('.staff-sidebar')} && !${visible('.staff-topbar')}`), '1d. desktop: the sidebar shows, the phone top bar does not');
  check(await page.eval("[...document.querySelectorAll('.sidebar-footer .sidebar-link')].map(a => a.textContent).join(',') === 'Chat,Book' && document.querySelector('.sidebar-account .badge')?.textContent === 'Owner'"), '1e. footer: Chat, Book, the role');

  // 2. A staff member of villa: fewer links, no Team.
  await signIn('villa', staffCookie);
  await page.goto(`${BASE}/t/villa/admin/bookings`);
  await page.until("!!document.querySelector('.staff-sidebar')", 30000);
  await page.shot(join(OUT, 'staff-villa-bookings-1280.png'));
  const staffSections = await page.eval(sections);
  check(!staffSections.some((s) => s.startsWith('Team')) && !staffSections.join().includes('Promos'), '2. staff, villa: no Team, no Promos', staffSections.join(' | '));
  check(await page.eval("document.querySelector('.sidebar-account .badge')?.textContent === 'Staff'"), '2b. the role says Staff');

  // 3. The phone drawer, by keyboard.
  await signIn('harbor', ownerCookie);
  await page.viewport(375);
  await page.goto(`${BASE}/t/harbor/admin/bookings`);
  await page.until("!!document.querySelector('.staff-topbar')", 30000);
  await page.shot(join(OUT, 'owner-harbor-bookings-375.png'));
  check(await page.eval(`!${visible('.staff-sidebar')} && ${visible('.staff-topbar')}`), '3. phone: the sidebar hidden, the top bar shown');
  await page.click('.staff-topbar button');
  await page.until("document.querySelector('.staff-shell').classList.contains('drawer-open')");
  await new Promise((r) => setTimeout(r, 400)); // the slide
  await page.shot(join(OUT, 'owner-harbor-drawer-375.png'));
  check(await page.eval(inSidebar), '3b. open: focus is inside the drawer', await page.eval("document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent"));
  check(await page.eval("document.querySelector('.staff-main').inert === true && document.querySelector('.staff-topbar button').getAttribute('aria-expanded') === 'true'"), '3c. the page behind is inert; the button says expanded');
  let stayed = true;
  for (let i = 0; i < 16; i++) {
    await page.tab();
    if (!(await page.eval(inSidebar))) stayed = false;
  }
  check(stayed, '3d. 16 Tabs never leave the drawer');
  await page.key('Escape', 'Escape', 27);
  await page.until("!document.querySelector('.staff-shell').classList.contains('drawer-open')");
  check(await page.eval("document.activeElement === document.querySelector('.staff-topbar button')"), '3e. Escape closes it, focus back on the menu button');
  await page.click('.staff-topbar button');
  await page.until("document.querySelector('.staff-shell').classList.contains('drawer-open')");
  await page.click('.sidebar-backdrop');
  check(await page.until("!document.querySelector('.staff-shell').classList.contains('drawer-open')", 3000), '3f. the backdrop closes it');

  // 4. A link in the drawer navigates and closes it.
  await page.click('.staff-topbar button');
  await page.until("document.querySelector('.staff-shell').classList.contains('drawer-open')");
  await page.eval("[...document.querySelectorAll('.sidebar-link')].find(a => a.textContent === 'Holidays').click()");
  check(await page.until("location.pathname.endsWith('/admin/holidays') && document.querySelector('.page-title')?.textContent === 'Holidays' && !document.querySelector('.staff-shell').classList.contains('drawer-open')", 30000), '4. a drawer link goes there, closed');

  // 5. The public chat signed out, phone: one row, no own link, the composer at the bottom.
  await signIn('harbor', null);
  await page.goto(`${BASE}/t/harbor`);
  await page.until("!!document.querySelector('.composer')", 30000);
  await page.shot(join(OUT, 'public-harbor-chat-375.png'));
  const head = await page.eval("Math.round(document.querySelector('header').getBoundingClientRect().height)");
  check(head <= 64, '5. phone header is one row', `${head}px`);
  check(await page.eval("![...document.querySelectorAll('header nav a')].some(a => a.textContent === 'Chat') && [...document.querySelectorAll('header nav a')].some(a => a.textContent === 'Book')"), '5b. no Chat link on the chat; Book there');
  check(await page.eval("document.querySelector('header nav a[href$=\"/admin\"] .narrow-hidden')?.textContent === 'Staff login'"), '5c. Staff login: an icon, its words for screen readers');
  const gap = await page.eval("Math.round(innerHeight - document.querySelector('.composer').getBoundingClientRect().bottom)");
  check(Math.abs(gap) <= 1, '5d. the composer sits on the bottom edge', `${gap}px below it`);

  // 6. The public chat signed in: ONE way to the staff side.
  await signIn('harbor', ownerCookie);
  await page.viewport(1280);
  await page.goto(`${BASE}/t/harbor`);
  await page.until("[...document.querySelectorAll('header nav a')].some(a => a.textContent === 'Dashboard')", 30000);
  await page.shot(join(OUT, 'public-harbor-chat-signed-in-1280.png'));
  const links = await page.eval("[...document.querySelectorAll('header nav a')].map(a => a.textContent).join(', ')");
  check(links === 'Book, Dashboard', '6. signed in on the chat: Book and Dashboard only', links);

  // 7. Log out from the sidebar: back to the login card, the header returns.
  await page.goto(`${BASE}/t/harbor/admin/slots`);
  await page.until("!!document.querySelector('.sidebar-account button')", 30000);
  await page.click('.sidebar-account button');
  check(await page.until("!!document.querySelector('.auth-card') && !document.querySelector('.staff-sidebar') && !!document.querySelector('header')", 10000), '7. Log out: the login card, no sidebar');
  await page.shot(join(OUT, 'logged-out-slots-1280.png'));
} finally {
  browser?.close();
  for (const u of Object.values(users)) {
    const { error } = await supabase.auth.admin.deleteUser(u.id);
    console.log(error ? `cleanup: ${error.message}` : `cleanup: ${u.email} deleted`);
  }
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
