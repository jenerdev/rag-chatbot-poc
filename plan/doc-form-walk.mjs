// The knowledge base's "Add a document" drawer in a browser, against pnpm dev
// (villa): the footer says what is missing and Add waits for it; "Load a
// text file" fills Content (and an empty Title and Source) from a .md file,
// read in the browser; "How it will be split" lists the chunks chunkText()
// makes; saving embeds the document and the server's chunk count equals the
// preview's. The document is deleted at the end, so villa ends as it began
// (rule 1's corpus). One embeddings call.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/doc-form-walk.mjs)

import { randomBytes } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const SLUG = 'villa';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'ui-refresh', 'doc-form');
// A real document of villa's, under another name so it cannot be mistaken for the corpus copy.
const FILE = resolve(HERE, '..', 'sample-documents', '06-directions-and-getting-there.md');
const TITLE = 'Walk probe: directions';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const footer = "document.querySelector('dialog.drawer[open] .drawer-footer-total')?.innerText.trim()";
const addDisabled = "document.querySelector('dialog.drawer[open] button[type=submit]')?.disabled";
const setValue = (sel, value) =>
  `(() => { const el = document.querySelector(${JSON.stringify(sel)}); const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`;

const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', SLUG).single();
let userId;
let browser;
try {
  const email = `doc-form-${Date.now()}@example.com`;
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
  await page.viewport(1280);
  await page.send('Network.setCookie', { name: 'rag_admin', value: cookie.slice('rag_admin='.length), url: `${BASE}/api/t/${SLUG}/`, path: `/api/t/${SLUG}` });
  await page.goto(`${BASE}/t/${SLUG}/admin/documents`);
  await page.until("[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Add a document')", 30000);
  await page.eval("[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add a document').click()");
  await page.until("!!document.querySelector('dialog.drawer[open] .doc-form')", 10000);
  await sleep(300);

  // 1. Empty: Add waits, and the footer says for what.
  check((await page.eval(addDisabled)) === true && (await page.eval(footer)) === 'Add a title', '1. empty: "Add a title", Add disabled', await page.eval(footer));
  await page.shot(join(OUT, 'empty-1280.png'));

  // 2. Load a text file: Content, Title and Source filled from the file.
  const doc = await page.send('DOM.getDocument', { depth: -1 });
  const { result: node } = await page.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'dialog.drawer[open] .file-pick input[type=file]' });
  await page.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [FILE] });
  const filled = await page.until("(document.querySelector('#content')?.value ?? '').length > 500", 5000);
  const got = await page.eval("({ title: document.querySelector('#title').value, source: document.querySelector('#source').value })");
  check(filled && got.title.length > 0 && got.source.endsWith('.md'), '2. Load a text file fills Content, and an empty Title and Source', JSON.stringify(got));
  await page.eval(setValue('#title', TITLE));
  await sleep(200);
  check((await page.eval(addDisabled)) === false && /Ready to add/.test(await page.eval(footer)), '3. with a title and content: "Ready to add", Add enabled', await page.eval(footer));

  // 4. How it will be split: the chunks, listed.
  await page.eval("document.querySelector('dialog.drawer[open] .doc-disclosure summary').click()");
  await page.until("document.querySelectorAll('.chunk-preview li').length > 0", 5000);
  const preview = await page.eval("document.querySelectorAll('.chunk-preview li').length");
  check(preview > 0, '4. "How it will be split" lists the chunks', `${preview} chunks`);
  await page.eval("document.querySelector('.chunk-preview').scrollIntoView()");
  await sleep(200);
  await page.shot(join(OUT, 'filled-preview-1280.png'));
  await page.viewport(390);
  await sleep(300);
  await page.shot(join(OUT, 'filled-preview-390.png'));
  check((await page.eval('document.documentElement.scrollWidth')) <= 390, '5. 390 px: no sideways scroll', `${await page.eval('document.documentElement.scrollWidth')}px`);
  await page.viewport(1280);

  // 6. Save: the server's chunk count is the preview's.
  await page.eval("document.querySelector('dialog.drawer[open] button[type=submit]').click()");
  const saved = await page.until("!document.querySelector('dialog.drawer[open]')", 60000);
  const { data: row } = await supabase.from('documents').select('id').eq('tenant_id', tenant.id).eq('title', TITLE).maybeSingle();
  const { count } = row ? await supabase.from('chunks').select('id', { count: 'exact', head: true }).eq('tenant_id', tenant.id).eq('document_id', row.id) : { count: null };
  check(saved && count === preview, '6. saved: the server stored exactly the chunks the preview showed', `preview ${preview}, stored ${count}`);
  check(errors.length === 0, '7. no console error', errors.join(' | '));
} catch (error) {
  check(false, 'walk', error.message);
} finally {
  browser?.close();
  const { data: left } = await supabase.from('documents').select('id').eq('tenant_id', tenant.id).eq('title', TITLE);
  for (const d of left ?? []) await supabase.from('documents').delete().eq('tenant_id', tenant.id).eq('id', d.id);
  if (userId) await supabase.auth.admin.deleteUser(userId);
}
console.log(`\n${failures === 0 ? 'all passed' : `${failures} FAILED`}`);
process.exit(failures ? 1 : 0);
