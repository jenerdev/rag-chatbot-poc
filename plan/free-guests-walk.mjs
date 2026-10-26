// free-guests-walk.mjs — D-147 (plan/free-guests.md), the walk: 7 checks on
// villa, HTTP and browser, against pnpm dev.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/free-guests-walk.mjs)
//
//   1. The platform route, on a throwaway tenant with its DPA signed:
//      free_up_to_age 18 is refused by the trigger in words; 3 is accepted
//      and read back on the tenant's record. (Villa's own config cannot go
//      through that route: its DPA is unsigned and the gate fires on the
//      upsert, so the walk sets villa's rule on the service client.)
//   2. The staff setup route carries freeUpToAge 3; the public quote with
//      1 free child prices exactly like the quote without, and every line
//      carries free 1 / 0.
//   3. The booking page at 375 draws the second field, "Children aged 3 and
//      below" (plan/free-guests/book-375.png).
//   4. A staff stay with 4 guests + 1 free child: the list carries 4 and 1,
//      the total is the quote's; the stay page (S-15) at 375 says
//      "4 guests + 1 child (free)" (plan/free-guests/stay-375.png), and so
//      does the staff list row.
//   5. The web door: a request with 2 guests + 2 free children; Manage
//      booking's lookup returns free 2 on the room line.
//   6. The chatbot's tool: the result carries the rule while villa has one.
//   7. Restored: the config back as it was; the tool result has no rule;
//      the setup route says null.
//
// Villa's bookings config is changed on the service client and put back
// EXACTLY as it was in finally; the throwaway tenant is deleted; the two stays, the throwaway member,
// the throwaway super user and their audit rows on villa are removed. Nothing
// reaches OpenAI: executeTool() runs the tool, never the model.
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { executeTool, loadTenant } from '../packages/rag/dist/index.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'free-guests');
mkdirSync(OUT, { recursive: true });
// A fresh address per run: the per-IP count outlives the process (D-137).
const ADDRESS = `10.47.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

let failures = 0;
const check = (ok, what, detail = '') => {
  failures += ok ? 0 : 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  — ${detail}` : ''}`);
};
async function call(method, path, { cookie, json } = {}) {
  const headers = { 'X-Forwarded-For': ADDRESS };
  if (cookie) headers.Cookie = cookie;
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const response = await fetch(`${BASE}${path}`, { method, headers, body });
  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    // not JSON
  }
  const setCookie = (response.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]);
  return { status: response.status, data, text, cookie: setCookie.find((c) => c.startsWith('rag_')) };
}
const err = (r) => (typeof r.data === 'object' && r.data ? r.data.error : String(r.data).slice(0, 80));
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const stamp = Date.now();
const setupToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
const users = [];
const groups = [];
let villa = null;
let savedConfig = null;
let probeTenantId = null;
let browser = null;
try {
  const { data: villaRow, error: villaError } = await supabase.from('tenants').select('id, slug').eq('slug', 'villa').single();
  if (villaError || !villaRow) throw new Error(`villa: ${villaError?.message ?? 'no row'}`);
  villa = villaRow;
  const { data: app, error: appError } = await supabase.from('tenant_applications').select('config').eq('tenant_id', villa.id).eq('application_key', 'bookings').single();
  if (appError) throw new Error(`villa's bookings config: ${appError.message}`);
  savedConfig = app.config;
  if (savedConfig.free_up_to_age !== undefined) throw new Error('villa already has free_up_to_age set; this walk expects none');

  // The throwaway super user and the throwaway villa admin, each logged in over HTTP.
  const makeUser = async (label) => {
    const email = `free-walk-${label}-${stamp}@example.com`;
    const password = randomBytes(18).toString('base64url');
    const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(`create ${label}: ${error.message}`);
    users.push(data.user.id);
    return { id: data.user.id, email, password };
  };
  const superUser = await makeUser('super');
  const { error: superError } = await supabase.from('platform_admins').insert({ user_id: superUser.id });
  if (superError) throw new Error(`platform_admins: ${superError.message}`);
  const platformLogin = await call('POST', '/api/platform/session', { json: { email: superUser.email, password: superUser.password } });
  const platformCookie = platformLogin.cookie;
  if (platformLogin.status !== 200 || !platformCookie) throw new Error(`platform login ${platformLogin.status}: ${err(platformLogin)}`);

  const admin = await makeUser('admin');
  const { error: memberError } = await supabase.from('memberships').insert({ user_id: admin.id, tenant_id: villa.id, role: 'admin' });
  if (memberError) throw new Error(`membership: ${memberError.message}`);
  const staffLogin = await call('POST', '/api/t/villa/admin/session', { json: { email: admin.email, password: admin.password } });
  const staffCookie = staffLogin.cookie;
  if (staffLogin.status !== 200 || !staffCookie) throw new Error(`staff login ${staffLogin.status}: ${err(staffLogin)}`);

  // 1. The platform route, on a throwaway tenant: 18 refused in the trigger's words, 3 accepted.
  {
    const slug = `free-walk-${randomBytes(3).toString('hex')}`;
    const created = await call('POST', '/api/platform/tenants', { cookie: platformCookie, json: { slug, businessName: 'Free Walk Resort', assistantName: 'Fay' } });
    probeTenantId = created.data?.id ?? null;
    if (!probeTenantId) throw new Error(`create tenant ${created.status}: ${err(created)}`);
    const signed = await call('PATCH', `/api/platform/tenants/${probeTenantId}`, { cookie: platformCookie, json: { dpaSignedOn: setupToday() } });
    if (signed.status !== 200) throw new Error(`sign the DPA ${signed.status}: ${err(signed)}`);
    const bad = await call('PUT', `/api/platform/tenants/${probeTenantId}/applications/bookings`, { cookie: platformCookie, json: { config: { timezone: 'Asia/Manila', free_up_to_age: 18 } } });
    const good = await call('PUT', `/api/platform/tenants/${probeTenantId}/applications/bookings`, { cookie: platformCookie, json: { config: { timezone: 'Asia/Manila', free_up_to_age: 3 } } });
    const stored = good.data?.applicationConfigs?.bookings?.free_up_to_age;
    check(
      bad.status >= 400 && bad.status < 500 && /free_up_to_age/.test(err(bad)) && good.status === 200 && stored === 3,
      '1. platform: free_up_to_age 18 refused in words, 3 accepted and read back on the record',
      `18 → ${bad.status} "${err(bad)}" · 3 → ${good.status}, stored ${JSON.stringify(stored)}`,
    );
  }

  // Villa's rule, on the service client (see the head), restored in finally.
  {
    const { error } = await supabase.from('tenant_applications').update({ config: { ...savedConfig, free_up_to_age: 3 } }).eq('tenant_id', villa.id).eq('application_key', 'bookings');
    if (error) throw new Error(`set villa's rule: ${error.message}`);
  }

  // The form's setup, and a free date: 120 days out, moved until the quote is available.
  const setup = await call('GET', '/api/t/villa/bookings/setup', { cookie: staffCookie });
  if (setup.status !== 200) throw new Error(`setup ${setup.status}: ${err(setup)}`);
  const unit = setup.data.units.find((u) => u.active);
  const slot = setup.data.slots.find((s) => s.nightly) ?? setup.data.slots[0];
  if (!unit || !slot) throw new Error('villa has no active unit or slot');
  let checkIn = addDays(setup.data.today, 120);
  let quote = null;
  for (let i = 0; i < 14 && !quote; i++) {
    const q = await call('POST', '/api/t/villa/book/quote', { json: { slotId: slot.id, rooms: [{ unitId: unit.id, guests: 4 }], checkIn, nights: 1 } });
    if (q.status === 200 && q.data.available) quote = q.data;
    else checkIn = addDays(checkIn, 1);
  }
  if (!quote) throw new Error('no available date found within two weeks of +120 days');

  // 2. The setup route and the public quote.
  {
    const withFree = await call('POST', '/api/t/villa/book/quote', { json: { slotId: slot.id, rooms: [{ unitId: unit.id, guests: 4, free: 1 }], checkIn, nights: 1 } });
    const bad = await call('POST', '/api/t/villa/book/quote', { json: { slotId: slot.id, rooms: [{ unitId: unit.id, guests: 4, free: 51 }], checkIn, nights: 1 } });
    check(
      setup.data.freeUpToAge === 3 && withFree.status === 200 && withFree.data.total === quote.total
        && withFree.data.lines.every((l) => l.free === 1) && quote.lines.every((l) => l.free === 0)
        && bad.status === 400 && /Free guests/.test(err(bad)),
      '2. setup says freeUpToAge 3; the quote with 1 free child equals the quote without, lines free 1 / 0; 51 is a 400 in words',
      `setup ${JSON.stringify(setup.data.freeUpToAge)} · ${quote.total} vs ${withFree.data?.total} · free ${withFree.data?.lines?.map((l) => l.free).join(',')} / ${quote.lines.map((l) => l.free).join(',')} · 51 → ${bad.status} "${err(bad)}"`,
    );
  }

  browser = await openBrowser({ scheme: 'light' });
  const { page } = browser;

  // 3. The booking page at 375: the second field, labelled.
  {
    await page.viewport(375);
    await page.goto(`${BASE}/t/villa/book`);
    await page.until("!!document.querySelector('#free-guests')", 30000);
    const label = await page.eval("document.querySelector('label[for=\"free-guests\"] > span')?.textContent ?? null");
    const hint = await page.eval("document.querySelector('.party-notice')?.textContent ?? null");
    // The Guests step is hidden until the stay is chosen; shown here for the photograph alone.
    await page.eval("document.querySelectorAll('.book-step').forEach((s) => { s.hidden = s.getAttribute('aria-labelledby') !== 'step-guests'; }); true");
    await page.shot(join(OUT, 'book-375.png'));
    check(
      label === 'Children aged 3 and below' && /^Children aged 3 and below stay free\. Enter them apart from the guests\./.test(hint ?? ''),
      '3. the booking page draws the free field with its label and the rule (plan/free-guests/book-375.png)',
      `label ${JSON.stringify(label)} · hint ${JSON.stringify(hint)}`,
    );
  }

  // 4. A staff stay: 4 guests + 1 free child; the list, the stay page, the list row.
  {
    const made = await call('POST', '/api/t/villa/bookings', {
      cookie: staffCookie,
      json: { slotId: slot.id, rooms: [{ unitId: unit.id, guests: 4, free: 1 }], checkIn, nights: 1, name: 'Free Walk Family', phone: '0917 555 0147', email: `free-walk-stay-${stamp}@example.com`, notes: null, promoId: null, walkIn: false },
    });
    if (made.status >= 300) throw new Error(`staff stay ${made.status}: ${err(made)}`);
    groups.push(made.data.groupId);
    const reference = made.data.bookings[0].reference;
    const list = await call('GET', `/api/t/villa/bookings/requests?from=${checkIn}`, { cookie: staffCookie });
    const row = (list.data ?? []).find((r) => r.reference === reference);
    const [name, value] = staffCookie.split('=');
    await page.send('Network.setCookie', { name, value, url: BASE });
    await page.viewport(375);
    await page.goto(`${BASE}/t/villa/admin/bookings/${reference}`);
    await page.until("(document.querySelector('.stay-head-sub')?.textContent ?? '').trim() !== ''", 30000);
    const head = await page.eval("document.querySelector('.stay-head-sub')?.textContent ?? null");
    await page.shot(join(OUT, 'stay-375.png'));
    await page.goto(`${BASE}/t/villa/admin/bookings`);
    await page.until(`[...document.querySelectorAll('.stay-row')].some((r) => r.textContent.includes(${JSON.stringify(reference)}))`, 30000);
    const rowText = await page.eval(`[...document.querySelectorAll('.stay-row')].find((r) => r.textContent.includes(${JSON.stringify(reference)}))?.querySelector('.stay-row-meta')?.textContent ?? null`);
    check(
      row?.units?.[0]?.guests === 4 && row.units[0].free === 1 && row.total === quote.total
        && /4 guests \+ 1 child \(free\)/.test(head ?? '') && /4 guests \+ 1 child \(free\)/.test(rowText ?? ''),
      '4. a staff stay with 4 + 1 free: listed as 4 and 1 at the quote\'s total; S-15 and the list row say "4 guests + 1 child (free)" (plan/free-guests/stay-375.png)',
      `${reference} · listed ${row?.units?.[0]?.guests}+${row?.units?.[0]?.free} total ${row?.total} (quote ${quote.total}) · head ${JSON.stringify(head)} · row ${JSON.stringify(rowText)}`,
    );
  }

  // 5. The web door and Manage booking.
  {
    const pub = await supabase.rpc('tenant_public', { p_slug: 'villa' });
    const version = pub.data?.[0]?.policy_version;
    const webDate = addDays(checkIn, 2);
    const email = `free-walk-web-${stamp}@example.com`;
    const made = await call('POST', '/api/t/villa/book/request', {
      json: { slotId: slot.id, rooms: [{ unitId: unit.id, guests: 2, free: 2 }], checkIn: webDate, nights: 1, name: 'Free Walk Web', phone: '0917 555 0148', email, notes: null, website: '', promoCode: null, consent: true, consentVersion: version },
    });
    let lookup = { status: 0, data: null };
    if (made.status < 300) {
      const { data: rows } = await supabase.from('bookings').select('group_id').eq('tenant_id', villa.id).eq('reference', made.data.reference).limit(1);
      if (rows?.[0]?.group_id) groups.push(rows[0].group_id);
      lookup = await call('POST', '/api/t/villa/manage', { json: { reference: made.data.reference, contact: email } });
    }
    check(
      made.status < 300 && made.data.lines.every((l) => l.free === 2 && l.guests === 2) && lookup.status === 200 && lookup.data?.stay?.rooms?.[0]?.free === 2 && lookup.data.stay.rooms[0].guests === 2,
      '5. the web door: a request with 2 + 2 free; Manage booking reads the party back as 2 guests and 2 free',
      `request ${made.status} ${made.status < 300 ? `${made.data.reference} lines free ${made.data.lines.map((l) => l.free).join(',')}` : `"${err(made)}"`} · lookup ${lookup.status} rooms ${JSON.stringify(lookup.data?.stay?.rooms)}`,
    );
  }

  // 6. The chatbot's tool, while villa has the rule.
  const tool = async () => {
    const tenant = await loadTenant('villa');
    const { record } = await executeTool(tenant, { id: 'walk', name: 'check_availability', arguments: JSON.stringify({ date_from: checkIn }) });
    return record.result;
  };
  {
    const result = await tool();
    check(
      result?.free_guests?.rule === 'Children aged 3 and below stay free.' && /not counted in guests/.test(result.free_guests.meaning ?? ''),
      '6. the tool result carries the rule and what guests means under it',
      JSON.stringify(result?.free_guests ?? null),
    );
  }

  // 7. Restored: no rule anywhere.
  {
    const back = await supabase.from('tenant_applications').update({ config: savedConfig }).eq('tenant_id', villa.id).eq('application_key', 'bookings').select('config');
    const result = await tool();
    const again = await call('GET', '/api/t/villa/bookings/setup', { cookie: staffCookie });
    check(
      !back.error && back.data?.[0]?.config?.free_up_to_age === undefined && result?.free_guests === undefined && again.data?.freeUpToAge === null,
      '7. the config put back: no free_up_to_age on the row, the tool result no rule, the setup route null',
      `restore ${back.error?.message ?? 'ok'} · tool ${JSON.stringify(result?.free_guests ?? null)} · setup ${JSON.stringify(again.data?.freeUpToAge)}`,
    );
  }
} catch (error) {
  check(false, 'setup', error.stack ?? error.message);
} finally {
  browser?.close();
  if (villa && savedConfig) {
    const { error } = await supabase.from('tenant_applications').update({ config: savedConfig }).eq('tenant_id', villa.id).eq('application_key', 'bookings');
    if (error) console.log(`WARN  could not restore villa's bookings config: ${error.message}`);
  }
  for (const group of groups) {
    // Bookings reference their stay (bookings_stay_fk): rows first, the stay after.
    for (const table of ['booking_events', 'bookings', 'stays']) {
      const { error } = await supabase.from(table).delete().eq('tenant_id', villa.id).eq('group_id', group);
      if (error) console.log(`WARN  ${table} for ${group}: ${error.message}`);
    }
  }
  if (probeTenantId) await supabase.from('tenants').delete().eq('id', probeTenantId);
  for (const id of users) {
    await supabase.from('audit_log').delete().eq('actor_user', id);
    await supabase.from('platform_admins').delete().eq('user_id', id);
    await supabase.from('memberships').delete().eq('user_id', id);
    const { error } = await supabase.auth.admin.deleteUser(id);
    if (error) console.log(`WARN  could not delete user ${id}: ${error.message}`);
  }
}
console.log(failures ? `\n${failures} FAILED` : '\nfree-guests walk: all 7 passed');
process.exit(failures ? 1 : 0);
