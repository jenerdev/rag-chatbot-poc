// manage-booking-phase3-walk.mjs — the proof route over HTTP, against a
// running dev server (plan/manage-booking.md Phase 3).
//
// On a THROWAWAY tenant, `manage-walk`, made here and deleted at the end (the
// cascade takes its stays and payments; its proof objects are removed through
// the Storage API and counted): payment settings at 30 %, one room, one slot,
// one web stay made by request_booking(). Then, as a stranger with no cookie:
//   1. the lookup shows the stay unpaid, 300.00 needed, two ways to pay;
//   2. a PNG sent as "receipt.pdf" with type application/pdf is stored as
//      what its bytes are (201), and the lookup then says "submitted";
//   3. the same idempotency key again is the same payment (201, same id);
//   4. a second proof with a new key is a 409 in words, and uploads nothing;
//   5. a 6 MiB file is a 400 before the body is read; an HTML file is a 400;
//   6. the wrong contact is the lookup's own 404 sentence.
// No real tenant's settings are touched.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/manage-booking-phase3-walk.mjs [base-url])

import { randomInt, randomUUID } from 'node:crypto';
import { supabase } from '../packages/db/dist/service.js';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const IP = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`;
const SLUG = 'manage-walk';
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const email = `walk-payer-${Date.now()}@example.com`;
const phone = `09${String(randomInt(1e9)).padStart(9, '0')}`;

const lookup = async (contact) => {
  const r = await fetch(`${BASE}/api/t/${SLUG}/manage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': IP },
    body: JSON.stringify({ reference, contact }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const send = async ({ file, name, type, key = randomUUID(), contact = email, amount = '300' }) => {
  const form = new FormData();
  for (const [k, v] of Object.entries({ reference, contact, method: 'GCash', amount, paidOn: today, payerReference: 'TXN-WALK', idempotencyKey: key })) form.append(k, v);
  form.append('file', new Blob([file], { type }), name);
  const r = await fetch(`${BASE}/api/t/${SLUG}/manage/proof`, { method: 'POST', headers: { 'x-forwarded-for': IP }, body: form });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const proofCount = async () => (await supabase.from('payments').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId)).count;

let tenantId = null;
let reference = null;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

try {
  const { data: t, error: tError } = await supabase.from('tenants').insert({ slug: SLUG, business_name: 'Manage Walk', assistant_name: 'Walk' }).select('id').single();
  if (tError) throw new Error(`tenant: ${tError.message}`);
  tenantId = t.id;
  const app = await supabase.from('tenant_applications').insert({
    tenant_id: tenantId, application_key: 'bookings',
    config: {
      timezone: 'Asia/Manila', booking_type: 'per_room',
      payments: {
        methods: [{ kind: 'gcash', label: 'GCash', account_name: 'Manage Walk', account_number: '0917 000 0000' }, { kind: 'bank', label: 'BPI', account_number: '1234-5678' }],
        fee: { kind: 'percent', value: 3000 },
      },
    },
  });
  if (app.error) throw new Error(`application: ${app.error.message}`);
  const { data: unit } = await supabase.from('units').insert({ tenant_id: tenantId, name: 'Room', capacity: 2, sort_order: 1, active: true }).select('id').single();
  const { data: slot } = await supabase.from('slots').insert({ tenant_id: tenantId, name: 'Day', start_time: '08:00', duration: '8 hours' }).select('id').single();
  const rate = await supabase.from('unit_rates').insert({ tenant_id: tenantId, unit_id: unit.id, slot_id: slot.id, weekday_price: 100000, weekend_price: 100000 });
  if (rate.error) throw new Error(`rate: ${rate.error.message}`);
  const day = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  const { data: rows, error: reqError } = await supabase.rpc('request_booking', {
    p_tenant_id: tenantId, p_slot_id: slot.id, p_unit_ids: [unit.id], p_guests: [1], p_check_in: day, p_nights: 1,
    p_name: 'Walk Payer', p_phone: phone, p_email: email, p_notes: null,
  });
  if (reqError) throw new Error(`request_booking: ${reqError.message}`);
  reference = rows[0].reference;

  // 1. Unpaid, 300.00 needed, two ways to pay.
  {
    const r = await lookup(email);
    const p = r.body?.stay?.payment;
    check(
      r.status === 200 && p?.status === 'unpaid' && p.required === 30000 && r.body.stay.pay?.methods?.length === 2,
      'the lookup shows the stay unpaid, 300.00 needed to confirm, two ways to pay',
      `${r.status} ${JSON.stringify(p)} methods ${r.body?.stay?.pay?.methods?.length}`,
    );
  }

  // 2. A PNG named receipt.pdf: stored as a PNG, by its bytes.
  const key = randomUUID();
  let firstId = null;
  {
    const r = await send({ file: PNG, name: 'receipt.pdf', type: 'application/pdf', key });
    firstId = r.body?.paymentId ?? null;
    const { data: row } = await supabase.from('payments').select('proof_path, claimed_amount, status').eq('tenant_id', tenantId).single();
    const after = await lookup(phone);
    check(
      r.status === 201 && typeof firstId === 'number' && row?.proof_path?.endsWith('.png') && row.claimed_amount === 30000 && row.status === 'submitted'
        && after.body?.stay?.payment?.status === 'submitted' && after.body.stay.payments?.length === 1,
      'a PNG sent as "receipt.pdf" is stored as a .png (its bytes decide); the guest then sees it being checked',
      `${r.status} ${JSON.stringify(r.body)} · ${row?.proof_path} ${row?.claimed_amount} · then ${after.status} ${JSON.stringify(after.body).slice(0, 300)}`,
    );
  }

  // 3. The same key again: the same payment.
  {
    const r = await send({ file: PNG, name: 'receipt.png', type: 'image/png', key });
    check(r.status === 201 && r.body?.paymentId === firstId && (await proofCount()) === 1, 'the same idempotency key again is the same payment, one row', `${r.status} ${JSON.stringify(r.body)} rows ${await proofCount()}`);
  }

  // 4. A second proof while one is open: 409 in words, nothing uploaded.
  {
    const before = (await supabase.storage.from('payment-proofs').list(`${tenantId}/incoming`)).data?.length;
    const r = await send({ file: PNG, name: 'second.png', type: 'image/png' });
    const after = (await supabase.storage.from('payment-proofs').list(`${tenantId}/incoming`)).data?.length;
    check(
      r.status === 409 && /already being checked/.test(r.body?.error ?? '') && before === after && (await proofCount()) === 1,
      'a second proof while one is being checked is a 409 in words, and uploads nothing',
      `${r.status} "${r.body?.error}" · objects ${before} → ${after}`,
    );
  }

  // 5. Too large, and not an image or PDF.
  {
    const big = await send({ file: Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]), name: 'big.png', type: 'image/png' });
    const html = await send({ file: Buffer.from('<html><script>alert(1)</script></html>'), name: 'receipt.jpg', type: 'image/jpeg' });
    check(
      big.status === 400 && /too large/.test(big.body?.error ?? '') && html.status === 400 && /JPG, PNG or WebP/.test(html.body?.error ?? ''),
      'a 6 MiB file and an HTML file named .jpg are 400s in words',
      `big ${big.status} "${big.body?.error}" · html ${html.status} "${html.body?.error}"`,
    );
  }

  // 6. The wrong contact: the lookup's own sentence.
  {
    const r = await send({ file: PNG, name: 'x.png', type: 'image/png', contact: 'someone.else@example.com' });
    const l = await lookup('someone.else@example.com');
    check(r.status === 404 && r.body?.error === l.body?.error && l.status === 404, "the wrong contact is the lookup's own 404 sentence", `${r.status} "${r.body?.error}" · lookup ${l.status} "${l.body?.error}"`);
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
}

console.log(failures ? `\n${failures} WALK CHECK(S) FAILED` : '\nALL WALK CHECKS PASS');
process.exit(failures ? 1 : 0);
