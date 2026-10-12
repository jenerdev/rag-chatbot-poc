// Screenshots of four staff setup screens on harbor, desktop and phone:
// Rooms (S-5), Holidays (S-7), Slots (S-9) and Promos (S-10), each as it
// loads and with its "Add" drawer open. Changes nothing: the drawers are
// opened and closed, never saved. Prints the page width and any console
// error.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/setup-pages-shots.mjs [slug])
//
// Needs pnpm dev.

import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = 'http://localhost:3000';
const SLUG = process.argv[2] ?? 'harbor';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', 'setup-pages');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', SLUG).single();
let userId;
let browser;
try {
  const email = `setup-shots-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data: u, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  userId = u.user.id;
  await supabase.from('memberships').insert({ user_id: userId, tenant_id: tenant.id, role: 'admin' });
  const r = await fetch(`${BASE}/api/t/${SLUG}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0];
  if (!cookie) throw new Error('login failed');

  browser = await openBrowser({ scheme: 'light' });
  const page = browser.page;
  const errors = [];
  await page.send('Runtime.enable', {});
  page.on('Runtime.consoleAPICalled', (e) => { if (e.type === 'error') errors.push(e.args.map((x) => x.value ?? x.description ?? '').join(' ').slice(0, 300)); });
  page.on('Runtime.exceptionThrown', (e) => errors.push((e.exceptionDetails.exception?.description ?? e.exceptionDetails.text).slice(0, 300)));
  await page.send('Network.setCookie', { name: 'rag_admin', value: cookie.slice('rag_admin='.length), url: `${BASE}/api/t/${SLUG}/`, path: `/api/t/${SLUG}` });

  for (const width of [1280, 390]) {
    await page.viewport(width);
    for (const name of ['accommodations', 'holidays', 'slots', 'promos']) {
      await page.goto(`${BASE}/t/${SLUG}/admin/${name}`);
      const ready = await page.until("!!document.querySelector('.page-actions button')", 45000);
      if (!ready) {
        console.log(`${name} ${width}: the Add button never appeared`);
        continue;
      }
      await sleep(1000);
      await page.shot(join(OUT, `${name}-${width}.png`));
      const wide = await page.eval('document.documentElement.scrollWidth');
      await page.eval("document.querySelector('.page-actions button').click()");
      await page.until("!!document.querySelector('dialog.drawer[open]')", 10000);
      await sleep(500);
      await page.shot(join(OUT, `${name}-drawer-${width}.png`));
      console.log(`${name} ${width}: page ${wide}px wide`);
    }
  }
  console.log(errors.length ? `console errors:\n  ${errors.join('\n  ')}` : 'no console errors');
} finally {
  browser?.close();
  if (userId) await supabase.auth.admin.deleteUser(userId);
}
console.log(`shots in ${OUT}`);
