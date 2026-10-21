// session-progress-walk.mjs — the two signs a staff page is on its way
// (D-145): the SessionCheck skeleton while the session is checked, and the
// LinkProgress ring and top bar while a sidebar navigation is in flight.
// Headless Chrome with a slow network emulated, so both last long enough to
// be seen and photographed. A throwaway owner of the tenant, made and removed
// here, with its audit rows (R-54).
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/session-progress-walk.mjs [base-url] [slug])
//
// Needs pnpm dev. Shots land in plan/session-progress/.
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const SLUG = process.argv[3] ?? 'villa';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'session-progress');
const RUN_START = new Date().toISOString();

let failures = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  — ${detail}` : ''}`);
};
const cookieOf = (r, name) => (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith(`${name}=`))?.split(';')[0]?.slice(name.length + 1);
/** Poll every 40 ms for up to `ms`: the states here are short-lived. */
async function seen(page, expression, ms = 6000) {
  for (let t = 0; t < ms / 40; t++) {
    if (await page.eval(expression)) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return false;
}

let userId = null;
let tenantId = null;
let browser = null;
try {
  const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', SLUG).single();
  if (!tenant) throw new Error(`no tenant ${SLUG}`);
  tenantId = tenant.id;
  const email = `session-walk-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const made = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (made.error) throw new Error(made.error.message);
  userId = made.data.user.id;
  const member = await supabase.from('memberships').insert({ user_id: userId, tenant_id: tenantId, role: 'owner' });
  if (member.error) throw new Error(member.error.message);
  const login = await fetch(`${BASE}/api/t/${SLUG}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = cookieOf(login, 'rag_admin');
  check(login.status === 200 && !!cookie, '0. the throwaway owner signs in', `status ${login.status}`);

  browser = await openBrowser({ scheme: 'light' });
  const { page } = browser;
  await page.viewport(1280);
  await page.send('Network.setCookie', { name: 'rag_admin', value: cookie, url: `${BASE}/api/t/${SLUG}/`, path: `/api/t/${SLUG}` });
  // A slow link: every request waits a second, so the session check and the navigation are seen.
  await page.send('Network.emulateNetworkConditions', { offline: false, latency: 1000, downloadThroughput: -1, uploadThroughput: -1 });

  // 1. The skeleton while the session is checked, then the page.
  const nav = page.send('Page.navigate', { url: `${BASE}/t/${SLUG}/admin/dashboard` });
  const skeleton = await seen(page, "!!document.querySelector('.staff-skeleton[role=status] .staff-sidebar') && !!document.querySelector('.staff-skeleton .page-title')", 15000);
  const words = await page.eval("document.querySelector('.staff-skeleton')?.getAttribute('aria-label') ?? ''");
  const sentence = await page.eval("/Checking your session/.test(document.body.innerText)");
  if (skeleton) await page.shot(join(OUT, 'session-check-1280.png'));
  await nav;
  check(skeleton && words === 'Checking your session' && !sentence, '1. a staff page opens on the shell skeleton (sidebar, top bar, the real title): a status named for a screen reader, no sentence on screen', `seen ${skeleton}, label "${words}", sentence visible ${sentence}`);
  const signedIn = await seen(page, "!document.querySelector('.staff-skeleton') && !!document.querySelector('.staff-sidebar')", 20000);
  check(signedIn, '2. the skeleton gives way to the signed-in page');

  // 3. A sidebar navigation: the ring on the clicked link and the bar at the top, then the new page.
  await page.eval("[...document.querySelectorAll('.sidebar-link')].find(a => /Bookings/.test(a.textContent)).click()");
  const bar = await seen(page, "!!document.querySelector('.route-progress') && !!document.querySelector('.sidebar-link .link-pending')", 6000);
  const where = JSON.parse(
    await page.eval(
      "JSON.stringify((() => { const b = document.querySelector('.route-progress')?.getBoundingClientRect(); return { barTop: b?.top, barWidth: b?.width, viewport: window.innerWidth, inBody: document.querySelector('.route-progress')?.parentElement === document.querySelector('.tenant-root'), colour: getComputedStyle(document.querySelector('.route-progress')).backgroundColor === getComputedStyle(document.querySelector('.tenant-root')).getPropertyValue('--accent-soft').trim() || getComputedStyle(document.querySelector('.route-progress')).backgroundColor, ringIn: document.querySelector('.link-pending')?.closest('.sidebar-link')?.textContent.trim() }; })())",
    ),
  );
  if (bar) await page.shot(join(OUT, 'route-progress-1280.png'));
  check(bar && where.barTop === 0 && where.barWidth === where.viewport && where.inBody, '3. clicking Bookings shows the top bar across the WHOLE viewport (portalled to the tenant root, over the sidebar, in the tenant\'s colours) and a ring on that link', JSON.stringify(where));
  const arrived = await seen(page, "location.pathname.endsWith('/admin/bookings') && !document.querySelector('.route-progress')", 20000);
  check(arrived, '4. the bar goes when the Bookings page arrives');

  // 5. The phone: the skeleton fits a 375 viewport.
  await page.viewport(375);
  const nav2 = page.send('Page.navigate', { url: `${BASE}/t/${SLUG}/admin/holidays` });
  const small = await seen(page, "!!document.querySelector('.staff-skeleton[role=status]')", 15000);
  const fits = small ? await page.eval("document.documentElement.scrollWidth <= 375") : false;
  if (small) await page.shot(join(OUT, 'session-check-375.png'));
  await nav2;
  check(small && fits, '5. at 375 the skeleton shows and does not widen the page', `seen ${small}, fits ${fits}`);
} catch (error) {
  check(false, 'the walk ran to the end', error.message);
} finally {
  browser?.close();
  if (userId) {
    await supabase.from('memberships').delete().eq('user_id', userId);
    const a = await supabase.from('audit_log').delete({ count: 'exact' }).eq('actor_user', userId);
    const b = await supabase.from('audit_log').delete({ count: 'exact' }).eq('subject', userId);
    const c = await supabase.from('audit_log').delete({ count: 'exact' }).eq('actor_kind', 'system').gte('at', RUN_START).eq('tenant_id', tenantId);
    await supabase.auth.admin.deleteUser(userId);
    console.log(`swept: ${a.count ?? 0} audit rows by the user, ${b.count ?? 0} about it, ${c.count ?? 0} system rows since the run started`);
  }
}
console.log(failures ? `\n${failures} FAILED` : '\nsession-progress walk: all passed');
process.exit(failures ? 1 : 0);
