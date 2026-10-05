// ui-refresh-phase8-walk.mjs — the knowledge base and the unanswered
// questions in a real browser, against a running dev server
// (plan/ui-refresh.md Phase 8). Three throwaway users (an admin and a staff
// member of northwind, an admin of harbor), deleted at the end. Screenshots
// into plan/ui-refresh/phase8/walk/.
//
// No document and no resolution changes: every WRITE (POST/PUT/DELETE a
// document, PUT/DELETE a resolution) is caught inside the browser, its body
// recorded, and answered there; reads go to the real server. A document
// write would also have called the embedding model.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/ui-refresh-phase8-walk.mjs [base-url])

import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', 'phase8', 'walk');
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const setText = (selector, value) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`;

const { data: tenants } = await supabase.from('tenants').select('id, slug').in('slug', ['northwind', 'harbor']);
const idOf = Object.fromEntries(tenants.map((t) => [t.slug, t.id]));
const stamp = Date.now();
const users = {};
async function makeUser(name, slug, role) {
  const email = `ui-walk8-${name}-${stamp}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`create ${name}: ${error.message}`);
  users[name] = { id: data.user.id, email, password, slug };
  const { error: e } = await supabase.from('memberships').insert({ user_id: data.user.id, tenant_id: idOf[slug], role });
  if (e) throw new Error(`membership ${name}: ${e.message}`);
}
async function cookieFor(user) {
  const r = await fetch(`${BASE}/api/t/${user.slug}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: user.email, password: user.password }) });
  const c = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0];
  if (!c) throw new Error(`login ${user.slug}: ${r.status}`);
  return c.slice('rag_admin='.length);
}

let browser;
try {
  await makeUser('nwadmin', 'northwind', 'admin');
  await makeUser('nwstaff', 'northwind', 'staff');
  await makeUser('hadmin', 'harbor', 'admin');
  const cookies = Object.fromEntries(await Promise.all(Object.entries(users).map(async ([k, u]) => [k, await cookieFor(u)])));

  for (const scheme of ['light', 'dark']) {
    browser = await openBrowser({ scheme });
    const { page } = browser;
    const loud = scheme === 'light';
    const dir = scheme === 'dark' ? `${OUT}-dark` : OUT;
    const writes = [];
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/documents*' }, { urlPattern: '*/unanswered*' }] });
    page.on('Fetch.requestPaused', (p) => {
      if (p.request.method === 'GET') return void page.send('Fetch.continueRequest', { requestId: p.requestId });
      const body = p.request.postData ? JSON.parse(p.request.postData) : null;
      writes.push({ method: p.request.method, path: new URL(p.request.url).pathname, body });
      const answer = p.request.method === 'POST' || p.request.method === 'PUT' ? { title: body?.title ?? 'Doc', chunkCount: 2 } : {};
      void page.send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify(answer)).toString('base64'),
      });
    });
    const as = async (who, path, width) => {
      const u = users[who];
      await page.send('Network.clearBrowserCookies');
      await page.send('Network.setCookie', { name: 'rag_admin', value: cookies[who], url: `${BASE}/api/t/${u.slug}/`, path: `/api/t/${u.slug}` });
      await page.viewport(width);
      await page.goto(`${BASE}/t/${u.slug}${path}`);
    };

    for (const width of [1280, 375]) {
      const first = loud && width === 1280;
      const shot = (name) => page.shot(join(dir, `${name}-${width}.png`));

      // 1. The knowledge base as an admin: the page action, the rows.
      await as('nwadmin', '/admin', width);
      await page.until("!!document.querySelector('.doc') && !!document.querySelector('.page-actions')", 30000);
      await shot('kb');
      if (first) {
        check(await page.eval("document.querySelector('.page-actions button')?.textContent.trim() === 'Add a document' && ![...document.querySelectorAll('form')].some(f => !f.closest('dialog'))"), '1. "Add a document" is the page action; the form only in the drawer');
        await page.click('.doc-title');
        const opened = await page.until("document.querySelector('.doc-title').getAttribute('aria-expanded') === 'true' && !!document.querySelector('.chunk-text')", 10000);
        check(opened, '1b. the title is a button: it opens the chunks (aria-expanded)');
        check(await page.eval("!/mono|Consolas/i.test(getComputedStyle(document.querySelector('.chunk-text')).fontFamily)"), '1c. the chunks in the reading face');
        check(await page.eval("[...document.querySelectorAll('.doc-head button[aria-label]')].map(b => b.getAttribute('aria-label').split(' ')[0]).join(',').startsWith('Edit,Delete')"), '1d. edit and delete are labelled icons');
        await shot('kb-chunks');
      }

      // 2. Add: the drawer, the count against the limit, a kept draft, one POST.
      await page.click('.page-actions button');
      await page.until("!!document.querySelector('dialog.drawer[open]')", 3000);
      await page.eval(setText('#title', 'Walk Eight Policy'));
      await page.eval(setText('#content', 'Returns are accepted within 30 days.\n\nKeep the receipt.'));
      if (first) {
        check(await page.eval("/ \\/ [\\d,]+ characters/.test(document.querySelector('#content-estimate').textContent)"), '2. the count says the limit', await page.eval("document.querySelector('#content-estimate').textContent"));
        await page.key('Escape', 'Escape', 27);
        await page.until("!document.querySelector('dialog.drawer[open]')", 3000);
        await page.click('.page-actions button');
        await page.until("!!document.querySelector('dialog.drawer[open]')", 3000);
        check(await page.eval("document.querySelector('#title').value === 'Walk Eight Policy'"), '2b. closed and reopened: the new draft is kept');
        const estimate = await page.eval("document.querySelector('#content-estimate').textContent");
        const max = Number(/\/ ([\d,]+) characters/.exec(estimate)[1].replace(/,/g, ''));
        await page.eval(setText('#content', 'x'.repeat(max + 1)));
        check(await page.eval("document.querySelector('#content-estimate').classList.contains('over') && document.querySelector('#content').getAttribute('aria-invalid') === 'true'"), '2c. over the limit: the count turns red, the field says invalid', `${max + 1} characters`);
        await page.eval(setText('#content', 'Returns are accepted within 30 days.\n\nKeep the receipt.'));
      }
      await shot('kb-add');
      await page.click('dialog.drawer button[type=submit]');
      await page.until("!document.querySelector('dialog.drawer[open]') && document.querySelector('.notice.ok')?.textContent.startsWith('Added')", 5000);
      if (first) {
        const w = writes.find((x) => x.method === 'POST');
        check(!!w && w.body?.title === 'Walk Eight Policy', '2d. Add: one POST, the drawer closed, "Added" said', JSON.stringify(w?.body).slice(0, 90));
      }

      if (first) {
        // 3. Edit loads the document into the drawer; closing abandons the edit.
        await page.click('.doc-head button[aria-label^="Edit"]');
        await page.until("!!document.querySelector('dialog.drawer[open]') && document.querySelector('#content').value.length > 0", 10000);
        check(await page.eval("document.querySelector('dialog.drawer h2').textContent.startsWith('Edit “')"), '3. Edit: the drawer, titled with the document, its text loaded');
        await page.key('Escape', 'Escape', 27);
        await page.until("!document.querySelector('dialog.drawer[open]')", 3000);
        check(await page.eval("!document.querySelector('.doc-head button[aria-label^=\"Edit\"]').disabled && document.querySelector('#title').value === ''"), '3b. closed: the edit abandoned, the row free again');

        // 4. Delete asks, naming the document.
        await page.click('.doc-head button[aria-label^="Delete"]');
        await page.until("!!document.querySelector('dialog.dialog[open]')", 3000);
        check(await page.eval("/^Delete “.+”\\?$/.test(document.querySelector('dialog.dialog h2').textContent) && /chunk/.test(document.querySelector('.dialog-body').textContent)"), '4. Delete names the document and its chunks', await page.eval("document.querySelector('dialog.dialog h2').textContent"));
        await shot('kb-delete');
        const before = writes.length;
        await page.eval("[...document.querySelectorAll('dialog.dialog button')].find(b => b.textContent === 'Keep it').click()");
        check(writes.length === before, '4b. "Keep it": nothing sent');
        await page.click('.doc-head button[aria-label^="Delete"]');
        await page.until("!!document.querySelector('dialog.dialog[open]')", 3000);
        await page.click('dialog.dialog button[type=submit]');
        await page.until(`${before + 1} <= 0 || true`);
        await new Promise((r) => setTimeout(r, 500));
        check(writes.length === before + 1 && writes[before].method === 'DELETE', '4c. Delete: one DELETE', JSON.stringify(writes[before]));
      }

      // 5. A staff member reads, and gets no way to write.
      await as('nwstaff', '/admin', width);
      await page.until("!!document.querySelector('.doc')", 30000);
      await shot('kb-staff');
      if (first) check(await page.eval("!document.querySelector('.page-actions') && !document.querySelector('.doc-head button[aria-label]') && /you can read the knowledge base/.test(document.body.innerText)"), '5. staff: no Add, no Edit or Delete, the read-only sentence');

      // 6. Unanswered on harbor: rows, Mark resolved sends one PUT and the row leaves.
      await as('hadmin', '/admin/unanswered', width);
      await page.until("!!document.querySelector('.unanswered') || !!document.querySelector('.empty-list')", 30000);
      await shot('unanswered');
      if (first) {
        check(await page.eval("document.querySelector('.segmented [aria-pressed=true]')?.textContent === 'Open' && /^Asked /.test(document.querySelector('.unanswered-when')?.textContent ?? '')"), '6. Open pressed; each question says when it was asked');
        const rows = await page.eval("document.querySelectorAll('.unanswered').length");
        const before = writes.length;
        await page.click('.unanswered button');
        await page.until(`document.querySelectorAll('.unanswered').length === ${rows - 1}`, 5000);
        check(writes.length === before + 1 && writes[before].method === 'PUT' && writes[before].path.endsWith('/resolution'), '6b. Mark resolved: one PUT, the row leaves the tab', `${rows} → ${rows - 1}`);
      }
      if (loud && width === 375) {
        const wide = await page.eval('document.documentElement.scrollWidth');
        check(wide <= 375, '7. phone: nothing wider than the screen (unanswered)', `${wide}px`);
      }
    }
    if (loud) console.log(`(${writes.length} writes caught in the browser, none sent)`);
    browser.close();
    browser = null;
  }
} finally {
  browser?.close();
  for (const u of Object.values(users)) {
    const { error } = await supabase.auth.admin.deleteUser(u.id);
    console.log(error ? `cleanup: ${error.message}` : `cleanup: ${u.email} deleted`);
  }
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
