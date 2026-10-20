// Quick notes on S-15 (D-135) in a browser, against pnpm dev: every note
// field on the booking page offers chips, a click fills the field with that
// sentence (editable, the chip reads pressed), and the action goes through
// with it. Walks Confirm, Decline, Cancel stay and a staff note on villa.
// Seeds two villa stays through the staff route as a throwaway admin;
// deletes them, the note and the user after, by the ids it made (trap 26).
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/quick-notes-walk.mjs)

import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const SLUG = 'villa';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'quick-notes', 'walk');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const realClick = async (page, sel) => {
  const box = await page.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
};
const DIALOG = 'dialog.dialog[open]';
// The dialog's chips, the field's text and whether the action button is ready.
const dialogState = (action) =>
  `(() => { const d = document.querySelector(${JSON.stringify(DIALOG)}); const chips = [...d.querySelectorAll('.chip-picks .chip')]; return { chips: chips.length, danger: !!d.querySelector('.chip-picks.danger'), pressed: chips.filter(c => c.getAttribute('aria-pressed') === 'true').map(c => c.textContent.trim()), value: d.querySelector('textarea').value, ready: [...d.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(action)})?.disabled === false }; })()`;

const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', SLUG).single();
const users = [];
const groups = [];
let browser;

try {
  const email = `quick-notes-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data: made, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  users.push(made.user.id);
  const m = await supabase.from('memberships').insert({ user_id: made.user.id, tenant_id: tenant.id, role: 'admin' });
  if (m.error) throw new Error(m.error.message);
  const r = await fetch(`${BASE}/api/t/${SLUG}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0];
  if (!cookie) throw new Error('login failed');
  const call = (path, init = {}) => fetch(`${BASE}/api/t/${SLUG}${path}`, { ...init, headers: { 'Content-Type': 'application/json', cookie } });

  const setup = await (await call('/bookings/setup')).json();
  const night = setup.slots.find((x) => x.nightly);
  const { data: units } = await supabase.from('units').select('id').eq('tenant_id', tenant.id).eq('active', true).order('sort_order');
  const day = (n) => { const d = new Date(`${setup.today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const book = async (offset, name) => {
    const res = await call('/bookings', { method: 'POST', body: JSON.stringify({ slotId: night.id, rooms: [{ unitId: units[0].id, guests: 2 }], checkIn: day(offset), nights: 1, name, phone: '0917 555 0188', email: 'quick.notes@example.com' }) });
    const body = await res.json();
    if (res.status !== 201) throw new Error(`book ${name}: ${res.status} ${body.error}`);
    groups.push(body.groupId);
    return { group: body.groupId, ref: body.bookings[0].reference };
  };
  const pending = await book(240, 'Quick Notes Pending');
  const confirmed = await book(243, 'Quick Notes Confirmed');
  const c = await call(`/bookings/requests/${confirmed.group}`, { method: 'PATCH', body: JSON.stringify({ action: 'confirm', note: 'walk: paid cash' }) });
  if (c.status !== 200) throw new Error(`confirm: ${c.status}`);

  browser = await openBrowser({ scheme: 'light' });
  const page = browser.page;
  await page.viewport(1280);
  await page.send('Network.setCookie', { name: 'rag_admin', value: cookie.slice('rag_admin='.length), url: `${BASE}/api/t/${SLUG}/`, path: `/api/t/${SLUG}` });

  await page.goto(`${BASE}/t/${SLUG}/admin/bookings/${pending.ref}`);
  await page.until("!!document.querySelector('.stay-actions')", 30000);

  // 1. Confirm: the chips, a pick fills the note and reads pressed, Confirm is ready.
  await page.eval("[...document.querySelectorAll('.stay-actions button')].find(b => b.textContent.trim() === 'Confirm').click()");
  await page.until(`!!document.querySelector('${DIALOG} textarea')`, 5000);
  await sleep(400);
  const before = await page.eval(dialogState('Confirm'));
  await realClick(page, `${DIALOG} .chip-picks .chip`);
  await sleep(200);
  const picked = await page.eval(dialogState('Confirm'));
  const first = await page.eval(`document.querySelector('${DIALOG} .chip-picks .chip').textContent.trim()`);
  check(before.chips >= 3 && !before.danger && before.value === '' && !before.ready, '1. Confirm asks for a note with quick notes, not ready until one is written', JSON.stringify(before));
  check(picked.value === first && picked.pressed.join() === first && picked.ready, '2. a click fills the note with the chip, the chip reads pressed, Confirm is ready', `"${picked.value}"`);
  await page.shot(join(OUT, 'confirm-1280.png'));
  // 3. The field stays editable: typing after a pick un-presses the chip.
  await page.type(`${DIALOG} textarea`, ' Room 2.');
  await sleep(200);
  const edited = await page.eval(dialogState('Confirm'));
  check(edited.value === `${first} Room 2.` && edited.pressed.length === 0 && edited.ready, '3. the note stays editable; an edited note presses no chip', `"${edited.value}"`);
  await page.eval(`[...document.querySelectorAll('${DIALOG} button')].find(b => b.textContent.trim() === 'Back').click()`);
  await sleep(300);

  // 4. Decline: a refusal's chips are the danger tone, and the words speak to the guest.
  await page.eval("[...document.querySelectorAll('.stay-actions button')].find(b => b.textContent.trim() === 'Decline').click()");
  await page.until(`!!document.querySelector('${DIALOG} textarea')`, 5000);
  await sleep(400);
  await realClick(page, `${DIALOG} .chip-picks .chip:nth-child(2)`);
  await sleep(200);
  const decline = await page.eval(dialogState('Decline'));
  check(decline.chips >= 3 && decline.danger && decline.pressed.length === 1 && decline.value === decline.pressed[0] && decline.ready, '4. Decline offers reasons in the danger tone; a pick fills the reason', JSON.stringify(decline));
  await page.shot(join(OUT, 'decline-1280.png'));
  await page.viewport(390);
  await sleep(300);
  const width = await page.eval('document.documentElement.scrollWidth');
  check(width <= 390, '5. the dialog with chips fits a phone', `scrollWidth ${width}`);
  await page.shot(join(OUT, 'decline-390.png'));
  await page.viewport(1280);
  await page.eval(`[...document.querySelectorAll('${DIALOG} button')].find(b => b.textContent.trim() === 'Back').click()`);
  await sleep(300);

  // 6. A staff note: a chip fills the textarea, Add note saves exactly that.
  const noteChips = await page.eval("document.querySelectorAll('.stay-note-form .chip-picks .chip').length");
  await realClick(page, '.stay-note-form .chip-picks .chip');
  await sleep(200);
  const draft = await page.eval("document.querySelector('#stay-note-body').value");
  await page.eval("document.querySelector('.stay-note-form button[type=submit]').click()");
  const saved = await page.until(`[...document.querySelectorAll('.stay-notes li p')].some(p => p.textContent === ${JSON.stringify(draft)})`, 15000);
  check(noteChips >= 3 && draft.length > 0 && saved, '6. a staff note from a chip is saved as written', `"${draft}"`);
  await page.shot(join(OUT, 'staff-note-1280.png'));

  // 7. Cancel stay on a confirmed stay: danger chips, and the cancel goes through with the picked reason.
  await page.goto(`${BASE}/t/${SLUG}/admin/bookings/${confirmed.ref}`);
  await page.until("!!document.querySelector('.stay-actions')", 30000);
  await page.eval("[...document.querySelectorAll('.stay-actions button')].find(b => b.textContent.trim() === 'Cancel stay').click()");
  await page.until(`!!document.querySelector('${DIALOG} textarea')`, 5000);
  await sleep(400);
  await realClick(page, `${DIALOG} .chip-picks .chip`);
  await sleep(200);
  const cancel = await page.eval(dialogState('Cancel stay'));
  await page.eval(`[...document.querySelectorAll('${DIALOG} button')].find(b => b.textContent.trim() === 'Cancel stay').click()`);
  const ended = await page.until(`(document.querySelector('.stay-outcome')?.textContent ?? '').includes(${JSON.stringify(cancel.value)})`, 15000);
  check(cancel.danger && cancel.ready && ended, '7. Cancel stay with a picked reason: cancelled, and the head quotes the reason', `"${cancel.value}"`);
  await page.shot(join(OUT, 'cancelled-1280.png'));
} finally {
  browser?.close();
  for (const g of groups) {
    const notes = await supabase.from('stay_notes').delete({ count: 'exact' }).eq('tenant_id', tenant.id).in('author', users);
    const rows = await supabase.from('bookings').delete({ count: 'exact' }).eq('tenant_id', tenant.id).eq('group_id', g);
    console.log(`cleaned group ${g}: ${rows.count ?? 0} bookings, ${notes.count ?? 0} notes`);
  }
  for (const u of users) await supabase.auth.admin.deleteUser(u);
}
console.log(failures === 0 ? 'quick notes walk: all pass' : `quick notes walk: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
