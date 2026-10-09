// manage-booking-phase6-walk.mjs — change requests over HTTP, against a
// running dev server (plan/manage-booking.md Phase 6, walked in Phase 8).
//
// On a THROWAWAY tenant, `manage-walk-6`, made here and deleted at the end,
// with an ADMIN and a STAFF member who log in like people. Policy: 7+ days
// ahead refunds 100 %, date changes until 3 days before. One confirmed web
// stay (made by request_booking() and confirmed by the tools' client), then:
//   1. the guest's cancel quote (a dry run) says the refund, and stores nothing;
//   2. the guest asks to move: the quote, then the request (201); a second
//      request is a 409 in words; the guest withdraws it, and asks again;
//   3. staff see it and their Approve is a 403; the admin approves: the guest
//      then sees the new date, the same reference, and the difference owed;
//   4. the stay's history lists the request and the decision with their actors.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/manage-booking-phase6-walk.mjs [base-url])

import { randomBytes, randomInt } from 'node:crypto';
import { supabase } from '../packages/db/dist/service.js';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const IP = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`;
const SLUG = 'manage-walk-6';
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

const email = `walk6-${Date.now()}@example.com`;
const phone = `09${String(randomInt(1e9)).padStart(9, '0')}`;
const users = [];
let tenantId = null;
let reference = null;

// A Monday ~60 days ahead, and the Saturday and the Monday after it.
const monday = (() => {
  const d = new Date(Date.now() + 60 * 86400000);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7));
  return d;
})();
const iso = (d, plus = 0) => new Date(d.getTime() + plus * 86400000).toISOString().slice(0, 10);
const CHECK_IN = iso(monday);
const SATURDAY = iso(monday, 5);
const NEXT_MONDAY = iso(monday, 7);

async function member(role) {
  const address = `walk6-${role}-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email: address, password, email_confirm: true });
  if (error) throw new Error(error.message);
  users.push(data.user.id);
  const m = await supabase.from('memberships').insert({ user_id: data.user.id, tenant_id: tenantId, role });
  if (m.error) throw new Error(m.error.message);
  const login = await fetch(`${BASE}/api/t/${SLUG}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: address, password }) });
  const cookie = (login.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0];
  if (!cookie) throw new Error(`${role} login failed: ${login.status}`);
  return {
    id: data.user.id,
    call: async (method, path, body) => {
      const r = await fetch(`${BASE}/api/t/${SLUG}${path}`, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
  };
}
const guest = async (path, body) => {
  const r = await fetch(`${BASE}/api/t/${SLUG}/manage${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': IP }, body: JSON.stringify({ reference, contact: email, ...body }) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

try {
  const { data: t, error: tError } = await supabase.from('tenants').insert({ slug: SLUG, business_name: 'Manage Walk 6', assistant_name: 'Walk' }).select('id').single();
  if (tError) throw new Error(`tenant: ${tError.message}`);
  tenantId = t.id;
  const app = await supabase.from('tenant_applications').insert({
    tenant_id: tenantId, application_key: 'bookings',
    config: {
      timezone: 'Asia/Manila', booking_type: 'per_room',
      payments: { methods: [{ kind: 'gcash', label: 'GCash' }], fee: { kind: 'full' }, cancellation: [{ days_before: 7, refund_percent: 100 }], reschedule_until_days_before: 3 },
    },
  });
  if (app.error) throw new Error(`application: ${app.error.message}`);
  const { data: unit } = await supabase.from('units').insert({ tenant_id: tenantId, name: 'Room', capacity: 2, sort_order: 1, active: true }).select('id').single();
  const { data: slot } = await supabase.from('slots').insert({ tenant_id: tenantId, name: 'Day', start_time: '08:00', duration: '8 hours' }).select('id').single();
  await supabase.from('unit_rates').insert({ tenant_id: tenantId, unit_id: unit.id, slot_id: slot.id, weekday_price: 100000, weekend_price: 150000 });
  const { data: rows, error: reqError } = await supabase.rpc('request_booking', {
    p_tenant_id: tenantId, p_slot_id: slot.id, p_unit_ids: [unit.id], p_guests: [1], p_check_in: CHECK_IN, p_nights: 1,
    p_name: 'Walk Six', p_phone: phone, p_email: email, p_notes: null,
  });
  if (reqError) throw new Error(`request_booking: ${reqError.message}`);
  reference = rows[0].reference;
  const confirmed = await supabase.from('bookings').update({ status: 'confirmed', decision_note: 'Walk: paid at the desk' }).eq('tenant_id', tenantId).eq('reference', reference);
  if (confirmed.error) throw new Error(`confirm: ${confirmed.error.message}`);
  const admin = await member('admin');
  const staff = await member('staff');

  // 1. The cancel quote stores nothing.
  {
    const q = await guest('/change', { kind: 'cancel', dryRun: true });
    const { count } = await supabase.from('change_requests').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId);
    check(q.status === 200 && q.body?.kind === 'cancel' && q.body.refundDue === 0 && count === 0, 'the cancel quote (a dry run) answers and stores nothing', `${q.status} ${JSON.stringify(q.body)} · stored ${count}`);
  }

  // 2. Quote a move, ask, a second ask is a 409, withdraw, ask again.
  {
    const quote = await guest('/change', { kind: 'reschedule', newCheckIn: SATURDAY, dryRun: true });
    const ask = await guest('/change', { kind: 'reschedule', newCheckIn: SATURDAY, reason: 'Walk: the weekend suits us' });
    const second = await guest('/change', { kind: 'cancel' });
    const withdrawn = await guest('/change/withdraw', {});
    const again = await guest('/change', { kind: 'reschedule', newCheckIn: SATURDAY });
    check(
      quote.status === 200 && quote.body?.quotedPrice === 150000 && quote.body.quotedDifference === 50000
        && ask.status === 201 && second.status === 409 && /already have a request/.test(second.body?.error ?? '')
        && withdrawn.status === 200 && withdrawn.body?.withdrawn === true && again.status === 201,
      'the guest quotes a move (+500.00), asks, is refused a second request (409), withdraws, and asks again',
      `quote ${quote.status} ${quote.body?.quotedDifference} · ask ${ask.status} · second ${second.status} "${second.body?.error}" · withdraw ${withdrawn.body?.withdrawn} · again ${again.status}`,
    );
  }

  // 3. Staff 403; the admin approves; the guest sees the new date.
  let groupId = null;
  {
    const list = await staff.call('GET', '/payments/changes?which=open');
    const req = list.body?.[0];
    groupId = req?.groupId ?? null;
    const denied = await staff.call('PATCH', `/payments/changes/${req?.id}`, { action: 'approve' });
    const ok = await admin.call('PATCH', `/payments/changes/${req?.id}`, { action: 'approve', note: null });
    const after = await fetch(`${BASE}/api/t/${SLUG}/manage`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': IP }, body: JSON.stringify({ reference, contact: phone }) });
    const stay = (await after.json())?.stay;
    check(
      list.status === 200 && list.body.length === 1 && req.kind === 'reschedule' && denied.status === 403 && ok.status === 200
        && stay?.checkIn === SATURDAY && stay.reference === reference && stay.status === 'confirmed' && stay.payment.outstanding === 150000,
      "staff see the request but cannot approve (403); the admin approves; the guest sees Saturday, the same reference, 1,500.00 owed",
      `list ${list.status}/${list.body?.length} · staff ${denied.status} · admin ${ok.status} · guest ${stay?.checkIn} ${stay?.reference} ${stay?.status} owed ${stay?.payment?.outstanding}`,
    );
  }

  // 4. The history: the ask, the withdrawal, the second ask, the approval, with actors.
  {
    const h = await admin.call('GET', `/stays/${groupId}/history`);
    const changes = (h.body ?? []).filter((e) => e.kind === 'change').map((e) => `${e.to}:${e.actor}`);
    check(
      JSON.stringify(changes) === JSON.stringify(['reschedule:pending:guest', 'reschedule:withdrawn:guest', 'reschedule:pending:guest', 'reschedule:approved:staff']),
      'the history lists the ask, the withdrawal, the second ask and the approval, each with its actor',
      changes.join(' | '),
    );
  }
} catch (error) {
  check(false, 'walk setup', error.message);
} finally {
  if (tenantId) {
    const { error } = await supabase.from('tenants').delete().eq('id', tenantId);
    console.log(error ? `WARN  could not delete ${SLUG}: ${error.message}` : `cleanup: tenant ${SLUG} deleted`);
  }
  for (const id of users) await supabase.auth.admin.deleteUser(id);
  console.log(`cleanup: ${users.length} users deleted`);
}

console.log(failures ? `\n${failures} WALK CHECK(S) FAILED` : '\nALL WALK CHECKS PASS');
process.exit(failures ? 1 : 0);
