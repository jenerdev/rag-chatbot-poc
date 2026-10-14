// notifications-phase5-walk.mjs — real Web Push, end to end, on desktop
// Chrome (plan/notifications.md Phase 5).
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/notifications-phase5-walk.mjs)
//
// Needs pnpm dev with VAPID_* set, and network to Google's push service.
// Two Chrome profiles: an OWNER and a STAFF member of alteza (which takes
// payments, so a proof can be sent). Each signs in, turns on "Notify me on
// this device" with a real click, then leaves the staff page (the tab is
// gone; the service worker stays). A guest, from elsewhere, sends a web
// request, then a proof of payment, on the public routes. The drain runs
// after each response and POSTs to Google's push service for each device.
//
//   - the request is sent to both devices;
//   - the proof is sent to the owner's only (payments:write, Rule 3).
//
// HEADLESS CHROME SHOWS NO NOTIFICATION (observed 2026-10-13): Google
// accepted every push (201) and nothing arrived in 86 s; even a push handed
// to the worker by ServiceWorker.deliverPushMessage left getNotifications()
// empty. So this walk proves the SERVER half: who is sent what, and that the
// push service accepts it. What the worker shows, and where a tap goes, is
// lib/service-worker.test.ts; on a real screen, by hand (Phase 6).
//
// Everything made is deleted at the end: the stay, its proof file, the users
// (their memberships and devices go with them).

import { randomBytes, randomUUID } from 'node:crypto';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = 'http://localhost:3000';
const SLUG = 'alteza';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', SLUG).single();
const users = [];
const browsers = [];
const guestEmail = `notify-p5-${Date.now()}@example.com`;
try {
  // Two members, signed in.
  const member = async (role) => {
    const email = `notify-p5-${role}-${Date.now()}@example.com`;
    const password = randomBytes(18).toString('base64url');
    const { data: u, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(error.message);
    users.push(u.user.id);
    await supabase.from('memberships').insert({ user_id: u.user.id, tenant_id: tenant.id, role });
    const r = await fetch(`${BASE}/api/t/${SLUG}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    return { role, userId: u.user.id, cookie: (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0] };
  };
  const people = [await member('owner'), await member('staff')];

  // Each in their own Chrome: allow notifications, open Bookings, a real click on "Notify me".
  for (const person of people) {
    const browser = await openBrowser({});
    browsers.push(browser);
    person.page = browser.page;
    const page = person.page;
    await page.send('Browser.grantPermissions', { origin: BASE, permissions: ['notifications'] }).catch((e) => console.log(`grantPermissions: ${e.message}`));
    await page.send('Network.setCookie', { name: 'rag_admin', value: person.cookie.slice('rag_admin='.length), url: `${BASE}/api/t/${SLUG}/`, path: `/api/t/${SLUG}` });
    await page.viewport(1280);
    await page.goto(`${BASE}/t/${SLUG}/admin/bookings`);
    const ready = await page.until("!!document.querySelector('.push-toggle, .push-note, .push-on')", 30000);
    const offered = await page.eval("document.querySelector('.push-toggle, .push-note, .push-on')?.textContent ?? 'nothing'");
    if (!ready || !/Notify me/.test(offered)) throw new Error(`${person.role}: the sidebar offers "${offered}"`);
    const box = await page.eval("(() => { const r = document.querySelector('.push-toggle').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
    for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await page.until("!!document.querySelector('.push-on, .push-note.error')", 45000);
    person.state = await page.eval("document.querySelector('.push-on summary, .push-note.error')?.textContent ?? 'nothing'");
  }
  const devices = (await supabase.from('push_subscriptions').select('user_id, endpoint').eq('tenant_id', tenant.id).in('user_id', users)).data ?? [];
  check(
    people.every((p) => /Notifications on/.test(p.state)) && devices.length === 2 && devices.every((d) => d.endpoint.startsWith('https://fcm.googleapis.com/')),
    '1. owner and staff each turn on "Notify me on this device": two devices, on Google’s push service',
    people.map((p) => `${p.role}: ${p.state}`).join(' · ') + ` · stored ${devices.length}`,
  );

  // The tabs are gone: each browser is left on a blank page.
  for (const person of people) await person.page.goto('about:blank');


  // A guest's web request, from elsewhere: a free night within alteza's horizon.
  const { data: unit } = await supabase.from('units').select('id').eq('tenant_id', tenant.id).eq('active', true).order('id').limit(1).single();
  const { data: slots } = await supabase.from('slots').select('id').eq('tenant_id', tenant.id).eq('active', true).order('id');
  let stay = null;
  for (let days = 4; days < 19 && !stay; days++) {
    const checkIn = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    for (const slot of slots ?? []) {
      const body = { slotId: slot.id, rooms: [{ unitId: unit.id, guests: 1 }], checkIn, nights: 1 };
      const q = await fetch(`${BASE}/api/t/${SLUG}/book/quote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (q.ok && (await q.json()).available) {
        stay = body;
        break;
      }
    }
  }
  if (!stay) throw new Error('no free night in alteza’s horizon');
  const sent = Date.now();
  const r = await fetch(`${BASE}/api/t/${SLUG}/book/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ consent: true, consentVersion: '1', ...stay, name: 'Notify Walk', phone: '09180007711', email: guestEmail }),
  });
  const made = await r.json();
  if (r.status !== 201) throw new Error(`request ${r.status}: ${made.error}`);
  const ref = made.reference;

  // 2. Server → push service: the request was sent to BOTH devices and accepted.
  const sentTo = async (kind) => {
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      const { data: box } = await supabase.from('notification_outbox').select('sent_at').eq('tenant_id', tenant.id).eq('reference', ref).eq('kind', kind);
      if (box?.[0]?.sent_at) return box[0].sent_at;
      await sleep(1000);
    }
    return null;
  };
  {
    const at = await sentTo('request');
    const { data: subs } = await supabase.from('push_subscriptions').select('last_ok_at').eq('tenant_id', tenant.id).in('user_id', users);
    check(
      at !== null && (subs ?? []).length === 2 && subs.every((s) => s.last_ok_at && Date.parse(s.last_ok_at) >= sent - 1000),
      '2. the request is sent after the guest’s response, to both devices, and Google accepts both',
      `sent ${at ? Math.round((Date.parse(at) - sent) / 1000) + ' s after' : 'no'} · devices ok ${(subs ?? []).filter((s) => s.last_ok_at).length}`,
    );
  }


  // 3. A proof of payment: the owner hears it, staff does not.
  {
    const before = Object.fromEntries(((await supabase.from('push_subscriptions').select('user_id, last_ok_at').eq('tenant_id', tenant.id).in('user_id', users)).data ?? []).map((d) => [d.user_id, d.last_ok_at]));
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const form = new FormData();
    form.set('reference', ref);
    form.set('contact', guestEmail);
    form.set('method', 'GCash');
    form.set('amount', '100');
    form.set('paidOn', new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }));
    form.set('idempotencyKey', randomUUID());
    form.set('file', new Blob([PNG], { type: 'image/png' }), 'receipt.png');
    const p = await fetch(`${BASE}/api/t/${SLUG}/manage/proof`, { method: 'POST', body: form });
    const pb = await p.json();
    const at = await sentTo('proof');
    const { data: devs } = await supabase.from('push_subscriptions').select('user_id, last_ok_at').eq('tenant_id', tenant.id).in('user_id', users);
    // Sent to it now: its last answer moved since the snapshot taken before the proof.
    const okAfter = (d) => Boolean(d.last_ok_at) && d.last_ok_at !== before[d.user_id];
    const ownerDev = devs?.find((d) => d.user_id === people[0].userId);
    const staffDev = devs?.find((d) => d.user_id === people[1].userId);
    check(
      p.status === 201 && at !== null && ownerDev && okAfter(ownerDev) && staffDev && !okAfter(staffDev),
      '3. a proof is sent to the owner’s device only (staff’s was not sent to)',
      `proof ${p.status} ${pb.error ?? ''} · sent ${at !== null} · owner sent ${Boolean(ownerDev && okAfter(ownerDev))} · staff sent ${Boolean(staffDev && okAfter(staffDev))}`,
    );
  }

  // 4. The outbox recorded both as sent; both devices answered ok.
  {
    const { data: box } = await supabase.from('notification_outbox').select('kind, sent_at').eq('tenant_id', tenant.id).eq('reference', ref);
    const { data: subs } = await supabase.from('push_subscriptions').select('last_ok_at').eq('tenant_id', tenant.id).in('user_id', users);
    check(
      (box ?? []).length === 2 && box.every((b) => b.sent_at) && (subs ?? []).every((s) => s.last_ok_at),
      '4. the outbox marks the request and the proof sent; each device answered ok',
      JSON.stringify(box),
    );
  }
} catch (error) {
  check(false, 'walk', error.message);
} finally {
  for (const b of browsers) b.close();
  const { data: rows } = await supabase.from('bookings').select('group_id').eq('tenant_id', tenant.id).eq('guest_email', guestEmail);
  const groups = [...new Set((rows ?? []).map((r) => r.group_id))];
  if (groups.length) {
    const { data: proofs } = await supabase.from('payments').select('proof_path').eq('tenant_id', tenant.id).in('group_id', groups);
    const paths = (proofs ?? []).map((p) => p.proof_path).filter(Boolean);
    if (paths.length) {
      const { data: gone } = await supabase.storage.from('payment-proofs').remove(paths);
      if ((gone ?? []).length !== paths.length) console.log(`WARN  proof files removed ${(gone ?? []).length} of ${paths.length}`);
    }
    await supabase.from('bookings').delete().eq('tenant_id', tenant.id).in('group_id', groups);
    await supabase.from('stays').delete().eq('tenant_id', tenant.id).in('group_id', groups);
  }
  for (const id of users) await supabase.auth.admin.deleteUser(id);
  console.log(`cleaned: ${groups.length} stay(s), ${users.length} user(s)`);
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
