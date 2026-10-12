// The booking detail page (S-15, D-114) in a browser, against pnpm dev:
// the list has no buttons and opens the page; each state shows only the
// actions that apply (pending: Confirm + Decline; confirmed: Cancel; a
// cancelled stay: none); a staff member sees the same stay with the stay's
// own actions but no payment actions; Confirm through the dialog works.
// Seeds three harbor stays through the staff route; deletes them after.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/stay-detail-walk.mjs)

import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const SLUG = 'harbor';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', 'stay-detail');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const buttons = "[...document.querySelectorAll('.stay-actions button')].map(b => b.textContent.trim())";

const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', SLUG).single();
const users = [];
const groups = [];
let browser;
const login = async (role) => {
  const email = `stay-detail-${role}-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  users.push(data.user.id);
  const m = await supabase.from('memberships').insert({ user_id: data.user.id, tenant_id: tenant.id, role });
  if (m.error) throw new Error(m.error.message);
  const r = await fetch(`${BASE}/api/t/${SLUG}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0];
  if (!cookie) throw new Error(`login failed (${role})`);
  return cookie;
};

try {
  const admin = await login('admin');
  const call = (path, init = {}) => fetch(`${BASE}/api/t/${SLUG}${path}`, { ...init, headers: { 'Content-Type': 'application/json', cookie: admin } });
  const setup = await (await call('/bookings/setup')).json();
  const night = setup.slots.find((x) => x.nightly);
  const { data: units } = await supabase.from('units').select('id').eq('tenant_id', tenant.id).eq('active', true).order('sort_order');
  const day = (n) => { const d = new Date(`${setup.today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const book = async (offset, unit, name) => {
    const res = await call('/bookings', { method: 'POST', body: JSON.stringify({ slotId: night.id, rooms: [{ unitId: units[unit].id, guests: 2 }], checkIn: day(offset), nights: 2, name, phone: '0917 555 0199', email: 'detail.walk@example.com' }) });
    const body = await res.json();
    if (res.status !== 201) throw new Error(`book ${name}: ${res.status} ${body.error}`);
    groups.push(body.groupId);
    return { group: body.groupId, ref: body.bookings[0].reference };
  };
  const pending = await book(220, 0, 'Pending Guest');
  const confirmed = await book(222, 1, 'Confirmed Guest');
  const cancelled = await book(224, 2, 'Cancelled Guest');
  await call(`/bookings/requests/${confirmed.group}`, { method: 'PATCH', body: JSON.stringify({ action: 'confirm', note: 'walk: paid cash' }) });
  await call(`/bookings/requests/${cancelled.group}`, { method: 'PATCH', body: JSON.stringify({ action: 'decline', note: 'walk: declined' }) });

  browser = await openBrowser({ scheme: 'light' });
  const page = browser.page;
  await page.viewport(1280);
  await page.send('Network.setCookie', { name: 'rag_admin', value: admin.slice('rag_admin='.length), url: `${BASE}/api/t/${SLUG}/`, path: `/api/t/${SLUG}` });

  // 1. The list: rows are links, no buttons inside them.
  await page.goto(`${BASE}/t/${SLUG}/admin/bookings?from=${day(219)}`);
  await page.until(`!!document.querySelector('a.stay-row[href$="${pending.ref}"]')`, 30000);
  const inRows = await page.eval("document.querySelectorAll('.stay-row button').length");
  check(inRows === 0, '1. the list rows are links with no buttons in them', `${inRows} buttons`);
  await page.shot(join(OUT, 'list-1280.png'));

  // 2. Pending: Decline and Confirm; no Cancel, no refund.
  await page.eval(`document.querySelector('a.stay-row[href$="${pending.ref}"]').click()`);
  await page.until("!!document.querySelector('.stay-actions')", 30000);
  const p = await page.eval(buttons);
  check(JSON.stringify(p) === JSON.stringify(['Decline', 'Confirm']), '2. pending: Decline and Confirm only (opened from the list)', JSON.stringify(p));
  await page.shot(join(OUT, 'pending-1280.png'));

  // 3. Confirm through the dialog: a note, then the page shows Confirmed and offers Cancel.
  await page.eval("[...document.querySelectorAll('.stay-actions button')].find(b => b.textContent.trim() === 'Confirm').click()");
  await page.until("!!document.querySelector('dialog.dialog[open] textarea, dialog.dialog[open] input')", 5000);
  await page.type('dialog.dialog[open] textarea, dialog.dialog[open] input', 'walk: paid at the desk');
  await page.eval("[...document.querySelectorAll('dialog.dialog[open] button')].find(b => b.textContent.trim() === 'Confirm').click()");
  const after = await page.until(`(${buttons}).join() === 'Cancel stay'`, 15000);
  const badge = await page.eval("[...document.querySelectorAll('.stay-head .badge')].map(b => b.textContent.trim()).join(',')");
  check(after && /Confirmed/.test(badge), '3. Confirm through the dialog: Confirmed, and now only Cancel stay', `${badge} · ${JSON.stringify(await page.eval(buttons))}`);

  // 4. A cancelled (declined) stay: no actions at all.
  await page.goto(`${BASE}/t/${SLUG}/admin/bookings/${cancelled.ref}`);
  await page.until("!!document.querySelector('.stay-head')", 30000);
  check(!(await page.eval("!!document.querySelector('.stay-actions')")), '4. a declined stay shows no actions section');
  await page.shot(join(OUT, 'cancelled-1280.png'));

  // 5. Another tenant's reference / a made-up one: "No such booking".
  await page.goto(`${BASE}/t/${SLUG}/admin/bookings/NOPE-123456`);
  check(await page.until("/No such booking/.test(document.body.innerText)", 15000), '5. an unknown reference says "No such booking"');

  // 6. A staff member on the confirmed stay: Cancel stay (bookings:write), and the page loads.
  const staffCookie = await login('staff');
  await page.send('Network.setCookie', { name: 'rag_admin', value: staffCookie.slice('rag_admin='.length), url: `${BASE}/api/t/${SLUG}/`, path: `/api/t/${SLUG}` });
  await page.goto(`${BASE}/t/${SLUG}/admin/bookings/${confirmed.ref}`);
  await page.until("!!document.querySelector('.stay-head')", 30000);
  const s = await page.eval(buttons);
  check(JSON.stringify(s) === JSON.stringify(['Cancel stay']), '6. staff on a confirmed stay: Cancel stay only', JSON.stringify(s));

  await page.viewport(390);
  await page.goto(`${BASE}/t/${SLUG}/admin/bookings/${confirmed.ref}`);
  await page.until("!!document.querySelector('.stay-head')", 30000);
  await sleep(300);
  await page.shot(join(OUT, 'confirmed-390.png'));
  const width = await page.eval('document.documentElement.scrollWidth');
  check(width <= 390, '7. 390 px: no sideways scroll', `${width}px`);
} catch (error) {
  check(false, 'walk', error.message);
} finally {
  browser?.close();
  for (const g of groups) await supabase.from('bookings').delete().eq('tenant_id', tenant.id).eq('group_id', g);
  for (const u of users) await supabase.auth.admin.deleteUser(u);
}
console.log(`\n${failures === 0 ? 'all passed' : `${failures} FAILED`}`);
process.exit(failures ? 1 : 0);
