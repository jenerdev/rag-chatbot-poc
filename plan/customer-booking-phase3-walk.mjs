// customer-booking-phase3-walk.mjs — the new routes over HTTP, against a
// running `pnpm dev` (plan/customer-booking.md Phase 3, "done when").
//
// Creates, and deletes at the end:
//   * `walk-book`, a per_room tenant: a nightly Night slot, two rooms with
//     rates, and a staff user (random password, never printed);
//   * `walk-other`, a second per_room tenant with its own staff user, for the
//     cross-tenant checks.
// Villa, harbor and Northwind are only called on routes that write nothing.
//
// Every refusal has its positive twin (CLAUDE.md trap 12). The service client
// is used ONLY to set up, look and clean up, never to do the thing tested.
// Each call to the open request route carries its own X-Forwarded-For, so the
// in-memory per-IP limit (lib/rate-limit.ts) is exercised only by check 9.
//
//   cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/customer-booking-phase3-walk.mjs [base-url]

import { randomBytes } from 'node:crypto';
import { supabase } from '../packages/db/dist/service.js';

const BASE = process.argv[2] ?? 'http://localhost:3000';
let failures = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  — ${detail}`);
  if (!ok) failures++;
};

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** The first date at or after `offset` days out on ISO weekday `iso` (1 = Monday). */
const first = (offset, iso) => {
  for (let i = offset; ; i++) {
    const d = addDays(today, i);
    if ((new Date(`${d}T00:00:00Z`).getUTCDay() || 7) === iso) return d;
  }
};
const THU = first(60, 4);
const PEAK = first(90, 4);

let ip = 0;
/** fetch; returns status and parsed body. */
async function call(method, slug, path, { cookie, json, xff } = {}) {
  const headers = { 'X-Forwarded-For': xff ?? `walk-${++ip}` };
  if (cookie) headers.Cookie = cookie;
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const response = await fetch(`${BASE}/api/t/${slug}${path}`, { method, headers, body });
  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    // not JSON; keep the text
  }
  return { status: response.status, data };
}

const made = { tenants: [], users: [] };
async function makeTenant(slug) {
  const { data, error } = await supabase
    .from('tenants')
    .insert({ slug, business_name: `walk ${slug}`, assistant_name: 'Probe' })
    .select('id, slug')
    .single();
  if (error) throw new Error(`create ${slug}: ${error.message}`);
  made.tenants.push(data.id);
  await supabase
    .from('tenant_applications')
    .insert({ tenant_id: data.id, application_key: 'bookings', config: { timezone: 'Asia/Manila', booking_type: 'per_room' } });
  const { data: slot } = await supabase
    .from('slots')
    .insert({ tenant_id: data.id, name: 'Night', start_time: '14:00', duration: '22 hours', nightly: true })
    .select('id')
    .single();
  // Every row carries every key (CLAUDE.md trap 15).
  const { data: units } = await supabase
    .from('units')
    .insert([
      { tenant_id: data.id, name: 'Garden Room', capacity: 2, standard_capacity: 2, extra_person_rate: 25000, sort_order: 1, active: true },
      { tenant_id: data.id, name: 'Family Room', capacity: 6, standard_capacity: 2, extra_person_rate: 25000, sort_order: 2, active: true },
    ])
    .select('id, name');
  const unit = Object.fromEntries(units.map((u) => [u.name, u.id]));
  await supabase.from('unit_rates').insert([
    { tenant_id: data.id, unit_id: unit['Garden Room'], slot_id: slot.id, weekday_price: 350000, weekend_price: 450000, holiday_price: null },
    { tenant_id: data.id, unit_id: unit['Family Room'], slot_id: slot.id, weekday_price: 600000, weekend_price: 750000, holiday_price: null },
  ]);

  const email = `walk-${slug}-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data: user, error: userError } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (userError) throw new Error(`user for ${slug}: ${userError.message}`);
  made.users.push(user.user.id);
  await supabase.from('memberships').insert({ user_id: user.user.id, tenant_id: data.id, role: 'admin' });
  const login = await fetch(`${BASE}/api/t/${slug}/admin/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  if (login.status !== 200 || !cookie) throw new Error(`login ${slug}: ${login.status}`);
  return { id: data.id, slug, slotId: slot.id, unit, cookie };
}

try {
  const book = await makeTenant('walk-book');
  const other = await makeTenant('walk-other');
  const contact = (n) => ({ name: 'Walk Probe', phone: `0918000${String(n).padStart(4, '0')}`, email: `walk-${n}@example.com` });
  const stay = (overrides = {}) => ({
    slotId: book.slotId,
    rooms: [{ unitId: book.unit['Family Room'], guests: 3 }],
    checkIn: THU,
    nights: 2,
    ...contact(1),
    ...overrides,
  });
  const rowsFor = async (email) =>
    (await supabase.from('bookings').select('id, status, source').eq('tenant_id', book.id).eq('guest_email', email)).data ?? [];

  // 1. No staff cookie: every staff route is 401. The two open routes are
  //    not (their twin): a quote is 200 without any cookie.
  {
    const staff = await Promise.all([
      call('GET', book.slug, '/bookings/requests'),
      call('PATCH', book.slug, '/bookings/requests/00000000-0000-0000-0000-000000000000', { json: { action: 'confirm' } }),
      call('GET', book.slug, '/holidays'),
      call('PUT', book.slug, '/holidays', { json: { day: PEAK, label: 'x' } }),
      call('DELETE', book.slug, `/holidays/${PEAK}`),
      call('POST', book.slug, '/holidays/copy', { json: { days: [PEAK], toYear: 2030 } }),
    ]);
    const open = await call('POST', book.slug, '/book/quote', { json: stay() });
    check(
      staff.every((r) => r.status === 401) && open.status === 200,
      'no cookie: staff routes 401, the open quote 200',
      `${staff.map((r) => r.status).join(' ')} · quote ${open.status}`,
    );
  }

  // 2. The open routes still resolve the tenant: an unknown slug is 404, and
  //    so is a tenant without bookings (northwind), before any work.
  {
    const unknown = await call('POST', 'no-such-tenant', '/book/quote', { json: stay() });
    const northwind = await call('POST', 'northwind', '/book/quote', { json: stay() });
    check(unknown.status === 404 && northwind.status === 404, 'open quote: unknown tenant and a tenant without bookings are 404', `${unknown.status} · northwind ${northwind.status}`);
  }

  // 3. The quote: 3 guests in the Family Room (standard 2), Thursday then
  //    Friday: 600000 + 25000, then 750000 + 25000.
  {
    const q = await call('POST', book.slug, '/book/quote', { json: stay() });
    const got = (q.data.lines ?? []).map((l) => `${l.date} ${l.basePrice}+${l.extraGuestPrice}+${l.surcharge}=${l.price}`).join(', ');
    check(
      q.status === 200 && q.data.total === 1400000 && q.data.available === true
        && got === `${THU} 600000+25000+0=625000, ${addDays(THU, 1)} 750000+25000+0=775000`,
      'open quote: a 2-night stay priced night by night',
      `${q.status} ${got} · total ${q.data.total}`,
    );
  }

  // 4. The request: 201 with a receipt; the stored rows are pending/web. A
  //    filled honeypot is 400 and saves nothing; a bad phone is 400 with the
  //    package's message; a wrong type is zod's 400.
  {
    const ok = await call('POST', book.slug, '/book/request', { json: stay() });
    const rows = await rowsFor('walk-1@example.com');
    const honey = await call('POST', book.slug, '/book/request', { json: stay({ ...contact(2), website: 'http://spam.example' }) });
    const honeyRows = await rowsFor('walk-2@example.com');
    const phone = await call('POST', book.slug, '/book/request', { json: stay({ ...contact(3), phone: '02 8123 4567' }) });
    const type = await call('POST', book.slug, '/book/request', { json: stay({ nights: 'two' }) });
    check(
      ok.status === 201 && /^WAL-[A-Z2-9]{6}$/.test(ok.data.reference) && ok.data.total === 1400000
        && rows.length === 2 && rows.every((r) => r.status === 'pending' && r.source === 'web')
        && honey.status === 400 && honeyRows.length === 0 && phone.status === 400 && /mobile number/.test(phone.data.error) && type.status === 400,
      'open request: 201 and 2 pending rows; honeypot, bad phone and bad type are 400s',
      `${ok.status} ${ok.data.reference} ${ok.data.total} · rows ${rows.map((r) => r.status).join(',')} · honeypot ${honey.status} (${honeyRows.length} rows) · phone ${phone.status} "${phone.data.error}" · type ${type.status} "${type.data.error}"`,
    );
  }

  // 5. Staff see it, with guest data; another tenant's staff cookie is 401.
  let groupId;
  {
    const list = await call('GET', book.slug, `/bookings/requests?from=${THU}`, { cookie: book.cookie });
    const mine = (list.data ?? []).find((r) => r.guestEmail === 'walk-1@example.com');
    groupId = mine?.groupId;
    const foreign = await call('GET', book.slug, '/bookings/requests', { cookie: other.cookie });
    check(
      list.status === 200 && mine?.status === 'pending' && mine.nights === 2 && mine.guestPhone === '09180000001' && foreign.status === 401,
      'staff list: the request with guest data; the other tenant\'s cookie is 401',
      `${list.status} ${mine?.reference} ${mine?.status} ${mine?.nights}n ${mine?.guestPhone} · other cookie ${foreign.status}`,
    );
  }

  // 6. Decide: a second request for the same nights is accepted; confirm the
  //    first, 200 (and 200 again); then confirming the second is 409 and it
  //    stays pending;
  //    declining it is 200. Another tenant's staff get 404 for our id; a bad
  //    id is 400; a bad action is 400.
  {
    // Sent BEFORE the first is confirmed: a request holds nothing, so it is
    // accepted; after the confirm it would be refused up front (check 7).
    const second = await call('POST', book.slug, '/book/request', { json: stay(contact(4)) });
    const confirm = await call('PATCH', book.slug, `/bookings/requests/${groupId}`, { cookie: book.cookie, json: { action: 'confirm' } });
    const again = await call('PATCH', book.slug, `/bookings/requests/${groupId}`, { cookie: book.cookie, json: { action: 'confirm' } });
    const secondId = ((await call('GET', book.slug, `/bookings/requests?from=${THU}`, { cookie: book.cookie })).data ?? []).find(
      (r) => r.guestEmail === 'walk-4@example.com',
    )?.groupId;
    const clash = await call('PATCH', book.slug, `/bookings/requests/${secondId}`, { cookie: book.cookie, json: { action: 'confirm' } });
    const stillPending = (await rowsFor('walk-4@example.com')).map((r) => r.status).join(',');
    const decline = await call('PATCH', book.slug, `/bookings/requests/${secondId}`, { cookie: book.cookie, json: { action: 'decline' } });
    const crossTenant = await call('PATCH', other.slug, `/bookings/requests/${groupId}`, { cookie: other.cookie, json: { action: 'decline' } });
    const badId = await call('PATCH', book.slug, '/bookings/requests/not-a-uuid', { cookie: book.cookie, json: { action: 'confirm' } });
    const badAction = await call('PATCH', book.slug, `/bookings/requests/${groupId}`, { cookie: book.cookie, json: { action: 'approve' } });
    const firstStatus = (await rowsFor('walk-1@example.com')).map((r) => r.status).join(',');
    check(
      confirm.status === 200 && again.status === 200 && second.status === 201 && clash.status === 409 && stillPending === 'pending,pending'
        && decline.status === 200 && crossTenant.status === 404 && badId.status === 400 && badAction.status === 400
        && firstStatus === 'confirmed,confirmed',
      'decide: confirm 200/200; a clashing confirm 409, unchanged; decline 200; cross-tenant 404; bad id and action 400',
      `${confirm.status}/${again.status} · second ${second.status} · clash ${clash.status} "${clash.data.error}" → ${stillPending} · decline ${decline.status} · cross ${crossTenant.status} · bad id ${badId.status} · bad action ${badAction.status} "${badAction.data.error}" · first ${firstStatus}`,
    );
  }

  // 7. A request for a night now confirmed is refused up front, 409.
  {
    const late = await call('POST', book.slug, '/book/request', { json: stay(contact(5)) });
    const rows = await rowsFor('walk-5@example.com');
    check(late.status === 409 && rows.length === 0, 'open request: a confirmed night is 409, nothing saved', `${late.status} "${late.data.error}" · rows ${rows.length}`);
  }

  // 8. Holidays: PUT a peak day with ₱1,000; the open quote now carries it;
  //    another tenant's staff do not see it; copy to next year; DELETE 200
  //    then 404; a bad kind is 400.
  {
    const put = await call('PUT', book.slug, '/holidays', { cookie: book.cookie, json: { day: PEAK, kind: 'peak', label: 'Walk peak', surcharge: 100000 } });
    const list = await call('GET', book.slug, `/holidays?from=${PEAK}&to=${PEAK}`, { cookie: book.cookie });
    const otherList = await call('GET', other.slug, `/holidays?from=${PEAK}&to=${PEAK}`, { cookie: other.cookie });
    const q = await call('POST', book.slug, '/book/quote', { json: stay({ checkIn: PEAK, nights: 1 }) });
    const line = q.data.lines?.[0];
    const year = Number(PEAK.slice(0, 4)) + 1;
    const copy = await call('POST', book.slug, '/holidays/copy', { cookie: book.cookie, json: { days: [PEAK], toYear: year } });
    const del = await call('DELETE', book.slug, `/holidays/${PEAK}`, { cookie: book.cookie });
    const delAgain = await call('DELETE', book.slug, `/holidays/${PEAK}`, { cookie: book.cookie });
    const badKind = await call('PUT', book.slug, '/holidays', { cookie: book.cookie, json: { day: PEAK, kind: 'festival', label: 'x' } });
    check(
      put.status === 200 && list.data?.length === 1 && otherList.status === 200 && otherList.data.length === 0
        && line?.surcharge === 100000 && line.basePrice === 750000 && line.holiday === 'Walk peak'
        && copy.status === 200 && copy.data[0]?.day === `${year}${PEAK.slice(4)}` && del.status === 200 && delAgain.status === 404 && badKind.status === 400,
      'holidays: set, listed, priced (holiday = weekend rate + surcharge), copied, removed; other tenant sees none',
      `put ${put.status} · list ${list.data?.length} · other ${otherList.data?.length} · quote ${line?.basePrice}+${line?.extraGuestPrice}+${line?.surcharge} "${line?.holiday}" · copy ${copy.status} ${copy.data[0]?.day} · delete ${del.status}/${delAgain.status} · bad kind ${badKind.status}`,
    );
  }

  // 9. The limits. Per contact (SQL): contact 6's 4th open request is 429.
  //    Per IP (memory): 10 requests from one address, then the 11th is 429
  //    with the IP message, before any database work (all 10 are bad phones,
  //    so nothing is saved either way).
  {
    const codes = [];
    for (const offset of [120, 130, 140, 150]) {
      codes.push((await call('POST', book.slug, '/book/request', { json: stay({ checkIn: first(offset, 1), nights: 1, ...contact(6) }) })).status);
    }
    const perIp = [];
    for (let i = 0; i < 11; i++) {
      perIp.push((await call('POST', book.slug, '/book/request', { xff: 'walk-same-ip', json: stay({ ...contact(7), phone: 'bad' }) })).status);
    }
    const last = await call('POST', book.slug, '/book/request', { xff: 'walk-same-ip', json: stay({ ...contact(7), phone: 'bad' }) });
    check(
      codes.join(',') === '201,201,201,429' && perIp.slice(0, 10).every((s) => s === 400) && perIp[10] === 429 && /Too many requests/.test(last.data.error),
      'limits: the 4th open request per contact is 429; the 11th call per IP in 10 minutes is 429',
      `contact ${codes.join(',')} · ip ${perIp.join(',')} "${last.data.error}"`,
    );
  }

  // 10. Rates accept a holiday price through the existing route.
  {
    const r = await call('PUT', book.slug, `/accommodations/${book.unit['Garden Room']}/rates`, {
      cookie: book.cookie,
      json: { rates: [{ slotId: book.slotId, weekdayPrice: 350000, weekendPrice: 450000, holidayPrice: 500000 }] },
    });
    check(r.status === 200 && r.data.rates?.[0]?.holidayPrice === 500000, 'rates route: a holiday price is stored and returned', `${r.status} ${r.data.rates?.[0]?.holidayPrice ?? r.data.error}`);
  }
} finally {
  for (const id of made.users) await supabase.auth.admin.deleteUser(id);
  if (made.tenants.length) await supabase.from('tenants').delete().in('id', made.tenants);
}

console.log(failures === 0 ? '\nALL PHASE 3 WALK CHECKS PASS' : `\n${failures} WALK CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
