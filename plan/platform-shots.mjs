// Screenshots of /platform's tenant list (the index), desktop and phone,
// light and dark, as a throwaway super user; deletes the user at the end.
// Prints the page width (no sideways scroll) and any console error.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/platform-shots.mjs [suffix])
//
// Needs pnpm dev.

import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = 'http://localhost:3000';
const SUFFIX = process.argv[2] ?? 'after';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', 'platform');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let userId;
let browser;
try {
  const email = `platform-shots-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data: u, error: ue } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (ue) throw new Error(ue.message);
  userId = u.user.id;
  const pa = await supabase.from('platform_admins').insert({ user_id: userId });
  if (pa.error) throw new Error(pa.error.message);
  const r = await fetch(`${BASE}/api/platform/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_platform='))?.split(';')[0];
  if (!cookie) throw new Error(`login failed: ${r.status}`);

  for (const scheme of ['light', 'dark']) {
    browser = await openBrowser({ scheme });
    const page = browser.page;
    const errors = [];
    await page.send('Runtime.enable', {});
    page.on('Runtime.consoleAPICalled', (e) => { if (e.type === 'error') errors.push(e.args.map((x) => x.value ?? x.description ?? '').join(' ').slice(0, 300)); });
    page.on('Runtime.exceptionThrown', (e) => errors.push((e.exceptionDetails.exception?.description ?? e.exceptionDetails.text).slice(0, 300)));
    await page.send('Network.setCookie', { name: 'rag_platform', value: cookie.slice('rag_platform='.length), url: `${BASE}/api/platform/`, path: '/api/platform' });
    for (const width of [1280, 390]) {
      await page.viewport(width);
      await page.goto(`${BASE}/platform`);
      await page.until("!!document.querySelector('.member-row, .tenant-card')", 30000);
      await sleep(1000);
      await page.shot(join(OUT, `platform-${SUFFIX}-${scheme}-${width}.png`));
      const w = await page.eval('document.documentElement.scrollWidth');
      console.log(`${scheme} ${width}: page ${w}px wide`);
    }
    // The edit form of one tenant (villa: bookings on): each tab at 1280, Profile at 390 too.
    for (const width of [1280, 390]) {
      await page.viewport(width);
      await page.goto(`${BASE}/platform`);
      await page.until("!!document.querySelector('.tenant-row')", 30000);
      await page.eval("[...document.querySelectorAll('.tenant-row')].find(r => r.textContent.includes('/t/villa')).querySelector('button').click()");
      await page.until("!!document.querySelector('[role=tablist]')", 30000);
      await sleep(800);
      const tabs = width === 1280 ? await page.eval("[...document.querySelectorAll('[role=tab]')].map(t => t.textContent.trim())") : ['Profile'];
      for (const [i, tab] of tabs.entries()) {
        await page.eval(`[...document.querySelectorAll('[role=tab]')][${i}].click()`);
        await sleep(500);
        await page.shot(join(OUT, `tenant-${tab.toLowerCase().replace(/[^a-z]+/g, '-')}-${SUFFIX}-${scheme}-${width}.png`));
      }
      const w = await page.eval('document.documentElement.scrollWidth');
      console.log(`${scheme} form ${width}: page ${w}px wide`);
    }
    console.log(errors.length ? `console errors:\n  ${errors.join('\n  ')}` : `${scheme}: no console errors`);
    browser.close();
    browser = null;
  }
} finally {
  browser?.close();
  if (userId) {
    await supabase.from('platform_admins').delete().eq('user_id', userId);
    await supabase.auth.admin.deleteUser(userId);
  }
}
console.log(`shots in ${OUT}`);
