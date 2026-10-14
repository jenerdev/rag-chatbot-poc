// stay-notes-browser-walk.mjs — the Staff notes card on S-15 in a browser (D-132), against pnpm dev.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/stay-notes-browser-walk.mjs [base])
//
// A throwaway staff member of villa, on villa's newest stay, with one note
// already there from a colleague. Types and adds a note through the form,
// checks who may delete which, deletes its own through the dialog, and
// photographs the card light and dark at 1280 and 390 into plan/stay-notes/.
// Removes its notes and accounts at the end.

import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'stay-notes');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const { data: villa } = await supabase.from('tenants').select('id').eq('slug', 'villa').single();
const { data: stay } = await supabase.from('stays').select('reference, group_id').eq('tenant_id', villa.id).order('created_at', { ascending: false }).limit(1).single();
const ids = [];
let browser;

try {
  const make = async (name, role) => {
    const email = `stay-notes-${name}-${Date.now()}@example.com`;
    const password = randomBytes(18).toString('base64url');
    const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(error.message);
    ids.push(data.user.id);
    await supabase.from('memberships').insert({ user_id: data.user.id, tenant_id: villa.id, role });
    return { id: data.user.id, email, password };
  };
  const me = await make('staff', 'staff');
  const colleague = await make('admin', 'admin');
  // The colleague's note, written as service_role in the colleague's name.
  await supabase.from('stay_notes').insert({ tenant_id: villa.id, group_id: stay.group_id, author: colleague.id, body: 'Guest called: arriving around 4 pm, two cars.' });

  const login = await fetch(`${BASE}/api/t/villa/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: me.email, password: me.password }) });
  const cookie = (login.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('rag_admin='))?.split(';')[0];
  if (!cookie) throw new Error(`login ${login.status}`);

  browser = await openBrowser({ scheme: 'light' });
  const { page: tab } = browser;
  await tab.send('Network.setCookie', { name: 'rag_admin', value: cookie.slice('rag_admin='.length), url: `${BASE}/api/t/villa/`, path: '/api/t/villa' });
  await tab.viewport(1280);
  await tab.goto(`${BASE}/t/villa/admin/bookings/${stay.reference}`);
  await tab.until("!!document.querySelector('.stay-card-notes')", 30000);

  // 1. The card: its heading counts 1, the colleague's note has no delete button, the Add button waits for text.
  const first = await tab.eval(`(() => {
    const card = document.querySelector('.stay-card-notes');
    return { heading: card.querySelector('h3').textContent, notes: card.querySelectorAll('.stay-notes li').length, deletes: card.querySelectorAll('.stay-notes button').length, addDisabled: card.querySelector('form button[type=submit]').disabled };
  })()`);
  check(first.heading === 'Staff notes · 1' && first.notes === 1 && first.deletes === 0 && first.addDisabled === true, "1. the card: 'Staff notes · 1', a colleague's note with no delete, Add disabled while empty", JSON.stringify(first));

  // 2. Type and add: the new note is first, "You", with a delete button; the box is empty again.
  await tab.type('#stay-note-body', 'Wants the pool heated. Told them it is extra.');
  await tab.until("!document.querySelector('.stay-card-notes form button[type=submit]').disabled", 3000);
  await tab.click('.stay-card-notes form button[type=submit]');
  await tab.until("document.querySelectorAll('.stay-notes li').length === 2", 10000);
  await sleep(300);
  const second = await tab.eval(`(() => {
    const li = document.querySelector('.stay-notes li');
    return { who: li.querySelector('.stay-notes-head .small').textContent, body: li.querySelector('p').textContent, del: !!li.querySelector('button[aria-label^="Delete your note"]'), box: document.querySelector('#stay-note-body').value, heading: document.querySelector('.stay-card-notes h3').textContent };
  })()`);
  check(second.who.startsWith('You · ') && second.body === 'Wants the pool heated. Told them it is extra.' && second.del && second.box === '' && second.heading === 'Staff notes · 2', '2. typed and added: newest first, "You", a delete button, the box cleared', JSON.stringify(second));

  // 3. The photographs, light and dark, desktop and phone; no sideways scroll.
  const widths = [];
  for (const scheme of ['light', 'dark']) {
    await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    for (const width of [1280, 390]) {
      await tab.viewport(width);
      await tab.goto(`${BASE}/t/villa/admin/bookings/${stay.reference}`);
      await tab.until("document.querySelectorAll('.stay-notes li').length === 2", 30000);
      await tab.eval("document.querySelector('.stay-card-notes').scrollIntoView({ block: 'start' })");
      await sleep(300);
      const docWidth = await tab.eval('document.documentElement.scrollWidth');
      widths.push(`${scheme} ${width}: ${docWidth}`);
      if (docWidth > width) failures++;
      await tab.shot(join(OUT, `notes-${scheme}-${width}.png`));
    }
  }
  await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  check(widths.every((w) => Number(w.split(': ')[1]) <= Number(w.split(' ')[1].replace(':', ''))), '3. no sideways scroll, light and dark, 1280 and 390 (plan/stay-notes/)', widths.join(' · '));

  // 4. Delete my own through the dialog: one left, the colleague's.
  await tab.viewport(1280);
  await tab.click('.stay-notes button[aria-label^="Delete your note"]');
  await tab.until("!!document.querySelector('dialog[open]')", 5000);
  await tab.eval("[...document.querySelectorAll('dialog[open] button')].find(b => b.textContent.trim() === 'Delete note').click()");
  await tab.until("document.querySelectorAll('.stay-notes li').length === 1", 10000);
  const left = await tab.eval("document.querySelector('.stay-notes li p').textContent");
  check(left.startsWith('Guest called'), "4. deleted through the dialog: the colleague's note is the one left", left);
} catch (error) {
  check(false, 'walk', error.message);
} finally {
  browser?.close();
  if (ids.length) {
    const { count } = await supabase.from('stay_notes').delete({ count: 'exact' }).eq('tenant_id', villa.id).in('author', ids);
    console.log(`cleaned: ${count ?? 0} notes`);
  }
  for (const id of ids) await supabase.auth.admin.deleteUser(id);
}
console.log(failures === 0 ? '\nOK — 4 of 4.' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
