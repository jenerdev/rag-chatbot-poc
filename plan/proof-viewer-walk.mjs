// The proof of payment in a popup, in a browser, against pnpm dev:
//   guest  Manage booking shows the picked file as a thumbnail; clicking it
//          opens the popup with the image (from memory, before sending);
//   staff  the booking's Review proof drawer shows the stored proof as a
//          thumbnail; clicking it opens the popup ABOVE the drawer, with the
//          image loaded from its signed link; Escape closes the popup and
//          leaves the drawer open; no new tab is opened.
// On alteza (it takes payments). One booking-page request and one proof,
// deleted at the end (the proof file too).
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/proof-viewer-walk.mjs)

import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const SLUG = 'alteza';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'ui-refresh', 'proof-viewer');
// Any real PNG will do as a "receipt": an earlier screenshot of this project.
const RECEIPT = resolve(HERE, 'ui-refresh', 'staff-booking', 'harbor-list-1280.png');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
// A real mouse click at an element's centre. A scripted .click() carries no
// user activation, and Chrome then groups the dialogs it opens: one Escape
// closes the popup AND the drawer under it (seen in this walk's first runs).
const realClick = async (page, sel) => {
  const box = await page.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
};
const loaded = (sel) => `(() => { const i = document.querySelector(${JSON.stringify(sel)}); return !!i && i.complete && i.naturalWidth > 0; })()`;

const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', SLUG).single();
let userId;
let group;
let browser;
try {
  // A staff admin for the setup read and the review.
  const email = `proof-walk-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data: u, error: ue } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (ue) throw new Error(ue.message);
  userId = u.user.id;
  const m = await supabase.from('memberships').insert({ user_id: userId, tenant_id: tenant.id, role: 'admin' });
  if (m.error) throw new Error(m.error.message);
  const r = await fetch(`${BASE}/api/t/${SLUG}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0];
  if (!cookie) throw new Error('login failed');
  const setup = await (await fetch(`${BASE}/api/t/${SLUG}/bookings/setup`, { headers: { cookie } })).json();

  // A booking-page request (the chat token's door), inside the tenant's horizon.
  const unit = setup.units.find((x) => x.active);
  const slot = setup.slots.find((x) => x.nightly) ?? setup.slots[0];
  const day = (n) => { const d = new Date(`${setup.today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const guest = { email: `proof.walk.${Date.now()}@example.com`, phone: `0917${String(Date.now()).slice(-7)}` };
  const req = await fetch(`${BASE}/api/t/${SLUG}/book/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ consent: true, consentVersion: '1', slotId: slot.id, rooms: [{ unitId: unit.id, guests: 2 }], checkIn: day(12), nights: 1, name: 'Proof Walk', phone: guest.phone, email: guest.email }),
  });
  const receipt = await req.json();
  if (req.status !== 201) throw new Error(`request ${req.status} ${receipt.error}`);
  const ref = receipt.reference;
  ({ data: { group_id: group } } = await supabase.from('stays').select('group_id').eq('tenant_id', tenant.id).eq('reference', ref).single());

  browser = await openBrowser({ scheme: 'light' });
  const page = browser.page;
  await page.viewport(1280);
  // Every console error and uncaught exception on the way, printed and counted (a dev overlay's "Issues").
  const errors = [];
  await page.send('Runtime.enable', {});
  page.on('Runtime.consoleAPICalled', (e) => { if (e.type === 'error') errors.push(e.args.map((x) => x.value ?? x.description ?? '').join(' ').slice(0, 300)); });
  page.on('Runtime.exceptionThrown', (e) => errors.push((e.exceptionDetails.exception?.description ?? e.exceptionDetails.text).slice(0, 300)));
  globalThis.__errors = errors;
  await page.eval("window.__opened = 0; window.open = () => { window.__opened++; return null; };");

  // 1. Guest: pick the file, see it, open it in the popup.
  await page.goto(`${BASE}/t/${SLUG}/manage?ref=${ref}`);
  await page.until("!!document.querySelector('#contact')", 20000);
  await page.type('#contact', guest.email);
  await page.eval("document.querySelector('#contact').form.requestSubmit()");
  await page.until("!!document.querySelector('#pay-file')", 20000);
  const doc = await page.send('DOM.getDocument', { depth: -1 });
  const { result: node } = await page.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#pay-file' });
  await page.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [RECEIPT] });
  const thumb = await page.until(loaded('.proof-picked .proof-thumb img'), 10000);
  check(thumb, '1. guest: the picked receipt shows as a thumbnail before sending');
  await page.shot(join(OUT, 'guest-picked-1280.png'));
  await page.eval("document.querySelector('.proof-picked .proof-thumb').click()");
  const guestPopup = await page.until(`!!document.querySelector('dialog.proof-viewer[open]') && ${loaded('dialog.proof-viewer[open] img')}`, 10000);
  check(guestPopup, '2. guest: clicking it opens the popup with the image, on the page');
  await page.shot(join(OUT, 'guest-popup-1280.png'));
  await page.key('Escape', 'Escape', 27);
  await sleep(300);
  check(!(await page.eval("!!document.querySelector('dialog.proof-viewer[open]')")), '3. guest: Escape closes the popup');

  // The proof itself, sent through the guest's route (the same door the form uses).
  const lookup = await (await fetch(`${BASE}/api/t/${SLUG}/manage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reference: ref, contact: guest.email }) })).json();
  const form = new FormData();
  form.append('reference', ref);
  form.append('contact', guest.email);
  form.append('method', lookup.pay?.methods?.[0]?.label ?? 'GCash');
  form.append('amount', '100');
  form.append('paidOn', setup.today);
  form.append('payerReference', 'WALK-1');
  form.append('idempotencyKey', randomUUID());
  form.append('file', new Blob([readFileSync(RECEIPT)], { type: 'image/png' }), 'receipt.png');
  const sent = await fetch(`${BASE}/api/t/${SLUG}/manage/proof`, { method: 'POST', body: form });
  if (sent.status !== 201) throw new Error(`proof ${sent.status} ${(await sent.json()).error}`);

  // 4. Staff: Review proof shows the stored proof; the popup rises above the drawer.
  await page.send('Network.setCookie', { name: 'rag_admin', value: cookie.slice('rag_admin='.length), url: `${BASE}/api/t/${SLUG}/`, path: `/api/t/${SLUG}` });
  await page.goto(`${BASE}/t/${SLUG}/admin/bookings/${ref}`);
  await page.until("[...document.querySelectorAll('.stay-actions button')].some(b => b.textContent.trim() === 'Review proof')", 30000);
  await page.eval("document.querySelectorAll('.stay-actions button').forEach((b) => { if (b.textContent.trim() === 'Review proof') b.id = 'review-proof'; })");
  await realClick(page, '#review-proof');
  const staffThumb = await page.until(loaded('dialog.drawer[open] .proof-thumb img'), 15000);
  check(staffThumb, '4. staff: the Review proof drawer shows the stored proof as a thumbnail');
  await page.shot(join(OUT, 'staff-drawer-1280.png'));
  await realClick(page, 'dialog.drawer[open] .proof-thumb');
  const staffPopup = await page.until(`!!document.querySelector('dialog.proof-viewer[open]') && ${loaded('dialog.proof-viewer[open] img')}`, 10000);
  // The popup is the top of the top layer: the element under the viewport's centre belongs to it.
  const onTop = await page.eval("(() => { const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2); return !!el && !!el.closest('dialog.proof-viewer'); })()");
  check(staffPopup && onTop, '5. staff: clicking it opens the popup above the drawer, the image loaded from its signed link', `loaded ${staffPopup}, on top ${onTop}`);
  await page.shot(join(OUT, 'staff-popup-1280.png'));
  await page.key('Escape', 'Escape', 27);
  await sleep(300);
  const after = await page.eval("({ popup: !!document.querySelector('dialog.proof-viewer[open]'), drawer: !!document.querySelector('dialog.drawer[open]') })");
  check(!after.popup && after.drawer, '6. staff: Escape closes the popup and leaves the drawer open', JSON.stringify(after));
  check((await page.eval('window.__opened ?? 0')) === 0, '7. no new tab or window was opened');
  check(globalThis.__errors.length === 0, '8. no console error or exception on the way', globalThis.__errors.join(' | '));

  // 9. The form: Verify's buttons wait for the box, and say so.
  await page.eval("document.querySelector('dialog.drawer[open]').scrollTop = 1e6");
  await sleep(300);
  const verifyState = await page.eval("({ hint: document.querySelector('.drawer-footer-total').innerText.trim(), disabled: [...document.querySelectorAll('.drawer-footer button')].filter(b => /Verify/.test(b.textContent)).every(b => b.disabled) })");
  check(verifyState.disabled && /Tick the box/.test(verifyState.hint), '9. Verify waits for "I checked the account", and the footer says so', JSON.stringify(verifyState));
  await page.shot(join(OUT, 'staff-review-verify-1280.png'));

  // 10. Reject: the reason is required; a quick pick fills it; the proof is rejected for real.
  await realClick(page, '.review-option.danger input');
  await sleep(200);
  const before = await page.eval("({ hint: document.querySelector('.drawer-footer-total').innerText.trim(), disabled: [...document.querySelectorAll('.drawer-footer button')].find(b => b.textContent.trim() === 'Reject proof')?.disabled })");
  await realClick(page, '.review-proof .chip-picks .chip');
  await sleep(200);
  const reason = await page.eval("document.querySelector('#reject-reason').value");
  const enabled = await page.eval("[...document.querySelectorAll('.drawer-footer button')].find(b => b.textContent.trim() === 'Reject proof')?.disabled === false");
  check(before.disabled === true && /reason/.test(before.hint) && reason.length > 0 && enabled, '10. Reject needs a reason; a quick pick fills it and enables "Reject proof"', `${JSON.stringify(before)} · "${reason}"`);
  await page.shot(join(OUT, 'staff-review-reject-1280.png'));
  await page.viewport(390);
  await sleep(300);
  await page.shot(join(OUT, 'staff-review-reject-390.png'));
  await page.viewport(1280);
  await page.eval("document.querySelectorAll('.drawer-footer button').forEach((b) => { if (b.textContent.trim() === 'Reject proof') b.id = 'reject-proof'; })");
  await realClick(page, '#reject-proof');
  const rejected = await page.until("!document.querySelector('dialog.drawer[open]') && [...document.querySelectorAll('.stay-list .badge')].some(b => b.textContent.trim() === 'Rejected')", 15000);
  const { data: row } = await supabase.from('payments').select('status, rejection_reason').eq('tenant_id', tenant.id).eq('group_id', group).single();
  check(rejected && row?.status === 'rejected' && row.rejection_reason === reason, '11. the proof is rejected with that reason; the drawer closes and the page shows Rejected', `${row?.status} "${row?.rejection_reason}"`);
  check(globalThis.__errors.length === 0, '12. still no console error', globalThis.__errors.join(' | '));
} catch (error) {
  check(false, 'walk', error.message);
} finally {
  browser?.close();
  if (group) {
    const { data: proofs } = await supabase.from('payments').select('proof_path').eq('tenant_id', tenant.id).eq('group_id', group);
    const paths = (proofs ?? []).map((p) => p.proof_path).filter(Boolean);
    if (paths.length) {
      const { data: removed } = await supabase.storage.from('payment-proofs').remove(paths);
      if ((removed?.length ?? 0) !== paths.length) console.log(`WARN  removed ${removed?.length ?? 0} of ${paths.length} proof files`);
    }
    await supabase.from('bookings').delete().eq('tenant_id', tenant.id).eq('group_id', group);
  }
  if (userId) await supabase.auth.admin.deleteUser(userId);
}
console.log(`\n${failures === 0 ? 'all passed' : `${failures} FAILED`}`);
process.exit(failures ? 1 : 0);
