// manage-booking-phase4-walk.mjs — S-14's routes over HTTP, against a running
// dev server (plan/manage-booking.md Phase 4).
//
// On a THROWAWAY tenant, `manage-walk-4`, made here and deleted at the end,
// with an ADMIN and a STAFF member who log in through /admin/session like a
// person. A guest (no cookie) sends a proof through /manage/proof; then:
//   1. both roles see it in the queue; the staff member's Verify is a 403
//      that names the permission; the proof's signed URL serves the bytes;
//   2. the admin rejects it with a reason; the guest sees the reason and
//      sends a second proof;
//   3. the admin verifies-and-confirms: the stay is confirmed, the payment
//      verified; reviewing it again is a 409;
//   4. the admin records a refund; the history lists every step with who
//      did it (guest, staff) in order;
//   5. settings: staff's PUT is a 403, the admin's is saved, a bad shape is
//      a 400 in the database's words.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/manage-booking-phase4-walk.mjs [base-url])

import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { supabase } from '../packages/db/dist/service.js';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const IP = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`;
const SLUG = 'manage-walk-4';
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const email = `walk4-${Date.now()}@example.com`;
const phone = `09${String(randomInt(1e9)).padStart(9, '0')}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const users = [];
let tenantId = null;
let reference = null;

async function member(role) {
  const address = `walk4-${role}-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email: address, password, email_confirm: true });
  if (error) throw new Error(error.message);
  users.push(data.user.id);
  const m = await supabase.from('memberships').insert({ user_id: data.user.id, tenant_id: tenantId, role });
  if (m.error) throw new Error(m.error.message);
  const login = await fetch(`${BASE}/api/t/${SLUG}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: address, password }) });
  const cookie = (login.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0];
  if (!cookie) throw new Error(`${role} login failed: ${login.status}`);
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}/api/t/${SLUG}${path}`, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { id: data.user.id, call };
}

async function sendProof(amount) {
  const form = new FormData();
  for (const [k, v] of Object.entries({ reference, contact: email, method: 'GCash', amount, paidOn: today, payerReference: '', idempotencyKey: randomUUID() })) form.append(k, v);
  form.append('file', new Blob([PNG], { type: 'image/png' }), 'receipt.png');
  const r = await fetch(`${BASE}/api/t/${SLUG}/manage/proof`, { method: 'POST', headers: { 'x-forwarded-for': IP }, body: form });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function guestView() {
  const r = await fetch(`${BASE}/api/t/${SLUG}/manage`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': IP }, body: JSON.stringify({ reference, contact: phone }) });
  return (await r.json().catch(() => null))?.stay;
}

try {
  const { data: t, error: tError } = await supabase.from('tenants').insert({ slug: SLUG, business_name: 'Manage Walk 4', assistant_name: 'Walk' }).select('id').single();
  if (tError) throw new Error(`tenant: ${tError.message}`);
  tenantId = t.id;
  const app = await supabase.from('tenant_applications').insert({
    tenant_id: tenantId, application_key: 'bookings',
    config: { timezone: 'Asia/Manila', booking_type: 'per_room', payments: { methods: [{ kind: 'gcash', label: 'GCash', account_number: '0917 000 0000' }], fee: { kind: 'fixed', value: 50000 } } },
  });
  if (app.error) throw new Error(`application: ${app.error.message}`);
  const { data: unit } = await supabase.from('units').insert({ tenant_id: tenantId, name: 'Room', capacity: 2, sort_order: 1, active: true }).select('id').single();
  const { data: slot } = await supabase.from('slots').insert({ tenant_id: tenantId, name: 'Day', start_time: '08:00', duration: '8 hours' }).select('id').single();
  await supabase.from('unit_rates').insert({ tenant_id: tenantId, unit_id: unit.id, slot_id: slot.id, weekday_price: 200000, weekend_price: 200000 });
  const { data: rows, error: reqError } = await supabase.rpc('request_booking', {
    p_tenant_id: tenantId, p_slot_id: slot.id, p_unit_ids: [unit.id], p_guests: [1], p_check_in: new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10), p_nights: 1,
    p_name: 'Walk Four', p_phone: phone, p_email: email, p_notes: null,
  });
  if (reqError) throw new Error(`request_booking: ${reqError.message}`);
  reference = rows[0].reference;
  const admin = await member('admin');
  const staff = await member('staff');

  // 1. The queue, the staff 403, the signed URL.
  const first = await sendProof('500');
  {
    const a = await admin.call('GET', '/payments?which=open');
    const s = await staff.call('GET', '/payments?which=open');
    const p = a.body?.[0];
    const denied = await staff.call('PATCH', `/payments/${p?.id}`, { action: 'verify', amount: '500', accountChecked: true, confirm: true });
    const url = await staff.call('GET', `/payments/${p?.id}/proof`);
    const bytes = url.body?.url ? Buffer.from(await (await fetch(url.body.url)).arrayBuffer()) : null;
    check(
      first.status === 201 && a.status === 200 && a.body.length === 1 && p.reference === reference && p.payment.status === 'submitted'
        && s.status === 200 && s.body.length === 1 && denied.status === 403 && /payments:write/.test(denied.body?.error ?? '') && bytes?.equals(PNG),
      "both roles see the proof; staff's Verify is a 403 naming payments:write; the signed URL serves the exact bytes",
      `proof ${first.status} · admin ${a.status}/${a.body?.length} · staff ${s.status}/${s.body?.length} · denied ${denied.status} "${denied.body?.error}" · bytes ${bytes?.length}`,
    );
  }

  // 2. Reject with a reason; the guest reads it and sends again.
  {
    const p = (await admin.call('GET', '/payments?which=open')).body[0];
    const r = await admin.call('PATCH', `/payments/${p.id}`, { action: 'reject', note: 'The screenshot is cut off. Please send the whole receipt.' });
    const view = await guestView();
    const again = await sendProof('500');
    check(
      r.status === 200 && view?.payment?.status === 'rejected' && view.payments?.[0]?.rejectionReason?.startsWith('The screenshot is cut off') && again.status === 201,
      'the admin rejects with a reason; the guest reads it and can send another proof',
      `reject ${r.status} · guest ${view?.payment?.status} "${view?.payments?.[0]?.rejectionReason}" · again ${again.status}`,
    );
  }

  // 3. Verify and confirm; a second review is a 409.
  {
    const p = (await admin.call('GET', '/payments?which=open')).body[0];
    const r = await admin.call('PATCH', `/payments/${p.id}`, { action: 'verify', amount: '500.00', accountChecked: true, confirm: true });
    const { data: stay } = await supabase.from('bookings').select('status').eq('tenant_id', tenantId).eq('reference', reference);
    const twice = await admin.call('PATCH', `/payments/${p.id}`, { action: 'verify', amount: '500', accountChecked: true });
    const view = await guestView();
    check(
      r.status === 200 && r.body?.confirmed === true && stay?.every((b) => b.status === 'confirmed') && twice.status === 409
        && view?.status === 'confirmed' && view.payment.status === 'partially_paid' && view.payment.received === 50000,
      'verify-and-confirm confirms the stay; the guest sees it confirmed and 500.00 received; reviewing again is a 409',
      `${r.status} ${JSON.stringify(r.body)} · rows ${stay?.map((b) => b.status).join(',')} · twice ${twice.status} · guest ${view?.status}/${view?.payment?.status}`,
    );
  }

  // 4. A refund, and the history with every step and who did it.
  {
    const p = (await admin.call('GET', '/payments?which=all')).body.find((x) => x.status === 'verified');
    const refund = await admin.call('POST', '/payments/refund', { groupId: p.groupId, amount: '100', method: 'GCash', note: 'Walk: partial refund' });
    const h = await staff.call('GET', `/stays/${p.groupId}/history`);
    const steps = (h.body ?? []).map((e) => `${e.kind}:${e.to}:${e.actor}`);
    // The stay was made by the tools' service client here, so its creation is 'system'; from the booking page it is 'guest'.
    const want = ['created:pending:system', 'payment:payment:submitted:guest', 'payment:payment:rejected:staff', 'payment:payment:submitted:guest', 'payment:payment:verified:staff', 'status:confirmed:staff', 'payment:refund:verified:staff'];
    check(
      refund.status === 201 && JSON.stringify(steps) === JSON.stringify(want) && h.body.filter((e) => e.actor === 'staff').every((e) => e.actorUser === admin.id),
      'the admin records a refund; the history lists all seven steps in order, each with its actor (staff = the admin)',
      `refund ${refund.status} · ${steps.join(' | ')}`,
    );
  }

  // 5. Settings by role.
  {
    const body = { settings: { methods: [{ kind: 'bank', label: 'BDO', accountNumber: '0000-1111' }], fee: { kind: 'percent', value: 2500 }, payWithinHours: 12, reviewWithinHours: 24, terms: 'Walk terms' } };
    const denied = await staff.call('PUT', '/payments/settings', body);
    const saved = await admin.call('PUT', '/payments/settings', body);
    const bad = await admin.call('PUT', '/payments/settings', { settings: { ...body.settings, payWithinHours: 500 } });
    const read = await staff.call('GET', '/payments/settings');
    check(
      denied.status === 403 && saved.status === 200 && saved.body?.settings?.methods?.[0]?.label === 'BDO' && saved.body.settings.fee.value === 2500
        && bad.status === 400 && /pay_within_hours/.test(bad.body?.error ?? '') && read.body?.settings?.terms === 'Walk terms',
      "settings: staff's PUT is a 403; the admin's is saved and staff can read it; a bad value is a 400 in the database's words",
      `staff ${denied.status} · admin ${saved.status} · bad ${bad.status} "${bad.body?.error}" · read ${read.body?.settings?.terms}`,
    );
  }
} catch (error) {
  check(false, 'walk setup', error.message);
} finally {
  if (tenantId) {
    const { data: objects } = await supabase.storage.from('payment-proofs').list(`${tenantId}/incoming`, { limit: 1000 });
    const paths = (objects ?? []).map((o) => `${tenantId}/incoming/${o.name}`);
    const { data: removed } = paths.length ? await supabase.storage.from('payment-proofs').remove(paths) : { data: [] };
    console.log(`cleanup: ${removed?.length ?? 0} of ${paths.length} proof objects removed`);
    const { error } = await supabase.from('tenants').delete().eq('id', tenantId);
    console.log(error ? `WARN  could not delete ${SLUG}: ${error.message}` : `cleanup: tenant ${SLUG} deleted`);
  }
  for (const id of users) await supabase.auth.admin.deleteUser(id);
  console.log(`cleanup: ${users.length} users deleted`);
}

console.log(failures ? `\n${failures} WALK CHECK(S) FAILED` : '\nALL WALK CHECKS PASS');
process.exit(failures ? 1 : 0);
