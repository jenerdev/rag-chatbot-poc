// manage-booking-phase2-walk.mjs — the Manage booking route and page over
// HTTP, against a running dev server (plan/manage-booking.md Phase 2).
//
// On harbor: one web stay made by request_booking() (as the tools' service
// client, the way the battery seeds), with a fresh contact; one staff stay
// with no contact at all. Then, as a stranger with no cookie:
//   - the right reference + email finds the stay, and + phone (typed another
//     way) finds the same one; the JSON carries no email, phone, notes or
//     staff note, even after staff decided it with a note;
//   - a wrong email, an unknown reference and the no-contact stay are all
//     the SAME 404 sentence;
//   - northwind (no bookings application) is a 404, route and page;
//   - the page pre-fills a well-formed ?ref= and drops a malformed one;
//   - a body that is not text is a 400.
// Both stays are hard-deleted at the end.
//
// Each run sends its own X-Forwarded-For, so the per-IP window (10 per 10
// minutes, in memory) never carries over from a previous run.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/manage-booking-phase2-walk.mjs [base-url])

import { randomInt } from 'node:crypto';
import { supabase } from '../packages/db/dist/service.js';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const IP = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`;
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

const lookup = async (slug, body) => {
  const r = await fetch(`${BASE}/api/t/${slug}/manage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': IP },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
};
const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

const { data: harbor } = await supabase.from('tenants').select('id').eq('slug', 'harbor').single();
const { data: rate } = await supabase
  .from('unit_rates')
  .select('unit_id, slot_id, units!inner(active), slots!inner(active)')
  .eq('tenant_id', harbor.id)
  .eq('units.active', true)
  .eq('slots.active', true)
  .limit(1)
  .single();

const stamp = Date.now();
const email = `manage-walk-${stamp}@example.com`;
const phone = `09${String(randomInt(1e9)).padStart(9, '0')}`;
const groups = [];

try {
  // A web stay, 150+ days ahead, on the first date that is not taken or closed.
  let web = null;
  for (let d = 150; d < 180 && !web; d++) {
    const day = new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
    const { data, error } = await supabase.rpc('request_booking', {
      p_tenant_id: harbor.id, p_slot_id: rate.slot_id, p_unit_ids: [rate.unit_id], p_guests: [1],
      p_check_in: day, p_nights: 1, p_name: 'Manage Walk', p_phone: phone, p_email: email, p_notes: 'walk: a guest note',
    });
    if (!error) web = data[0];
  }
  if (!web) throw new Error('could not make a web stay in 30 days of tries');
  const { data: webRow } = await supabase.from('bookings').select('group_id').eq('tenant_id', harbor.id).eq('reference', web.reference).limit(1).single();
  groups.push(webRow.group_id);

  // A staff stay with no contact: nothing to match.
  const { data: staffRow, error: staffError } = await supabase
    .from('bookings')
    .insert({ tenant_id: harbor.id, unit_id: rate.unit_id, slot_id: rate.slot_id, booked_date: '2027-09-01', guest_name: 'Walk-in', guest_count: 1, status: 'pending' })
    .select('group_id, reference')
    .single();
  if (staffError) throw new Error(`staff stay: ${staffError.message}`);
  groups.push(staffRow.group_id);

  // Staff decide the web stay with a note the guest must not see.
  await supabase.from('bookings').update({ status: 'confirmed', decision_note: 'internal: VIP walk' }).eq('tenant_id', harbor.id).eq('group_id', webRow.group_id);

  // 1. Found by email (case and spaces aside), and by phone typed as +63.
  {
    const a = await lookup('harbor', { reference: ` ${web.reference.toLowerCase()} `, contact: email.toUpperCase() });
    const b = await lookup('harbor', { reference: web.reference, contact: `+63 ${phone.slice(1, 4)} ${phone.slice(4, 7)} ${phone.slice(7)}` });
    const s = json(a.text)?.stay;
    check(
      a.status === 200 && s?.reference === web.reference && s.status === 'confirmed' && s.guestStatus === 'confirmed' && s.rooms?.length === 1
        && b.status === 200 && json(b.text)?.stay?.reference === web.reference,
      'the right reference + email, and + phone typed another way, find the stay',
      `email ${a.status} ${s?.guestStatus} rooms ${s?.rooms?.length} · phone ${b.status}`,
    );
    const leaks = [email, phone, 'walk: a guest note', 'internal: VIP walk', 'guest_email', 'guest_phone', 'decision_note', 'notes'].filter((x) => a.text.toLowerCase().includes(x.toLowerCase()));
    check(leaks.length === 0, 'the answer carries no email, phone, notes or staff note', leaks.length ? `found: ${leaks.join(', ')}` : `${a.text.length} bytes, none found`);
  }

  // 2. Every miss is the same 404 sentence.
  {
    const wrong = await lookup('harbor', { reference: web.reference, contact: 'someone.else@example.com' });
    const unknown = await lookup('harbor', { reference: 'HAR-ZZZZZZ', contact: email });
    const noContact = await lookup('harbor', { reference: staffRow.reference, contact: email });
    const texts = [wrong, unknown, noContact].map((r) => r.text);
    check(
      [wrong, unknown, noContact].every((r) => r.status === 404) && new Set(texts).size === 1 && json(texts[0])?.error?.startsWith('We could not find that booking'),
      'a wrong email, an unknown reference and a stay with no contact are the same 404 sentence',
      `${wrong.status}/${unknown.status}/${noContact.status} · ${new Set(texts).size} distinct · ${json(texts[0])?.error}`,
    );
  }

  // 3. Northwind has no bookings application: the route and the page are 404.
  {
    const route = await lookup('northwind', { reference: web.reference, contact: email });
    const page = await fetch(`${BASE}/t/northwind/manage`);
    check(route.status === 404 && page.status === 404, 'northwind (no bookings): the route and the page are 404', `route ${route.status} · page ${page.status}`);
  }

  // 4. The page pre-fills a well-formed ?ref= and drops a malformed one.
  {
    // The reference input's own tag (every Next page has <script> tags of
    // its own, so "no <script> anywhere" proves nothing).
    const field = (html) => /<input[^>]*id="reference"[^>]*>/.exec(html)?.[0] ?? '';
    const good = field(await (await fetch(`${BASE}/t/harbor/manage?ref=${web.reference.toLowerCase()}`)).text());
    const bad = field(await (await fetch(`${BASE}/t/harbor/manage?ref=%3Cscript%3E`)).text());
    check(
      good.includes(`value="${web.reference}"`) && bad !== '' && bad.includes('value=""'),
      'the page pre-fills a well-formed ?ref= (upper-cased) and drops a malformed one',
      `good ${good.match(/value="[^"]*"/)?.[0]} · bad ${bad.match(/value="[^"]*"/)?.[0]}`,
    );
  }

  // 5. A body that is not text is a 400 in words; the page itself is 200.
  {
    const notText = await lookup('harbor', { reference: 7, contact: email });
    const noBody = await lookup('harbor', 'not json');
    const page = await fetch(`${BASE}/t/harbor/manage`);
    check(
      notText.status === 400 && noBody.status === 400 && page.status === 200,
      'a reference that is not text, and no JSON at all, are 400; the page is 200',
      `${notText.status} ${json(notText.text)?.error} · ${noBody.status} · page ${page.status}`,
    );
  }
} catch (error) {
  check(false, 'walk setup', error.message);
} finally {
  for (const g of groups) {
    const { error, count } = await supabase.from('bookings').delete({ count: 'exact' }).eq('tenant_id', harbor.id).eq('group_id', g);
    console.log(error ? `WARN  could not delete group ${g}: ${error.message}` : `cleanup: ${count} row(s) of ${g} deleted`);
  }
}

console.log(failures ? `\n${failures} WALK CHECK(S) FAILED` : '\nALL WALK CHECKS PASS');
process.exit(failures ? 1 : 0);
