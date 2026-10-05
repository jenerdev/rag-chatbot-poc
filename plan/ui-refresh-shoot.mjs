// ui-refresh-shoot.mjs — screenshots of every screen at 375 and 1280 px, for
// plan/ui-refresh.md Rule 4 (before and after each phase), against a running
// `pnpm dev`. Creates one throwaway OWNER of villa, harbor and northwind,
// logs it in to each, drives headless Chrome over the DevTools protocol with
// that cookie, and deletes the user at the end. No dependency: Node's own
// WebSocket and fetch.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/ui-refresh-shoot.mjs <phase>/<before|after> [base-url])
//
// SCHEME=dark emulates a system in dark mode, into <phase>/<label>-dark/.

import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const LABEL = process.argv[2];
if (!LABEL) throw new Error('usage: ui-refresh-shoot.mjs <phase>/<before|after> [base-url]');
const BASE = process.argv[3] ?? 'http://localhost:3000';
const SCHEME = process.env.SCHEME === 'dark' ? 'dark' : 'light';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', SCHEME === 'dark' ? `${LABEL}-dark` : LABEL);
const WIDTHS = [375, 1280];
const SLUGS = ['villa', 'harbor', 'northwind'];
// Each page, logged out (public) or as the owner (staff). A page a tenant
// does not have is a 404 screenshot, which is fine: it shows the 404 too.
const PAGES = [
  ['chat', '', false],
  ['book', '/book', false],
  ['login', '/admin', false],
  ['dashboard', '/admin/dashboard', true],
  ['documents', '/admin', true],
  ['unanswered', '/admin/unanswered', true],
  ['bookings', '/admin/bookings', true],
  ['rooms', '/admin/accommodations', true],
  ['holidays', '/admin/holidays', true],
  ['slots', '/admin/slots', true],
  ['promos', '/admin/promos', true],
  ['members', '/admin/members', true],
];

const { data: tenants } = await supabase.from('tenants').select('id, slug').in('slug', SLUGS);
const idOf = Object.fromEntries(tenants.map((t) => [t.slug, t.id]));
const email = `ui-shoot-${Date.now()}@example.com`;
const password = randomBytes(18).toString('base64url');
const { data: created, error: createError } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
if (createError) throw new Error(`create: ${createError.message}`);
const userId = created.user.id;

let browser;
try {
  for (const slug of SLUGS) {
    const { error } = await supabase.from('memberships').insert({ user_id: userId, tenant_id: idOf[slug], role: 'owner' });
    if (error) throw new Error(`membership ${slug}: ${error.message}`);
  }
  const cookies = {};
  for (const slug of SLUGS) {
    const r = await fetch(`${BASE}/api/t/${slug}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const c = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0];
    if (!c) throw new Error(`login ${slug}: ${r.status}`);
    cookies[slug] = c.slice('rag_admin='.length);
  }

  browser = await openBrowser({ scheme: SCHEME });
  const { page } = browser;
  let shots = 0;
  for (const slug of SLUGS) {
    for (const [name, path, staff] of PAGES) {
      await page.send('Network.clearBrowserCookies');
      if (staff) await page.send('Network.setCookie', { name: 'rag_admin', value: cookies[slug], url: `${BASE}/api/t/${slug}/`, path: `/api/t/${slug}` });
      for (const width of WIDTHS) {
        await page.viewport(width);
        await page.goto(`${BASE}/t/${slug}${path}`);
        await page.shot(join(OUT, slug, `${name}-${width}.png`));
        shots++;
      }
    }
  }
  // The platform's login, logged out.
  await page.send('Network.clearBrowserCookies');
  for (const width of WIDTHS) {
    await page.viewport(width);
    await page.goto(`${BASE}/platform`);
    await page.shot(join(OUT, 'platform', `login-${width}.png`));
    shots++;
  }
  console.log(`${shots} screenshots in ${OUT}`);
} finally {
  browser?.close();
  const { error } = await supabase.auth.admin.deleteUser(userId);
  console.log(error ? `cleanup: ${error.message}` : `cleanup: ${email} deleted`);
}
