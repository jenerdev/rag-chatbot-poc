// ui-components-phase4-walk.mjs — search and "Show more" in a real browser,
// against a running dev server (plan/ui-components.md Phase 4).
//
// Unanswered, on harbor's REAL open questions: a word from one narrows the
// list to the rows that have it, the count says so, Escape clears it. Then
// the read answered in the browser with 60 and with 200 made-up questions:
// 25 shown, "Show 25 more", "Show 10 more"; at the route's cap the count
// says "the most recent 200" and a search "of 200 loaded"; a word nobody
// asked gives the "No question matches" state, whose button clears it.
// "Mark resolved" says so in a toast (its PUT caught). The knowledge base:
// no search at 8 documents, a search at 10 that filters on the title.
//
// One throwaway harbor owner, deleted at the end. Nothing is changed: every
// non-GET is caught in the browser; the made-up rows never leave it.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/ui-components-phase4-walk.mjs [base-url])

import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', 'components-4', 'walk');
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// React reads a typed value through the input event, so set it as typing would.
const type = (selector, value) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`;
const rows = "document.querySelectorAll('.unanswered').length";
const count = "document.querySelector('.list-count')?.textContent ?? ''";
const moreButton = "document.querySelector('.list-more button')?.textContent ?? null";

const fakeQuestions = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: 900000 + i,
    question: i === 7 ? 'Pwede po bang magdala ng aso sa Señorita Suite?' : `Walk question number ${i + 1} about parking`,
    askedAt: new Date(Date.UTC(2026, 9, 8, 0, 0) - i * 60000).toISOString(),
    resolvedAt: null,
  }));
const fakeDocuments = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: 800000 + i, title: i === 3 ? 'Pool and beach rules' : `Walk document ${i + 1}`, source: null, created_at: '2026-10-08T00:00:00Z', chunkCount: 2 }));

const { data: harbor } = await supabase.from('tenants').select('id').eq('slug', 'harbor').single();
let userId;
let browser;
try {
  const email = `ui-comp4-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  userId = data.user.id;
  const m = await supabase.from('memberships').insert({ user_id: userId, tenant_id: harbor.id, role: 'owner' });
  if (m.error) throw new Error(m.error.message);
  const r = await fetch(`${BASE}/api/t/harbor/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0]?.slice('rag_admin='.length);
  if (!cookie) throw new Error('login failed');

  browser = await openBrowser({ scheme: 'light' });
  const { page } = browser;
  // fake[pathname] = the JSON the browser gets for that read instead of the server's.
  const fake = {};
  const writes = [];
  const answer = (requestId, body) =>
    page.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(body).toString('base64') });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] });
  page.on('Fetch.requestPaused', (p) => {
    const path = new URL(p.request.url).pathname;
    if (p.request.method !== 'GET') {
      writes.push(`${p.request.method} ${path}`);
      return void answer(p.requestId, '{}');
    }
    if (fake[path]) return void answer(p.requestId, fake[path]);
    void page.send('Fetch.continueRequest', { requestId: p.requestId });
  });
  await page.send('Network.setCookie', { name: 'rag_admin', value: cookie, url: `${BASE}/api/t/harbor/`, path: '/api/t/harbor' });
  await page.viewport(1280);

  // 1. The real open questions: a word from one narrows the list.
  await page.goto(`${BASE}/t/harbor/admin/unanswered`);
  await page.until("!!document.querySelector('.unanswered') || !!document.querySelector('.empty-list')", 30000);
  const real = await page.eval("[...document.querySelectorAll('.unanswered-question')].map(q => q.textContent)");
  if (real.length === 0) check(false, '1. harbor has open questions to search', 'none open');
  else {
    // The longest word of the first question that not every question has.
    const words = real[0].split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3).sort((a, b) => b.length - a.length);
    const word = words.find((w) => !real.every((q) => q.toLowerCase().includes(w.toLowerCase()))) ?? words[0];
    const expected = real.filter((q) => q.toLowerCase().includes(word.toLowerCase())).length;
    await page.eval(type('.list-search input', word));
    await sleep(200);
    const shown = await page.eval("[...document.querySelectorAll('.unanswered-question')].map(q => q.textContent)");
    check(shown.length === expected && shown.every((q) => q.toLowerCase().includes(word.toLowerCase())), `1. "${word}" leaves the ${expected} of ${real.length} questions that have it`, await page.eval(count));
    await page.eval("document.querySelector('.list-search input').focus()");
    await page.key('Escape', 'Escape', 27);
    await sleep(200);
    check((await page.eval(rows)) === real.length && (await page.eval("document.querySelector('.list-search input').value")) === '', '1b. Escape in the field clears it', await page.eval(count));

    // 1c. Mark resolved: the row goes, a toast says where (the PUT caught).
    await page.eval("document.querySelector('.unanswered button').click()");
    await page.until("!!document.querySelector('.toast.ok')", 5000);
    const toast = await page.eval("document.querySelector('.toast.ok')?.textContent ?? ''");
    check(toast.startsWith('Marked resolved') && writes.at(-1)?.startsWith('PUT '), '1c. "Mark resolved" says so in a toast', toast);
  }

  // 2. Sixty questions: 25, then 50, then 60.
  fake['/api/t/harbor/unanswered'] = JSON.stringify(fakeQuestions(60));
  await page.goto(`${BASE}/t/harbor/admin/unanswered`);
  await page.until("document.querySelectorAll('.unanswered').length > 0", 30000);
  check((await page.eval(rows)) === 25 && (await page.eval(moreButton)) === 'Show 25 more', '2. 60 questions: 25 shown, "Show 25 more"', `${await page.eval(rows)} · ${await page.eval(moreButton)}`);
  await page.click('.list-more button');
  await sleep(150);
  check((await page.eval(rows)) === 50 && (await page.eval(moreButton)) === 'Show 10 more', '2b. then 50, "Show 10 more"', `${await page.eval(rows)} · ${await page.eval(moreButton)}`);
  await page.click('.list-more button');
  await sleep(150);
  check((await page.eval(rows)) === 60 && (await page.eval(moreButton)) === null, '2c. then all 60, no button', String(await page.eval(rows)));
  await page.eval(type('.list-search input', 'senorita ASO'));
  await sleep(200);
  check((await page.eval(rows)) === 1 && (await page.eval(count)) === '1 of 60 match', '2d. "senorita ASO" finds "…aso sa Señorita Suite?", accents and case aside', await page.eval(count));

  // 3. At the cap: 200 loaded, and a search says so.
  fake['/api/t/harbor/unanswered'] = JSON.stringify(fakeQuestions(200));
  await page.goto(`${BASE}/t/harbor/admin/unanswered`);
  await page.until("document.querySelectorAll('.unanswered').length > 0", 30000);
  check((await page.eval(count)) === '200 questions, the most recent 200', '3. at the cap the count says "the most recent 200"', await page.eval(count));
  await page.eval(type('.list-search input', 'parking'));
  await sleep(200);
  check((await page.eval(count)) === '199 of 200 loaded match', '3b. a search at the cap says "of 200 loaded"', await page.eval(count));
  await page.eval(type('.list-search input', 'helicopter'));
  await sleep(200);
  const none = await page.eval("document.querySelector('.empty-list strong')?.textContent ?? ''");
  check(none === 'No question matches “helicopter”' && (await page.eval(rows)) === 0, '3c. no match: says so', none);
  await page.shot(join(OUT, 'unanswered-no-match-1280.png'));
  await page.eval("[...document.querySelectorAll('.empty-list button')].find(b => b.textContent === 'Clear search').click()");
  await sleep(200);
  check((await page.eval(rows)) === 25, '3d. "Clear search" brings the list back', String(await page.eval(rows)));
  delete fake['/api/t/harbor/unanswered'];

  // 4. The knowledge base: no search at 8, a search on titles at 10.
  fake['/api/t/harbor/documents'] = JSON.stringify(fakeDocuments(8));
  await page.goto(`${BASE}/t/harbor/admin`);
  await page.until("document.querySelectorAll('.doc').length > 0", 30000);
  check((await page.eval("document.querySelector('.list-search')")) === null, '4. 8 documents: no search');
  fake['/api/t/harbor/documents'] = JSON.stringify(fakeDocuments(10));
  await page.goto(`${BASE}/t/harbor/admin`);
  await page.until("document.querySelectorAll('.doc').length > 0", 30000);
  await page.eval(type('.list-search input', 'beach'));
  await sleep(200);
  const titles = await page.eval("[...document.querySelectorAll('.doc .doc-title')].map(t => t.textContent)");
  check(titles.length === 1 && titles[0].includes('Pool and beach rules'), '4b. 10 documents: a search, "beach" leaves "Pool and beach rules"', titles.join(' | '));
  await page.shot(join(OUT, 'documents-search-1280.png'));
  check(writes.every((w) => w.startsWith('PUT ')), '5. no write left the browser but the one caught PUT', writes.join(', ') || 'none');
} finally {
  browser?.close();
  if (userId) await supabase.auth.admin.deleteUser(userId);
}

console.log(`\n${failures === 0 ? 'all passed' : `${failures} FAILED`}`);
process.exit(failures ? 1 : 0);
