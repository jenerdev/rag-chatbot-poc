// page-pending-walk.mjs — the staff frame while a page is on its way (D-149),
// and the server work it no longer repeats, against pnpm dev.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/page-pending-walk.mjs [base])
//
// A throwaway STAFF member of villa logs in; a headless Chrome holds the
// cookie. On Dashboard, the walk clicks Bookings in the sidebar and looks
// at the page in the SAME tick: the title must already read "Bookings", the
// body must be the bones, and the sidebar must still be there (the frame
// stayed; only the content column changed). Then the real page arrives and
// the bones are gone. Then the two 404s that a Next loading boundary would
// have turned into 200s (why this is not one): a per_room page on a
// whole-resort tenant, and an unknown tenant. Deletes everything it made,
// its audit rows too (R-54).

import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const SLUG = 'villa';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'page-pending', 'walk');
const RUN_START = new Date().toISOString();
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', SLUG).single();
if (!tenant) throw new Error(`no tenant ${SLUG}`);
let userId;
let browser;
try {
  // A STAFF member of villa: the lowest role, which has Dashboard and Bookings.
  const email = `page-pending-walk-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data: user, error: userError } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (userError) throw new Error(userError.message);
  userId = user.user.id;
  const m = await supabase.from('memberships').insert({ user_id: userId, tenant_id: tenant.id, role: 'staff' });
  if (m.error) throw new Error(m.error.message);
  const login = await fetch(`${BASE}/api/t/${SLUG}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (login.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0];
  if (!cookie) throw new Error(`login failed: ${login.status}`);

  browser = await openBrowser({ scheme: 'light' });
  const { page: tab } = browser;
  await tab.send('Network.setCookie', { name: 'rag_admin', value: cookie.slice('rag_admin='.length), url: `${BASE}/api/t/${SLUG}/`, path: `/api/t/${SLUG}` });
  await tab.viewport(1280);

  // The pages are compiled once first (dev), so the click below measures the
  // navigation, not webpack.
  await tab.goto(`${BASE}/t/${SLUG}/admin/bookings`);
  await tab.goto(`${BASE}/t/${SLUG}/admin/dashboard`);
  const settled = "!document.querySelector('.page-pending, .staff-skeleton, .page-bones') && document.querySelector('h1.page-title')?.textContent";
  await tab.until(`${settled} === 'Dashboard'`, 30000);

  // 1. The click, and the page in the same tick.
  const state = () =>
    tab.eval(`(() => ({
      title: document.querySelector('h1.page-title')?.textContent ?? '',
      here: document.querySelector('.topbar-here')?.textContent ?? '',
      section: document.querySelector('.topbar-section')?.textContent ?? '',
      pending: !!document.querySelector('.page-pending'),
      bones: !!document.querySelector('.page-pending .page-bones'),
      sidebar: !!document.querySelector('.staff-sidebar .sidebar-link'),
      current: document.querySelector('.staff-sidebar .sidebar-link[aria-current="page"]')?.textContent?.trim() ?? '',
      skeleton: !!document.querySelector('.staff-skeleton'),
      url: location.pathname,
    }))()`);
  const t0 = Date.now();
  await tab.eval("[...document.querySelectorAll('.staff-sidebar a.sidebar-link')].find((a) => a.textContent.trim() === 'Bookings').click()");
  let during = await state();
  // A navigation can be pending for a few ms before React commits the bones; look again within the first second.
  for (let i = 0; i < 10 && !during.pending; i++) {
    await new Promise((r) => setTimeout(r, 50));
    during = await state();
  }
  const tPending = Date.now() - t0;
  await tab.shot(join(OUT, 'pending-light-1280.png'));
  check(
    during.pending && during.bones && during.title === 'Bookings' && during.here === 'Bookings' && during.section === 'Front desk' && during.sidebar && during.current === 'Bookings' && !during.skeleton,
    '1. on the click: the title, the breadcrumb, the sidebar\'s current mark and the bones are the coming page; the sidebar stays',
    `${JSON.stringify(during)} after ${tPending} ms`,
  );

  // 2. The page arrives: the bones go, the list page is Bookings, the URL moved.
  const arrived = await tab.until(`${settled} === 'Bookings' && location.pathname.endsWith('/admin/bookings')`, 60000);
  const after = await state();
  const tArrived = Date.now() - t0;
  await tab.shot(join(OUT, 'arrived-light-1280.png'));
  check(arrived && !after.pending && !after.skeleton && after.url === `/t/${SLUG}/admin/bookings`, '2. then the real page: no bones, no skeleton, the URL moved', `${JSON.stringify(after)} after ${tArrived} ms`);

  // 3. The clicked page's actions are hidden while it is pending, and the
  //    old page's content is gone: nothing of the dashboard stays under the bones.
  await tab.eval("[...document.querySelectorAll('.staff-sidebar a.sidebar-link')].find((a) => a.textContent.trim() === 'Dashboard').click()");
  let back = await state();
  for (let i = 0; i < 10 && !back.pending; i++) {
    await new Promise((r) => setTimeout(r, 50));
    back = await state();
  }
  const leftovers = await tab.eval("!!document.querySelector('.staff-content .list-search, .staff-content .page-actions')");
  check(back.pending && back.title === 'Dashboard' && back.section === 'Overview' && !leftovers, '3. back to Dashboard: the bones again, no search field or actions of the page left behind', JSON.stringify(back));
  await tab.until(`${settled} === 'Dashboard'`, 60000);

  // 4. A page's 404 is still an HTTP 404 (what a loading.tsx would have lost):
  //    Rooms on a whole-resort tenant, and an unknown tenant.
  const rooms = await fetch(`${BASE}/t/${SLUG}/admin/accommodations`, { headers: { cookie } });
  const nope = await fetch(`${BASE}/t/nope-${Date.now()}/admin/bookings`);
  check(rooms.status === 404 && nope.status === 404, '4. /admin/accommodations on villa and an unknown tenant are HTTP 404, not a streamed 200', `${rooms.status} · ${nope.status}`);

  // 5. The pages that exist still answer, signed out too (the login form), with one tenant_public per request now.
  const dash = await fetch(`${BASE}/t/${SLUG}/admin/dashboard`);
  const list = await fetch(`${BASE}/t/${SLUG}/admin/bookings`);
  check(dash.status === 200 && list.status === 200, '5. Dashboard and Bookings are 200', `${dash.status} · ${list.status}`);
} catch (error) {
  check(false, 'walk', error.message);
} finally {
  browser?.close();
  if (userId) {
    const { error } = await supabase.auth.admin.deleteUser(userId);
    if (error) console.log(`WARN  could not delete the walk user: ${error.message}`);
    // Its audit rows (the login, the membership made and removed), and the cleanup's own system rows (R-54).
    const a = await supabase.from('audit_log').delete({ count: 'exact' }).eq('actor_user', userId);
    const b = await supabase.from('audit_log').delete({ count: 'exact' }).eq('subject', userId);
    const swept = await supabase.from('audit_log').delete({ count: 'exact' }).eq('actor_kind', 'system').gte('at', RUN_START).eq('tenant_id', tenant.id);
    console.log(`cleaned audit rows: ${(a.count ?? 0) + (b.count ?? 0)}; swept ${swept.count ?? 0} system row(s)`);
  }
}
console.log(failures === 0 ? '\nALL PAGE PENDING WALK CHECKS PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
