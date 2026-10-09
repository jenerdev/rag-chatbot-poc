// unanswered-bulk-browser-walk.mjs — S-4's checkboxes in a real browser,
// against a running dev server (2026-10-09).
//
// On harbor's REAL open questions, as a throwaway staff member: no bar until a
// row is ticked; two ticked → "2 selected", "Mark 2 resolved", the select-all
// box half-ticked; the click resolves both in ONE request and says so in a
// toast. Then on Resolved, the same two ticked and reopened, so harbor ends
// as it began. "Select all shown" ticks every row on screen and nothing more.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/unanswered-bulk-browser-walk.mjs [base-url])

import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', 'unanswered-bulk');
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = "document.querySelectorAll('.unanswered').length";
const tick = (id) => `document.querySelector('[aria-labelledby=\"unanswered-${id}\"]').click()`;
const idsOnScreen = "[...document.querySelectorAll('.unanswered .unanswered-question')].map(e => Number(e.id.slice('unanswered-'.length)))";
const bulkButton = "document.querySelector('.unanswered-bulk button.primary')?.textContent.trim() ?? null";

const { data: harbor } = await supabase.from('tenants').select('id').eq('slug', 'harbor').single();
let userId;
let browser;
try {
  const email = `unanswered-bulk-ui-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  userId = data.user.id;
  const m = await supabase.from('memberships').insert({ user_id: userId, tenant_id: harbor.id, role: 'staff' });
  if (m.error) throw new Error(m.error.message);
  const r = await fetch(`${BASE}/api/t/harbor/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0]?.slice('rag_admin='.length);
  if (!cookie) throw new Error('login failed');

  browser = await openBrowser({ scheme: 'light' });
  const page = browser.page;
  await page.viewport(1280);
  await page.send('Network.setCookie', { name: 'rag_admin', value: cookie, url: `${BASE}/api/t/harbor/`, path: '/api/t/harbor' });
  await page.goto(`${BASE}/t/harbor/admin/unanswered`);
  await page.until(`${rows} > 1`, 30000);
  await page.eval(`window.__bulk = 0; const f = window.fetch; window.fetch = (u, o) => { if (String(u).endsWith('/unanswered/resolutions')) window.__bulk++; return f(u, o); };`);

  const open = await page.eval(idsOnScreen);
  const two = open.slice(0, 2);
  check((await page.eval(bulkButton)) === null, '1. nothing ticked: no bulk button');
  await page.eval(tick(two[0]));
  await page.eval(tick(two[1]));
  await sleep(200);
  check((await page.eval(bulkButton)) === 'Mark 2 resolved', '2. two ticked: "Mark 2 resolved"', String(await page.eval(bulkButton)));
  check(await page.eval("document.querySelector('.unanswered-bulk input').indeterminate === true"), '2b. select-all is half-ticked');
  check((await page.eval("document.querySelectorAll('.unanswered.selected').length")) === 2, '2c. the two rows are highlighted');
  await page.shot(join(OUT, 'two-selected-1280.png'));

  await page.eval("document.querySelector('.unanswered-bulk button.primary').click()");
  check(await page.until("/Marked 2 questions resolved/.test(document.body.innerText)", 15000), '3. the toast says "Marked 2 questions resolved"');
  const after = await page.eval(idsOnScreen);
  check(two.every((id) => !after.includes(id)) && (await page.eval('window.__bulk')) === 1, '3b. both rows left Open, in ONE request', `requests: ${await page.eval('window.__bulk')}`);
  check((await page.eval(bulkButton)) === null, '3c. the selection is cleared');

  // Select all shown: every row on screen, no more.
  await page.eval("document.querySelector('.unanswered-bulk input').click()");
  await sleep(200);
  const shownCount = await page.eval(rows);
  check((await page.eval(bulkButton)) === `Mark ${shownCount} resolved`, '4. select all shown ticks every row on screen', String(await page.eval(bulkButton)));
  await page.eval("[...document.querySelectorAll('.unanswered-bulk button')].find(b => b.textContent === 'Clear selection').click()");
  await sleep(200);
  check((await page.eval(bulkButton)) === null, '4b. Clear selection unticks them');

  // Reopen the two on Resolved, so harbor ends as it began.
  await page.eval("[...document.querySelectorAll('.segmented button')].find(b => b.textContent.trim() === 'Resolved').click()");
  await page.until(`!!document.querySelector('[aria-labelledby="unanswered-${two[0]}"]')`, 30000);
  await page.eval(tick(two[0]));
  await page.eval(tick(two[1]));
  await sleep(200);
  check((await page.eval(bulkButton)) === 'Reopen 2', '5. on Resolved: "Reopen 2"', String(await page.eval(bulkButton)));
  await page.shot(join(OUT, 'resolved-two-selected-1280.png'));
  await page.eval("document.querySelector('.unanswered-bulk button.primary').click()");
  check(await page.until("/Reopened 2 questions/.test(document.body.innerText)", 15000), '5b. the toast says "Reopened 2 questions"');

  const { data: still } = await supabase.from('unanswered_resolutions').select('message_id').in('message_id', two);
  check(still.length === 0, '6. harbor ends as it began: neither has a resolution', `${still.length} rows`);
} finally {
  browser?.close();
  if (userId) await supabase.auth.admin.deleteUser(userId);
}

console.log(`\n${failures === 0 ? 'all passed' : `${failures} FAILED`}`);
process.exit(failures ? 1 : 0);
