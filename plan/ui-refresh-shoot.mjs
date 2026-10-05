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

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';

const LABEL = process.argv[2];
if (!LABEL) throw new Error('usage: ui-refresh-shoot.mjs <phase>/<before|after> [base-url]');
const BASE = process.argv[3] ?? 'http://localhost:3000';
const SCHEME = process.env.SCHEME === 'dark' ? 'dark' : 'light';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', SCHEME === 'dark' ? `${LABEL}-dark` : LABEL);
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
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

const profile = mkdtempSync(join(tmpdir(), 'ui-shoot-'));
let ws;
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${profile}`, '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });

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

  // Wait for Chrome's DevTools endpoint, then open one page target.
  let target;
  for (let i = 0; i < 150 && !target; i++) {
    try {
      target = await (await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' })).json();
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!target) throw new Error('Chrome did not start');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  const waiters = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      for (const w of [...waiters]) if (w.method === msg.method) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
  // A page whose load event never comes (a stuck dev compile) is shot anyway
  // after 20 s, and named, rather than hanging the run.
  const once = (method, what) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => { console.log(`slow: ${what}`); resolve(); }, 20000);
      waiters.push({ method, resolve: (msg) => { clearTimeout(timer); resolve(msg); } });
    });
  await send('Page.enable');
  await send('Network.enable');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: SCHEME }] });

  let shots = 0;
  for (const slug of SLUGS) {
    for (const [name, path, staff] of PAGES) {
      await send('Network.clearBrowserCookies');
      if (staff) await send('Network.setCookie', { name: 'rag_admin', value: cookies[slug], url: `${BASE}/api/t/${slug}/`, path: `/api/t/${slug}` });
      for (const width of WIDTHS) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: width < 600 ? 812 : 900, deviceScaleFactor: 1, mobile: width < 600 });
        const loaded = once('Page.loadEventFired', `${slug}${path || '/'} @${width}`);
        await send('Page.navigate', { url: `${BASE}/t/${slug}${path}` });
        await loaded;
        // Client fetches (session, lists): wait until no "Loading" is left, at most 15 s.
        for (let t = 0; t < 30; t++) {
          await new Promise((r) => setTimeout(r, 500));
          const r = await send('Runtime.evaluate', { expression: "document.body.innerText.includes('Loading') || document.body.innerText.includes('Checking')", returnByValue: true });
          if (t >= 2 && r.result?.result?.value === false) break;
        }
        const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        const dir = join(OUT, slug);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${name}-${width}.png`), Buffer.from(shot.result.data, 'base64'));
        shots++;
      }
    }
  }
  // The platform's login, logged out.
  await send('Network.clearBrowserCookies');
  for (const width of WIDTHS) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 812, deviceScaleFactor: 1, mobile: width < 600 });
    const loaded = once('Page.loadEventFired', `/platform @${width}`);
    await send('Page.navigate', { url: `${BASE}/platform` });
    await loaded;
    await new Promise((r) => setTimeout(r, 1200));
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    mkdirSync(join(OUT, 'platform'), { recursive: true });
    writeFileSync(join(OUT, 'platform', `login-${width}.png`), Buffer.from(shot.result.data, 'base64'));
    shots++;
  }
  console.log(`${shots} screenshots in ${OUT}`);
} finally {
  ws?.close();
  chrome.kill();
  const { error } = await supabase.auth.admin.deleteUser(userId);
  console.log(error ? `cleanup: ${error.message}` : `cleanup: ${email} deleted`);
}
