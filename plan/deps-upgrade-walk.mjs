// deps-upgrade-walk.mjs — Quinn's QA probe for the deps upgrade (T-013 / T-015:
// next 15.5.28, sharp 0.35.5, zod 4.6.7), over HTTP against a running pnpm dev.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/deps-upgrade-walk.mjs [base])
//
// The ORACLE is the zod 3 schemas at HEAD (git show HEAD:apps/web/lib/schemas.ts):
// every expected sentence below is the one that file's required_error /
// invalid_type_error / errorMap / .min / .max carried, or zod 3's own default
// wording (which v3Words reproduces). A route answers firstError(), the FIRST
// issue only, so each probe has exactly one thing wrong.
//
//   A. book/quote on villa (whole_resort) and alteza (per_room): a valid quote
//      200, then one wrong field at a time: 400 in the old words. 11 rooms and
//      100,000 rooms: the cap's sentence, and the big one timed.
//   B. book/request on villa, refusals only (each a 400 before any write):
//      name, consent, consentVersion. No valid request is sent (free-guests
//      walk check 5 makes one on villa; alteza has real push devices, so a
//      request there would ping a real phone).
//   C. The platform, on a THROWAWAY super user and tenant (removed by id,
//      trap 26): create refusals, Profile PATCH (suggested questions, the
//      strict object, retention), Applications config, Permissions rows;
//      each refused in the old words, each with its positive twin.
//   D. The sharp branch of the app icon: alteza's logo, 192 and 512, PNG of
//      that size, and the X-App-Icon-Tile header only the sharp branch sets.
//   E. Every page on next 15.5.28: the public ones, then a THROWAWAY owner of
//      villa (every admin page; S-5 a 404 on whole_resort) and of alteza (S-5),
//      logged in and out over HTTP; removed with their audit rows.
//
// Nothing reaches OpenAI. Every open-route call carries a fresh X-Forwarded-For.

import { randomBytes } from 'node:crypto';
import { supabase } from '../packages/db/dist/service.js';

const BASE = process.argv[2] ?? 'http://localhost:3000';
let failures = 0;
let passes = 0;
const check = (ok, what, detail = '') => {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  — ${detail}` : ''}`);
};
const freshIp = () => `10.${90 + Math.floor(Math.random() * 9)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function call(method, path, { cookie, json, raw } = {}) {
  const headers = { 'X-Forwarded-For': freshIp() };
  if (cookie) headers.Cookie = cookie;
  let body;
  if (json !== undefined || raw !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = raw ?? JSON.stringify(json);
  }
  const started = performance.now();
  const response = await fetch(`${BASE}${path}`, { method, headers, body });
  const text = await response.text();
  const ms = Math.round(performance.now() - started);
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    // not JSON
  }
  const setCookie = (response.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]);
  return { status: response.status, data, ms, cookie: setCookie.find((c) => c.startsWith('rag_')) };
}
const err = (r) => (typeof r.data === 'object' && r.data ? r.data.error : String(r.data).slice(0, 80));
const refused = (r, words) => r.status === 400 && err(r) === words;
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });

const users = [];
let probeTenantId = null;
try {
  // --- A. book/quote ----------------------------------------------------------
  const tenants = [
    // villa: whole_resort, unit 1; a date 120 days out, as the free-guests walk.
    { slug: 'villa', from: 120 },
    // alteza: per_room, max_advance_days 20; inside the horizon.
    { slug: 'alteza', from: 10 },
  ];
  for (const t of tenants) {
    const { data: row } = await supabase.from('tenants').select('id').eq('slug', t.slug).single();
    if (!row) throw new Error(`no tenant ${t.slug}`);
    const { data: units } = await supabase.from('units').select('id').eq('tenant_id', row.id).eq('active', true).order('id').limit(1);
    const { data: slots } = await supabase.from('slots').select('id, nightly').eq('tenant_id', row.id).eq('active', true).order('id');
    const unit = units?.[0];
    const slot = slots?.find((s) => s.nightly) ?? slots?.[0];
    if (!unit || !slot) throw new Error(`${t.slug} has no active unit or slot`);
    const base = { slotId: slot.id, rooms: [{ unitId: unit.id, guests: 2 }], checkIn: addDays(today, t.from), nights: 1 };
    const path = `/api/t/${t.slug}/book/quote`;

    const ok = await call('POST', path, { json: base });
    check(
      ok.status === 200 && typeof ok.data?.available === 'boolean' && Array.isArray(ok.data?.lines),
      `A ${t.slug}: a valid quote is a 200 with lines`,
      `${ok.status} available ${ok.data?.available} total ${ok.data?.total} lines ${ok.data?.lines?.length} ${ok.status !== 200 ? `"${err(ok)}"` : ''}`,
    );
    const stripped = await call('POST', path, { json: { ...base, extra: 1, price: 1 } });
    check(
      stripped.status === 200 && stripped.data?.total === ok.data?.total,
      `A ${t.slug}: unknown keys (extra, price) are stripped, as in zod 3: same 200 and total`,
      `${stripped.status} total ${stripped.data?.total}`,
    );
    const { checkIn: _c, ...noDate } = base;
    const { slotId: _s, ...noSlot } = base;
    const { rooms: _r, ...noRooms } = base;
    const probes = [
      ['checkIn missing', noDate, 'Choose a date'],
      ['checkIn a number', { ...base, checkIn: 20261201 }, 'Choose a date'],
      ['slotId missing', noSlot, 'Choose a booking slot'],
      ['slotId a string', { ...base, slotId: String(slot.id) }, 'Choose a booking slot'],
      ['rooms missing', noRooms, 'Choose what to book'],
      ['rooms not a list', { ...base, rooms: 'x' }, 'Choose what to book'],
      ['unitId missing', { ...base, rooms: [{ guests: 2 }] }, 'Choose what to book'],
      ['guests missing', { ...base, rooms: [{ unitId: unit.id }] }, 'Enter the number of guests'],
      ['free a string', { ...base, rooms: [{ unitId: unit.id, guests: 2, free: 'one' }] }, 'Free guests must be a number'],
      ['nights a string', { ...base, nights: '2' }, 'Nights must be a number'],
      ['promoCode a number', { ...base, promoCode: 5 }, 'The promo code must be text'],
      ['promoCode 33 characters', { ...base, promoCode: 'X'.repeat(33) }, 'That is not a promo code'],
      ['11 rooms', { ...base, rooms: Array.from({ length: 11 }, () => ({ unitId: unit.id, guests: 1 })) }, 'One request holds at most 10 rooms.'],
    ];
    for (const [label, body, words] of probes) {
      const r = await call('POST', path, { json: body });
      check(refused(r, words), `A ${t.slug}: ${label} → 400 "${words}"`, `${r.status} "${err(r)}"`);
    }
    const big = await call('POST', path, { raw: JSON.stringify({ ...base, rooms: Array.from({ length: 100000 }, () => ({})) }) });
    check(
      refused(big, 'One request holds at most 10 rooms.') && big.ms < 3000,
      `A ${t.slug}: 100,000 empty rooms → 400 in the cap's words, under 3 s (GHSA-mrhx-c7xc-m3w5)`,
      `${big.status} "${err(big)}" in ${big.ms} ms`,
    );
    const notJson = await call('POST', path, { raw: '{not json' });
    check(notJson.status === 400, `A ${t.slug}: a body that is not JSON → 400`, `${notJson.status} "${err(notJson)}"`);
  }

  // --- B. book/request refusals (villa) --------------------------------------
  {
    const { data: units } = await supabase.from('units').select('id').eq('tenant_id', 3).eq('active', true).limit(1);
    const req = {
      slotId: 2, rooms: [{ unitId: units?.[0]?.id ?? 1, guests: 2 }], checkIn: addDays(today, 121), nights: 1,
      name: 'Deps Walk', phone: '0917 555 0199', email: 'deps-walk@example.com', notes: null, website: '', promoCode: null,
      consent: true, consentVersion: '1',
    };
    const { name: _n, ...noName } = req;
    const { consentVersion: _v, ...noVersion } = req;
    const probes = [
      ['name missing', noName, 'Your name is required'],
      ['phone a number', { ...req, phone: 917 }, 'Your mobile number is required'],
      ['email missing', (({ email: _e, ...r }) => r)(req), 'Your email is required'],
      ['consent false', { ...req, consent: false }, 'Please read and agree to the Privacy Policy and Terms.'],
      ['consentVersion missing', noVersion, 'Please read and agree to the Privacy Policy and Terms.'],
      ['notes a number', { ...req, notes: 5 }, 'Notes must be text'],
    ];
    for (const [label, body, words] of probes) {
      const r = await call('POST', '/api/t/villa/book/request', { json: body });
      check(refused(r, words), `B villa request: ${label} → 400 "${words}"`, `${r.status} "${err(r)}"`);
    }
  }

  // --- C. the platform ---------------------------------------------------------
  {
    const email = `deps-walk-super-${Date.now()}@example.com`;
    const password = randomBytes(18).toString('base64url');
    const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(`create super: ${error.message}`);
    users.push(data.user.id);
    const { error: pe } = await supabase.from('platform_admins').insert({ user_id: data.user.id });
    if (pe) throw new Error(`platform_admins: ${pe.message}`);
    const login = await call('POST', '/api/platform/session', { json: { email, password } });
    const cookie = login.cookie;
    if (login.status !== 200 || !cookie) throw new Error(`platform login ${login.status}: ${err(login)}`);
    check(true, 'C platform login as a throwaway super user', `${login.status}`);

    const createProbes = [
      ['slug missing', { businessName: 'B', assistantName: 'A' }, 'A slug is required'],
      ['slug bad', { slug: '-Bad-', businessName: 'B', assistantName: 'A' }, 'A slug is 3–32 lower-case letters, digits and hyphens, not starting or ending with a hyphen'],
      ['businessName missing', { slug: 'deps-walk-x', assistantName: 'A' }, 'A business name is required'],
      ['assistantName empty', { slug: 'deps-walk-x', businessName: 'B', assistantName: '  ' }, 'An assistant name is required'],
    ];
    for (const [label, body, words] of createProbes) {
      const r = await call('POST', '/api/platform/tenants', { cookie, json: body });
      check(refused(r, words), `C create tenant: ${label} → 400 "${words}"`, `${r.status} "${err(r)}"`);
    }
    const slug = `deps-walk-${randomBytes(3).toString('hex')}`;
    const created = await call('POST', '/api/platform/tenants', { cookie, json: { slug, businessName: 'Deps Walk Resort', assistantName: 'Dee' } });
    probeTenantId = created.data?.id ?? null;
    check(created.status === 201 || created.status === 200, 'C create tenant: the valid one is made (twin)', `${created.status} id ${probeTenantId}`);
    if (!probeTenantId) throw new Error(`create tenant ${created.status}: ${err(created)}`);
    const tpath = `/api/platform/tenants/${probeTenantId}`;

    const patchProbes = [
      ['nothing', {}, 'Nothing to change'],
      ['an unknown key', { extra: 1 }, "Unrecognized key(s) in object: 'extra'"],
      ['7 suggested questions', { suggestedQuestions: Array.from({ length: 7 }, (_, i) => `Question ${i}?`) }, 'At most 6 suggested questions'],
      ['an empty suggested question', { suggestedQuestions: ['  '] }, 'A suggested question cannot be empty'],
      ['an empty list', { suggestedQuestions: [] }, 'Send null for no suggested questions'],
      ['a 121-character question', { suggestedQuestions: ['Q'.repeat(121)] }, 'A suggested question is at most 120 characters'],
      ['a number as a question', { suggestedQuestions: [5] }, 'Expected string, received number'],
      ['chat retention 10', { chatRetentionDays: 10 }, 'Chats are kept at least 30 days'],
      ['chat retention 30.5', { chatRetentionDays: 30.5 }, 'Expected integer, received float'],
      ['a bad DPA date', { dpaSignedOn: '28/10/2026' }, 'The DPA date is YYYY-MM-DD'],
      ['a bad privacy email', { privacyContactEmail: 'nope' }, 'The privacy contact is an email address'],
    ];
    for (const [label, body, words] of patchProbes) {
      const r = await call('PATCH', tpath, { cookie, json: body });
      check(refused(r, words), `C Profile PATCH: ${label} → 400 "${words}"`, `${r.status} "${err(r)}"`);
    }
    const sq = await call('PATCH', tpath, { cookie, json: { suggestedQuestions: ['  Do you have parking?  ', 'Is breakfast included?'] } });
    const { data: pub } = await supabase.rpc('tenant_public', { p_slug: slug });
    check(
      sq.status === 200 && JSON.stringify(pub?.[0]?.suggested_questions) === JSON.stringify(['Do you have parking?', 'Is breakfast included?']),
      'C Profile PATCH: two suggested questions saved, trimmed, read back by tenant_public() (twin)',
      `${sq.status} ${JSON.stringify(pub?.[0]?.suggested_questions)}`,
    );
    const clear = await call('PATCH', tpath, { cookie, json: { suggestedQuestions: null } });
    const { data: pub2 } = await supabase.rpc('tenant_public', { p_slug: slug });
    check(clear.status === 200 && pub2?.[0]?.suggested_questions == null, 'C Profile PATCH: null clears them', `${clear.status} ${JSON.stringify(pub2?.[0]?.suggested_questions)}`);

    const apath = `${tpath}/applications/bookings`;
    for (const [label, body] of [['config missing', {}], ['config a string', { config: 'x' }]]) {
      const r = await call('PUT', apath, { cookie, json: body });
      check(refused(r, 'A config object is required'), `C Applications PUT: ${label} → 400 "A config object is required"`, `${r.status} "${err(r)}"`);
    }
    const unsigned = await call('PUT', apath, { cookie, json: { config: { timezone: 'Asia/Manila' } } });
    check(
      unsigned.status >= 400 && unsigned.status < 500 && err(unsigned) !== 'A config object is required' && /DPA|dpa|data processing/i.test(err(unsigned) ?? ''),
      'C Applications PUT: a valid shape reaches Postgres, whose DPA gate answers in words (the shape passed zod)',
      `${unsigned.status} "${err(unsigned)}"`,
    );
    const signed = await call('PATCH', tpath, { cookie, json: { dpaSignedOn: today } });
    const on = await call('PUT', apath, { cookie, json: { config: { timezone: 'Asia/Manila', max_stay_nights: 5 } } });
    check(
      signed.status === 200 && on.status === 200 && on.data?.applicationConfigs?.bookings?.max_stay_nights === 5,
      'C Applications PUT: with the DPA signed, the Bookings card saves and reads back (twin)',
      `dpa ${signed.status} · put ${on.status} ${JSON.stringify(on.data?.applicationConfigs?.bookings ?? err(on))}`,
    );

    const ppath = `${tpath}/permissions`;
    const row = { role: 'staff', permission: 'documents:read', allowed: false };
    const permProbes = [
      ['rows missing', {}, 'The rows are required'],
      ['rows a string', { rows: 'x' }, 'The rows are a list'],
      ['an unknown role', { rows: [{ ...row, role: 'god' }] }, 'The role is one of owner, admin, staff'],
      ['a fixed permission', { rows: [{ ...row, permission: 'session' }] }, 'That permission cannot be changed per tenant'],
      ['allowed a string', { rows: [{ ...row, allowed: 'yes' }] }, 'allowed is true or false'],
    ];
    for (const [label, body, words] of permProbes) {
      const r = await call('PUT', ppath, { cookie, json: body });
      check(refused(r, words), `C Permissions PUT: ${label} → 400 "${words}"`, `${r.status} "${err(r)}"`);
    }
    const saved = await call('PUT', ppath, { cookie, json: { rows: [row] } });
    const { data: stored } = await supabase.from('role_permissions').select('role, permission, allowed').eq('tenant_id', probeTenantId);
    check(
      saved.status === 200 && stored?.length === 1 && stored[0].role === 'staff' && stored[0].permission === 'documents:read' && stored[0].allowed === false,
      'C Permissions PUT: one valid row saved and stored (twin)',
      `${saved.status} stored ${JSON.stringify(stored)}`,
    );
  }

  // --- D. the sharp branch of the app icon ------------------------------------
  for (const size of [192, 512]) {
    const r = await fetch(`${BASE}/t/alteza/app-icon.png?size=${size}`);
    const bytes = Buffer.from(await r.arrayBuffer());
    const png = bytes.subarray(1, 4).toString() === 'PNG';
    const w = png ? bytes.readUInt32BE(16) : 0;
    const h = png ? bytes.readUInt32BE(20) : 0;
    const tile = r.headers.get('x-app-icon-tile');
    check(
      r.status === 200 && r.headers.get('content-type') === 'image/png' && png && w === size && h === size && !!tile,
      `D alteza app-icon ?size=${size}: a ${size}×${size} PNG drawn by sharp (X-App-Icon-Tile present)`,
      `${r.status} ${r.headers.get('content-type')} ${w}×${h} ${bytes.length} B · tile ${JSON.stringify(tile)}`,
    );
  }

  // --- E. every page answers on next 15.5.28 ----------------------------------
  // The public pages; then a throwaway OWNER of villa (whole_resort) logs in and
  // GETs every admin page (S-5 must 404 there), and of alteza for S-5 alone.
  for (const [path, want] of [
    ['/', 200], ['/platform', 200], ['/t/villa', 200], ['/t/villa/book', 200], ['/t/villa/manage', 200],
    ['/t/villa/privacy', 200], ['/t/villa/terms', 200], ['/t/alteza/book', 200], ['/t/no-such-tenant-x', 404],
    ['/t/villa/manifest.webmanifest', 200], ['/t/villa/sw.js', 200],
  ]) {
    const r = await fetch(`${BASE}${path}`);
    await r.arrayBuffer();
    check(r.status === want, `E public ${path} → ${want}`, `${r.status}`);
  }
  for (const [slug, pages] of [
    ['villa', [
      ['dashboard', 200], ['bookings', 200], ['calendar', 200], ['payments', 200], ['notifications', 200],
      ['conversations', 200], ['unanswered', 200], ['documents', 200], ['holidays', 200], ['slots', 200],
      ['promos', 200], ['members', 200], ['activity', 200], ['accommodations', 404],
    ]],
    ['alteza', [['accommodations', 200]]],
  ]) {
    const { data: t } = await supabase.from('tenants').select('id').eq('slug', slug).single();
    const email = `deps-walk-owner-${slug}-${Date.now()}@example.com`;
    const password = randomBytes(18).toString('base64url');
    const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(`create owner: ${error.message}`);
    users.push(data.user.id);
    const { error: me } = await supabase.from('memberships').insert({ user_id: data.user.id, tenant_id: t.id, role: 'owner' });
    if (me) throw new Error(`membership: ${me.message}`);
    const login = await call('POST', `/api/t/${slug}/admin/session`, { json: { email, password } });
    check(login.status === 200 && !!login.cookie, `E ${slug}: a staff (owner) login sets the cookie`, `${login.status}`);
    for (const [page, want] of pages) {
      const r = await fetch(`${BASE}/t/${slug}/admin/${page}`, { headers: { Cookie: login.cookie } });
      const html = await r.text();
      check(r.status === want && (want !== 200 || html.includes('</html>')), `E ${slug}: /admin/${page} → ${want}`, `${r.status} ${html.length} B`);
    }
    const out = await call('DELETE', `/api/t/${slug}/admin/session`, { cookie: login.cookie });
    check(out.status < 300, `E ${slug}: log out`, `${out.status}`);
  }
} catch (error) {
  check(false, 'setup', error.stack ?? error.message);
} finally {
  if (probeTenantId) {
    await supabase.from('audit_log').delete().eq('tenant_id', probeTenantId);
    const { error } = await supabase.from('tenants').delete().eq('id', probeTenantId);
    if (error) console.log(`WARN  could not delete tenant ${probeTenantId}: ${error.message}`);
  }
  for (const id of users) {
    await supabase.from('audit_log').delete().eq('actor_user', id);
    await supabase.from('platform_admins').delete().eq('user_id', id);
    await supabase.from('memberships').delete().eq('user_id', id);
    const { error } = await supabase.auth.admin.deleteUser(id);
    if (error) console.log(`WARN  could not delete user ${id}: ${error.message}`);
  }
}
console.log(failures ? `\n${passes} passed, ${failures} FAILED` : `\ndeps-upgrade walk: all ${passes} passed`);
process.exit(failures ? 1 : 0);
