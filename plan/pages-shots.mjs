// Screenshots of three staff screens on villa, desktop and phone: the
// dashboard (S-11), the knowledge base (S-2) and Unanswered (S-4). Seeds a
// few chats first (some answered, some refused with the NO_ANSWER marker),
// so the dashboard's chat figures and the Unanswered list have rows; deletes
// them at the end. Prints any console error on the way.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/pages-shots.mjs [slug])
//
// Needs pnpm dev.

import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = 'http://localhost:3000';
const SLUG = process.argv[2] ?? 'villa';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', 'pages');
const NO_ANSWER = "I don't know based on the documents I have.";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const QUESTIONS = [
  ['Do you allow pets at the villa?', NO_ANSWER],
  ['Is there a karaoke machine?', NO_ANSWER],
  ['Can we bring our own drinks?', NO_ANSWER],
  ['What time is check-in?', 'Check-in is at 2:00 PM.'],
  ['Is there Wi-Fi?', 'Yes, there is free Wi-Fi throughout the villa.'],
  ['Do you have a generator for brownouts?', NO_ANSWER],
  ['How far is the beach?', NO_ANSWER],
  ['Is the pool heated?', 'The pool is not heated.'],
];

const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', SLUG).single();
const conversations = [];
let userId;
let browser;
try {
  for (const [q, a] of QUESTIONS) {
    const { data: c, error } = await supabase.from('conversations').insert({ tenant_id: tenant.id }).select('id').single();
    if (error) throw new Error(error.message);
    conversations.push(c.id);
    const m = await supabase.from('messages').insert([
      { tenant_id: tenant.id, conversation_id: c.id, role: 'user', content: q },
      { tenant_id: tenant.id, conversation_id: c.id, role: 'assistant', content: a },
    ]);
    if (m.error) throw new Error(m.error.message);
  }

  const email = `pages-shots-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data: u, error: ue } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (ue) throw new Error(ue.message);
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
    for (const [name, path, ready] of [
      ['dashboard', 'admin/dashboard', ".dashboard, .card"],
      ['documents', 'admin/documents', ".card"],
      ['unanswered', 'admin/unanswered', ".card"],
    ]) {
      await page.goto(`${BASE}/t/${SLUG}/${path}`);
      await page.until(`!!document.querySelector(${JSON.stringify(ready)})`, 30000);
      await sleep(800);
      await page.shot(join(OUT, `${SLUG}-${name}-${width}.png`));
      const w = await page.eval('document.documentElement.scrollWidth');
      console.log(`${name} ${width}: page ${w}px wide`);
    }
  }
  // Unanswered's "Add answer" opens the knowledge base's form, already holding the question.
  await page.viewport(1280);
  await page.goto(`${BASE}/t/${SLUG}/admin/unanswered`);
  await page.until("[...document.querySelectorAll('.unanswered a.button')].length > 0", 30000);
  const question = await page.eval("document.querySelector('.unanswered .unanswered-question').textContent.trim()");
  await page.eval("document.querySelector('.unanswered a.button').click()");
  const prefilled = await page.until(`document.querySelector('dialog.drawer[open] #title')?.value === ${JSON.stringify(question)}`, 30000);
  const content = await page.eval("document.querySelector('dialog.drawer[open] #content')?.value ?? ''");
  const cleaned = await page.eval("!location.search.includes('question=')");
  console.log(`${prefilled && content.startsWith('Question: ') && cleaned ? 'PASS' : 'FAIL'}  Add answer opens the form with the question ("${question}"), and the address is cleaned`);
  await page.shot(join(OUT, `${SLUG}-add-answer-1280.png`));

  console.log(errors.length ? `console errors:\n  ${errors.join('\n  ')}` : 'no console errors');
} finally {
  browser?.close();
  if (conversations.length) await supabase.from('conversations').delete().eq('tenant_id', tenant.id).in('id', conversations);
  if (userId) await supabase.auth.admin.deleteUser(userId);
}
console.log(`shots in ${OUT}`);
