// The setup drawers in a browser, against pnpm dev (harbor): each footer says
// what is missing and the primary button waits for it; the read-back
// sentence follows the fields; saving through the drawer stores what was
// typed. A slot, a promo (with a code) and a closed date are created through
// the drawers, checked in the database, and deleted at the end. The Rooms
// drawer is only filled (a room cannot be deleted), never saved.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/setup-drawers-walk.mjs)

import { randomBytes } from 'node:crypto';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const SLUG = 'harbor';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const setValue = (sel, value) =>
  `(() => { const el = document.querySelector(${JSON.stringify(sel)}); const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`;
const footer = "document.querySelector('dialog.drawer[open] .drawer-footer-total')?.innerText.trim()";
const submitDisabled = "document.querySelector('dialog.drawer[open] button[type=submit]')?.disabled";
const summary = "document.querySelector('dialog.drawer[open] .setup-summary')?.innerText.trim() ?? ''";

const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', SLUG).single();
const made = { slot: null, promo: null, day: null };
let userId;
let browser;
try {
  const email = `setup-walk-${Date.now()}@example.com`;
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
  const openDrawer = async (path) => {
    await page.goto(`${BASE}/t/${SLUG}/admin/${path}`);
    await page.until("!!document.querySelector('.page-actions button')", 45000);
    await sleep(500);
    await page.eval("document.querySelector('.page-actions button').click()");
    await page.until("!!document.querySelector('dialog.drawer[open]')", 10000);
    await sleep(300);
  };
  const submit = async () => {
    await page.eval("document.querySelector('dialog.drawer[open] button[type=submit]').click()");
    return page.until("!document.querySelector('dialog.drawer[open]')", 20000);
  };

  // 1. Slots: the end read back across midnight; saved as typed.
  await openDrawer('slots');
  check((await page.eval(submitDisabled)) && (await page.eval(footer)) === 'Add a name', '1. slot: empty, "Add a name", Add waits', await page.eval(footer));
  const slotName = `Walk Late ${Date.now() % 100000}`;
  await page.eval(setValue('#slot-name', slotName));
  await page.eval(setValue('#slot-start', '20:30'));
  await page.eval(setValue('#slot-hours', '6'));
  await page.eval(setValue('#slot-minutes', '15'));
  await sleep(200);
  const slotLine = await page.eval(summary);
  check(slotLine.includes('Runs 20:30 to 02:45 the next day (6 hours 15 minutes)'), '1b. slot: "Runs 20:30 to 02:45 the next day (6 hours 15 minutes)"', slotLine);
  check(await submit(), '1c. slot: saved through the drawer');
  const { data: slot } = await supabase.from('slots').select('id, start_time, duration').eq('tenant_id', tenant.id).eq('name', slotName).maybeSingle();
  made.slot = slot?.id ?? null;
  check(slot?.start_time?.startsWith('20:30') && slot?.duration === '06:15:00', '1d. slot: stored as 20:30 for 6 h 15 min', JSON.stringify(slot));

  // 2. Promos: a code is asked for only when "With a code" is chosen; saved with it.
  await openDrawer('promos');
  const promoName = `Walk promo ${Date.now() % 100000}`;
  await page.eval(setValue('#promo-name', promoName));
  await page.eval(setValue('#promo-value', '15'));
  await page.eval(setValue('#promo-from', '2027-03-01'));
  await page.eval(setValue('#promo-to', '2027-03-31'));
  await page.eval("document.querySelectorAll('input[name=promo-how]')[1].click()");
  await sleep(200);
  const waitsForCode = (await page.eval(submitDisabled)) && /Type the code/.test(await page.eval(footer));
  await page.eval(setValue('#promo-code', 'WALK15'));
  await page.eval(setValue('#promo-max', '3'));
  await sleep(200);
  const promoLine = await page.eval(summary);
  check(waitsForCode && promoLine === '15 % off stays from 1 Mar to 31 Mar 2027, for guests who type WALK15, for up to 3 bookings.', '2. promo: waits for the code once "With a code" is chosen; the sentence reads it back', promoLine);
  check(await submit(), '2b. promo: saved through the drawer');
  const { data: promo } = await supabase.from('promos').select('id, kind, value, code, max_uses').eq('tenant_id', tenant.id).eq('name', promoName).maybeSingle();
  made.promo = promo?.id ?? null;
  check(promo?.kind === 'percent' && promo.value === 1500 && promo.code === 'WALK15' && promo.max_uses === 3, '2c. promo: stored 15 % (1500), code WALK15, limit 3', JSON.stringify(promo));

  // 3. Holidays: "Closed" hides the surcharge and says nothing can be booked.
  await openDrawer('holidays');
  made.day = '2027-12-30';
  await page.eval(setValue('#day', made.day));
  await page.eval(setValue('#label', 'Walk closed'));
  await page.eval("document.querySelectorAll('input[name=kind]')[2].click()");
  await sleep(200);
  const closedLine = await page.eval(summary);
  const noSurcharge = await page.eval("!document.querySelector('dialog.drawer[open] #surcharge')");
  check(noSurcharge && /nothing can be booked/.test(closedLine), '3. holiday: Closed hides the surcharge and reads back "nothing can be booked"', closedLine);
  check(await submit(), '3b. holiday: saved through the drawer');
  const { data: day } = await supabase.from('rate_calendar').select('kind, label, surcharge').eq('tenant_id', tenant.id).eq('day', made.day).maybeSingle();
  check(day?.kind === 'closed' && day.label === 'Walk closed' && day.surcharge === 0, '3c. holiday: stored as closed, no surcharge', JSON.stringify(day));

  // 4. Rooms: the read-back follows the fields (not saved).
  await openDrawer('accommodations');
  await page.eval(setValue('#new-name', 'Walk Room'));
  await page.eval(setValue('#new-standard', '3'));
  await page.eval(setValue('#new-capacity', '5'));
  await page.eval(setValue('#new-fee', '400'));
  await sleep(200);
  const roomLine = await page.eval(summary);
  check(roomLine === 'Walk Room covers 3 guests, takes up to 5, and charges ₱400.00 a night for each guest above 3.' && (await page.eval(submitDisabled)) === false, '4. room: the sentence follows the fields; Add is ready', roomLine);
  check(errors.length === 0, '5. no console error', errors.join(' | '));
} catch (error) {
  check(false, 'walk', error.message);
} finally {
  browser?.close();
  if (made.slot) await supabase.from('slots').delete().eq('tenant_id', tenant.id).eq('id', made.slot);
  if (made.promo) await supabase.from('promos').delete().eq('tenant_id', tenant.id).eq('id', made.promo);
  if (made.day) await supabase.from('rate_calendar').delete().eq('tenant_id', tenant.id).eq('day', made.day);
  if (userId) await supabase.auth.admin.deleteUser(userId);
}
console.log(`\n${failures === 0 ? 'all passed' : `${failures} FAILED`}`);
process.exit(failures ? 1 : 0);
