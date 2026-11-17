// Audit S-1 / B-2: the security headers (apps/web/lib/security-headers.mjs),
// measured against a running server. Best against `next start` (the
// production CSP, no 'unsafe-eval'); `pnpm dev` works too.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/security-headers-walk.mjs)
//
// 1. Every header is on a public page, a staff page, the platform, an API
//    route and the service worker; no X-Powered-By.
// 2. No page reports a CSP violation: the public pages of both tenants
//    signed out, and every villa staff screen signed in as a throwaway ADMIN.
// 3. Another origin cannot frame a staff page or the platform: the frame
//    is refused (clickjacking).
//
// The throwaway admin is deleted at the end, with its audit rows (R-54).
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.env.WALK_BASE ?? 'http://localhost:3000';
const SLUG = 'villa';
const RUN_START = new Date().toISOString();
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

// 1. The headers, over HTTP.
const WANT = ['content-security-policy', 'x-frame-options', 'strict-transport-security', 'x-content-type-options', 'referrer-policy', 'permissions-policy'];
for (const path of ['/', `/t/${SLUG}`, `/t/${SLUG}/admin/payments`, '/platform', `/api/t/${SLUG}/admin/session`, `/t/${SLUG}/sw.js`]) {
  const response = await fetch(`${BASE}${path}`, { redirect: 'manual' });
  const missing = WANT.filter((h) => !response.headers.get(h));
  const csp = response.headers.get('content-security-policy') ?? '';
  const ok = missing.length === 0 && !response.headers.get('x-powered-by') && csp.includes("frame-ancestors 'none'");
  check(ok, `1. headers on ${path}`, ok ? `${response.status}` : `missing ${missing.join(', ') || '-'}; x-powered-by ${response.headers.get('x-powered-by')}`);
}

const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', SLUG).single();
if (!tenant) throw new Error(`no tenant ${SLUG}`);
let userId;
let browser;
try {
  browser = await openBrowser({ scheme: 'light' });
  const { page: tab } = browser;
  await tab.viewport(1280);
  // Every violation, as the page itself sees it; read after each page.
  await tab.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));",
  });
  const console_ = [];
  await tab.send('Log.enable');
  tab.on('Log.entryAdded', ({ entry }) => console_.push(entry.text));

  const sweep = async (path, settle) => {
    await tab.goto(`${BASE}${path}`);
    if (settle) await tab.until(settle, 15000);
    await new Promise((r) => setTimeout(r, 800));
    const seen = (await tab.eval('window.__csp')) ?? [];
    return seen;
  };

  // 2a. Public pages, signed out (alteza has room photos on its booking page).
  const publicPages = ['/', `/t/${SLUG}`, `/t/${SLUG}/book`, `/t/${SLUG}/manage`, `/t/${SLUG}/privacy`, '/t/alteza', '/t/alteza/book', '/platform', `/t/${SLUG}/admin/dashboard`];
  for (const path of publicPages) {
    const seen = await sweep(path);
    check(seen.length === 0, `2. no CSP violation on ${path}`, seen.join(' | '));
  }

  // 2b. Every villa staff screen, as an ADMIN.
  const email = `security-headers-walk-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data: user, error: userError } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (userError) throw new Error(userError.message);
  userId = user.user.id;
  const m = await supabase.from('memberships').insert({ user_id: userId, tenant_id: tenant.id, role: 'admin' });
  if (m.error) throw new Error(m.error.message);
  const login = await fetch(`${BASE}/api/t/${SLUG}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (login.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0];
  if (!cookie) throw new Error(`login failed: ${login.status}`);
  await tab.send('Network.setCookie', { name: 'rag_admin', value: cookie.slice('rag_admin='.length), url: `${BASE}/api/t/${SLUG}/`, path: `/api/t/${SLUG}` });

  const staffPages = ['dashboard', 'bookings', 'calendar', 'payments', 'conversations', 'unanswered', 'documents', 'holidays', 'slots', 'promos', 'notifications', 'members'];
  const signedIn = "!!document.querySelector('h1.page-title') && !document.querySelector('.page-pending, .staff-skeleton, .page-bones')";
  for (const page of staffPages) {
    const seen = await sweep(`/t/${SLUG}/admin/${page}`, signedIn);
    const title = await tab.eval("document.querySelector('h1.page-title')?.textContent ?? ''");
    check(seen.length === 0 && title !== '', `2. no CSP violation on admin/${page} (signed in)`, seen.length ? seen.join(' | ') : title);
  }

  // 3. Clickjacking: a page on another origin, with no CSP of its own (a
  // server of this walk's, on another port), frames a staff page and the platform.
  const attacker = createServer((_, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>decoy</title>'));
  await new Promise((r) => attacker.listen(0, '127.0.0.1', r));
  const OTHER = `http://127.0.0.1:${attacker.address().port}`;
  for (const path of [`/t/${SLUG}/admin/bookings`, '/platform']) {
    console_.length = 0;
    await tab.goto(`${OTHER}/`);
    await tab.eval(`new Promise((resolve) => { const f = document.createElement('iframe'); f.src = '${BASE}${path}'; f.onload = resolve; document.body.append(f); setTimeout(resolve, 5000); })`);
    await new Promise((r) => setTimeout(r, 500));
    const refused = console_.some((text) => /frame-ancestors|X-Frame-Options/i.test(text));
    check(refused, `3. another origin cannot frame ${path}`, console_.find((t) => /frame/i.test(t))?.slice(0, 140) ?? 'no refusal logged');
  }
  attacker.close();
} catch (error) {
  check(false, 'walk', error.message);
} finally {
  browser?.close();
  if (userId) {
    const { error } = await supabase.auth.admin.deleteUser(userId);
    if (error) console.log(`WARN  could not delete the walk user: ${error.message}`);
    const a = await supabase.from('audit_log').delete({ count: 'exact' }).eq('actor_user', userId);
    const b = await supabase.from('audit_log').delete({ count: 'exact' }).eq('subject', userId);
    const swept = await supabase.from('audit_log').delete({ count: 'exact' }).eq('actor_kind', 'system').gte('at', RUN_START).eq('tenant_id', tenant.id);
    console.log(`cleaned audit rows: ${(a.count ?? 0) + (b.count ?? 0)}; swept ${swept.count ?? 0} system row(s)`);
  }
}
console.log(failures === 0 ? '\nALL SECURITY HEADERS WALK CHECKS PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
