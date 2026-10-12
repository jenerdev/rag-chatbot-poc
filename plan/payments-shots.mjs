// Screenshots of the Payments screen (S-14) on alteza, desktop and phone,
// every tab: two booking-page requests, each with a proof sent through the
// guest's own route; one proof verified by staff, one left waiting. All of
// it deleted at the end (the proof files too). Prints the page width and any
// console error.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/payments-shots.mjs)
//
// Needs pnpm dev.

import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = 'http://localhost:3000';
const SLUG = 'alteza';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'ui-refresh', 'payments');
const RECEIPT = resolve(HERE, 'ui-refresh', 'staff-booking', 'harbor-list-1280.png');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', SLUG).single();
const groups = [];
let userId;
let browser;
try {
  const email = `payments-shots-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data: u, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  userId = u.user.id;
  await supabase.from('memberships').insert({ user_id: userId, tenant_id: tenant.id, role: 'admin' });
  const r = await fetch(`${BASE}/api/t/${SLUG}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0];
  if (!cookie) throw new Error('login failed');
  const staff = (path, init = {}) => fetch(`${BASE}/api/t/${SLUG}${path}`, { ...init, headers: { 'Content-Type': 'application/json', cookie } });

  const setup = await (await staff('/bookings/setup')).json();
  const unit = setup.units.find((x) => x.active);
  const slot = setup.slots.find((x) => x.nightly) ?? setup.slots[0];
  const day = (n) => { const d = new Date(`${setup.today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

  // Pesos text for a centavos amount (the form's own input shape): half the required for one, all of it for the other.
  const pesos = (centavos) => (centavos / 100).toFixed(2);
  const proofIds = [];
  const requiredOf = [];
  for (const [i, name] of ['Rosa Garcia', 'Paolo Mendoza'].entries()) {
    const guest = { email: `pay.shots.${i}.${Date.now()}@example.com`, phone: `0918${String(Date.now() + i).slice(-7)}` };
    const req = await fetch(`${BASE}/api/t/${SLUG}/book/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slotId: slot.id, rooms: [{ unitId: unit.id, guests: 2 }], checkIn: day(6 + i * 3), nights: 1, name, phone: guest.phone, email: guest.email }) });
    const receipt = await req.json();
    if (req.status !== 201) throw new Error(`request ${req.status} ${receipt.error}`);
    const { data: st } = await supabase.from('stays').select('group_id').eq('tenant_id', tenant.id).eq('reference', receipt.reference).single();
    groups.push(st.group_id);
    const lookup = (await (await fetch(`${BASE}/api/t/${SLUG}/manage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reference: receipt.reference, contact: guest.email }) })).json()).stay;
    const form = new FormData();
    for (const [k, v] of Object.entries({ reference: receipt.reference, contact: guest.email, method: lookup.pay?.methods?.[0]?.label ?? 'GCash', amount: pesos(i === 0 ? Math.floor(lookup.payment.required / 2) : lookup.payment.required), paidOn: setup.today, payerReference: `GC-${1000 + i}`, idempotencyKey: randomUUID() })) form.append(k, v);
    form.append('file', new Blob([readFileSync(RECEIPT)], { type: 'image/png' }), 'receipt.png');
    const sent = await fetch(`${BASE}/api/t/${SLUG}/manage/proof`, { method: 'POST', body: form });
    const body = await sent.json();
    if (sent.status !== 201) throw new Error(`proof ${sent.status} ${body.error}`);
    proofIds.push(body.paymentId);
    requiredOf.push(lookup.payment.required);
  }
  // The second proof verified (and its stay confirmed): a decided row in All payments.
  await staff(`/payments/${proofIds[1]}`, { method: 'PATCH', body: JSON.stringify({ action: 'verify', amount: pesos(requiredOf[1]), accountChecked: true, note: null, confirm: true }) });

  browser = await openBrowser({ scheme: 'light' });
  const page = browser.page;
  const errors = [];
  await page.send('Runtime.enable', {});
  page.on('Runtime.consoleAPICalled', (e) => { if (e.type === 'error') errors.push(e.args.map((x) => x.value ?? x.description ?? '').join(' ').slice(0, 300)); });
  await page.send('Network.setCookie', { name: 'rag_admin', value: cookie.slice('rag_admin='.length), url: `${BASE}/api/t/${SLUG}/`, path: `/api/t/${SLUG}` });
  for (const width of [1280, 390]) {
    await page.viewport(width);
    await page.goto(`${BASE}/t/${SLUG}/admin/payments`);
    await page.until("document.querySelectorAll('[role=tab]').length > 0 && !!document.querySelector('.list-row, .empty-list, .pay-row')", 45000);
    await sleep(800);
    const tabs = await page.eval("[...document.querySelectorAll('[role=tab]')].map(t => t.textContent.trim())");
    for (const [i, t] of tabs.entries()) {
      await page.eval(`document.querySelectorAll('[role=tab]')[${i}].click()`);
      await sleep(500);
      await page.shot(join(OUT, `tab${i + 1}-${width}.png`));
    }
    console.log(`${width}: tabs ${JSON.stringify(tabs)} · page ${await page.eval('document.documentElement.scrollWidth')}px wide`);
  }
  // Settings behaviour, without saving: the bar appears on a change and Discard
  // takes it away; "Stop taking payment" asks first, and Back keeps everything.
  await page.viewport(1280);
  await page.eval("[...document.querySelectorAll('[role=tab]')].find(t => t.textContent.trim() === 'Settings').click()");
  await sleep(400);
  const barBefore = await page.eval("!!document.querySelector('.settings-savebar')");
  const terms = await page.eval("document.querySelector('#pay-terms').value");
  await page.type('#pay-terms', ' (walk edit)');
  await sleep(200);
  const barAfter = await page.eval("document.querySelector('.settings-savebar span')?.textContent ?? null");
  await page.eval("document.querySelector('.settings-savebar').scrollIntoView()");
  await sleep(200);
  await page.shot(join(OUT, 'settings-dirty-1280.png'));
  await page.eval("[...document.querySelectorAll('.settings-savebar button')].find(b => b.textContent.trim() === 'Discard').click()");
  await sleep(200);
  const discarded = await page.eval(`!document.querySelector('.settings-savebar') && document.querySelector('#pay-terms').value === ${JSON.stringify(terms)}`);
  console.log(`${!barBefore && /unsaved changes/.test(barAfter ?? '') && discarded ? 'PASS' : 'FAIL'}  the save bar shows only after a change, and Discard restores the saved values  — before ${barBefore}, after "${barAfter}", discarded ${discarded}`);
  await page.eval("document.querySelector('.settings-danger button').click()");
  const asked = await page.until("!!document.querySelector('dialog.dialog[open]')", 5000);
  await page.eval("[...document.querySelectorAll('dialog.dialog[open] button')].find(b => b.textContent.trim() === 'Keep taking payment').click()");
  await sleep(300);
  const { data: still } = await supabase.from('tenant_applications').select('config').eq('tenant_id', tenant.id).eq('application_key', 'bookings').single();
  console.log(`${asked && still?.config?.payments ? 'PASS' : 'FAIL'}  "Stop taking payment" asks first; "Keep taking payment" changes nothing`);

  console.log(errors.length ? `console errors:\n  ${errors.join('\n  ')}` : 'no console errors');
} finally {
  browser?.close();
  for (const g of groups) {
    const { data: proofs } = await supabase.from('payments').select('proof_path').eq('tenant_id', tenant.id).eq('group_id', g);
    const paths = (proofs ?? []).map((p) => p.proof_path).filter(Boolean);
    if (paths.length) await supabase.storage.from('payment-proofs').remove(paths);
    await supabase.from('bookings').delete().eq('tenant_id', tenant.id).eq('group_id', g);
  }
  if (userId) await supabase.auth.admin.deleteUser(userId);
}
console.log(`shots in ${OUT}`);
