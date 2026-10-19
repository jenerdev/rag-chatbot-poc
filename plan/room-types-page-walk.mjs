// Room types Phase 5 (D-133) on the booking page, in a browser, against
// pnpm dev: on harbor, whose Garden Room is two rooms (fixtures/harbor-units.json),
// the page offers a Rooms count once Garden Room is ticked, says "2 of 2
// left" from the quote, asks guests per room, and prices two rooms; with one
// Garden Room confirmed that night it says "1 of 2 left" and caps the count
// at 1. Nothing is sent: the one stay is seeded through the staff route and
// deleted at the end.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/room-types-page-walk.mjs)

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const SLUG = 'harbor';
const TYPE = 'Garden Room';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'room-types', 'walk');
// axe-core, unpacked as plan/ui-refresh-a11y.mjs says; the same rules.
const AXE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', 'axe', 'axe.min.js'), 'utf8');
const axe = async (page) => {
  await page.eval(AXE);
  return JSON.parse(await page.eval(`axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }).then(r => JSON.stringify(r.violations.map(v => v.id + ' (' + v.nodes.length + ')')))`));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', SLUG).single();
const { data: unit } = await supabase.from('units').select('id').eq('tenant_id', tenant.id).eq('name', TYPE).single();
const users = [];
const groups = [];
let browser;

// React owns the inputs: set the value through the native setter, then fire the event React listens for.
const setValue = (selector, value) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`;
const pick = `[...document.querySelectorAll('.room-pick')].find(p => p.querySelector('.room-pick-name')?.textContent === ${JSON.stringify(TYPE)})`;
const count = `input[aria-label^="How many ${TYPE} rooms"]`;

async function toRooms(page, checkIn) {
  await page.goto(`${BASE}/t/${SLUG}/book`);
  await page.until(`!!document.getElementById('check-in')`, 30000);
  await page.eval(setValue('#check-in', checkIn));
  await sleep(200);
  await page.eval(`document.querySelector('.step-footer button[type=submit]').click()`);
  await page.until(`!!${pick}`, 10000);
  await page.eval(`${pick}.querySelector('input[type=checkbox]').click()`);
  await page.until(`!!document.querySelector('input[aria-label="Guests in ${TYPE}"]')`, 5000);
  await page.eval(setValue(`input[aria-label="Guests in ${TYPE}"]`, '2'));
}

try {
  const email = `room-types-page-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data: made, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  users.push(made.user.id);
  await supabase.from('memberships').insert({ user_id: made.user.id, tenant_id: tenant.id, role: 'admin' });
  const r = await fetch(`${BASE}/api/t/${SLUG}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0];
  if (!cookie) throw new Error('login failed');
  const call = (path, init = {}) => fetch(`${BASE}/api/t/${SLUG}${path}`, { ...init, headers: { 'Content-Type': 'application/json', cookie } });
  const setup = await (await call('/bookings/setup')).json();
  const night = setup.slots.find((x) => x.nightly);
  const day = (n) => { const d = new Date(`${setup.today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const date = day(240);

  browser = await openBrowser({ scheme: 'light' });
  const page = browser.page;
  await page.viewport(1280);
  // What the dev overlay counts as an issue: React's warnings and errors, and uncaught exceptions.
  const problems = [];
  await page.send('Runtime.enable');
  page.on('Runtime.consoleAPICalled', (e) => {
    if (e.type === 'error' || e.type === 'warning') problems.push(e.args.map((x) => x.value ?? x.description).join(' ').slice(0, 300));
  });
  page.on('Runtime.exceptionThrown', (e) => problems.push(e.exceptionDetails.exception?.description?.slice(0, 300) ?? 'exception'));

  // 1. Nothing booked: 2 of 2 left, a count of up to 2, two rooms priced.
  await toRooms(page, date);
  const left = await page.until(`${pick}.textContent.includes('2 of 2 left')`, 10000).then(() => true, () => false);
  check(left, '1. the quote says "2 of 2 left"');
  check((await page.eval(`document.querySelector(${JSON.stringify(count)})?.max`)) === '2', '1b. the Rooms count goes up to 2');
  await page.eval(setValue(count, '3'));
  await sleep(200);
  check((await page.eval(`document.querySelector(${JSON.stringify(count)}).value`)) === '2', '1c. asking for 3 stays at 2');
  const two = await page.until(`!!document.querySelector('input[aria-label="Guests in ${TYPE}, room 2"]')`, 5000).then(() => true, () => false);
  check(two, '1d. two rooms ask for guests each');
  if (two) {
    await page.eval(setValue(`input[aria-label="Guests in ${TYPE}, room 1"]`, '2'));
    await page.eval(setValue(`input[aria-label="Guests in ${TYPE}, room 2"]`, '1'));
    const priced = await page.until(`document.querySelectorAll('.quote .quote-night').length === 2 && !document.querySelector('.quote.error')`, 10000).then(() => true, () => false);
    check(priced, '1e. the quote prices two Garden Rooms for the night, available');
  }
  await page.shot(join(OUT, 'book-two-1280.png'));
  const twoAxe = await axe(page);
  check(twoAxe.length === 0, '1f. axe: the two-room step has no violation', twoAxe.join(', '));

  // 2. One Garden Room confirmed that night: 1 of 2 left, the count stops at 1.
  const res = await call('/bookings', { method: 'POST', body: JSON.stringify({ slotId: night.id, rooms: [{ unitId: unit.id, guests: 2 }], checkIn: date, nights: 1, name: 'Room Types Page Walk', phone: '0917 555 0144', email: 'room.types.page@example.com' }) });
  const body = await res.json();
  if (res.status !== 201) throw new Error(`book: ${res.status} ${body.error}`);
  groups.push(body.groupId);
  await call(`/bookings/requests/${body.groupId}`, { method: 'PATCH', body: JSON.stringify({ action: 'confirm', note: 'walk: room types page' }) });
  await toRooms(page, date);
  const one = await page.until(`${pick}.textContent.includes('1 of 2 left')`, 10000).then(() => true, () => false);
  check(one, '2. with one confirmed, the quote says "1 of 2 left"');
  const capped = await page.until(`document.querySelector(${JSON.stringify(count)})?.max === '1'`, 10000).then(() => true, () => false);
  check(capped, '2b. the Rooms count stops at 1', `max ${await page.eval(`document.querySelector(${JSON.stringify(count)})?.max`)}; ${await page.eval(`${pick}.textContent`)}`);
  const ok = await page.until(`!!document.querySelector('.quote') && !document.querySelector('.quote.error')`, 10000).then(() => true, () => false);
  check(ok, '2c. one Garden Room is still available');
  await page.shot(join(OUT, 'book-one-left-1280.png'));

  await page.viewport(375);
  await sleep(300);
  check(!(await page.eval('document.documentElement.scrollWidth > window.innerWidth')), '3. the room step at 375 px has no sideways scroll');
  await page.shot(join(OUT, 'book-one-left-375.png'));
  const phoneAxe = await axe(page);
  check(phoneAxe.length === 0, '3b. axe: the capped step at 375 px has no violation', phoneAxe.join(', '));
  check(problems.length === 0, '4. no console error or warning on the way', problems.join(' | '));
} finally {
  browser?.close();
  for (const g of groups) await supabase.from('bookings').delete().eq('tenant_id', tenant.id).eq('group_id', g);
  for (const u of users) await supabase.auth.admin.deleteUser(u);
}
console.log(`\n${failures === 0 ? 'all passed' : `${failures} FAILED`}`);
process.exit(failures ? 1 : 0);
