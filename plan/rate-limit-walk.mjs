// rate-limit-walk.mjs — the shared rate limit over HTTP (plan/rate-limit.md
// Phase 4, D-137), against `pnpm dev`.
//
// Every section sends its own fresh X-Forwarded-For (lib/rate-limit.ts trusts
// it locally), because the count now OUTLIVES the process (§ 2.1): a second
// run inside ten minutes would otherwise start already refused. The proof
// that the count is in Postgres and not in memory is the table itself: the
// service client reads the row the calls made, with the count they sent.
//
// Run (in packages/db, so ../dist resolves):
//   node --conditions=react-server --env-file=../../.env ../../plan/rate-limit-walk.mjs [base]

import { randomUUID } from 'node:crypto';
import { supabase } from '../packages/db/dist/service.js';

const BASE = process.argv[2] ?? 'http://localhost:3000';
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

const run = Date.now() % 250;
let n = 0;
const fresh = () => `10.7.${run}.${++n}`;
const post = (slug, path, body, ip) =>
  fetch(`${BASE}/api/t/${slug}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
const windowRows = async (tenantId, key) => {
  const { data, error } = await supabase.from('rate_windows').select('key, count, window_start').eq('tenant_id', tenantId).eq('key', key);
  if (error) throw new Error(`rate_windows: ${error.message}`);
  return data;
};

const { data: villa, error: vErr } = await supabase.from('tenants').select('id, slug').eq('slug', 'villa').single();
if (vErr || !villa) throw new Error(`villa: ${vErr?.message ?? 'missing'}`);

const conversations = [];
const seeded = [];
try {
  // 1. The chat: 30 greetings from one address are 200 (answered in code, no
  //    OpenAI), the 31st is a 429 with the sentence; the table holds the
  //    address's row at 31 and the tenant's ceiling row bumped 30 times (a
  //    refused address does not bump it).
  {
    const ip = fresh();
    const statuses = [];
    let last = null;
    for (let i = 0; i < 31; i++) {
      const res = await post('villa', 'chat', { message: 'hello' }, ip);
      statuses.push(res.status);
      last = await res.json().catch(() => ({}));
      if (last?.conversationId) conversations.push(last.conversationId);
    }
    const mine = await windowRows(villa.id, `chat|${villa.id}|${ip}`);
    const ceiling = await windowRows(villa.id, `chat|${villa.id}|*`);
    const ceilingBefore = ceiling[0]?.count ?? 0;
    check(
      statuses.slice(0, 30).every((s) => s === 200) && statuses[30] === 429 && /Too many questions/.test(last?.error ?? '')
        && mine.length === 1 && mine[0].count === 31,
      '1. chat: 30 turns from one address are 200, the 31st is a 429 in words; the table holds the address at 31',
      `statuses ${[...new Set(statuses)].join(',')} · last ${last?.error ?? JSON.stringify(last).slice(0, 60)} · rows ${mine.length} count ${mine[0]?.count}`,
    );

    // 2. A second address on the same tenant is fresh.
    const other = await post('villa', 'chat', { message: 'hello' }, fresh());
    const body = await other.json().catch(() => ({}));
    if (body?.conversationId) conversations.push(body.conversationId);
    check(other.status === 200, '2. a second address on the same tenant is fresh (200)', `${other.status}`);

    // 3. The ceiling counts allowed turns only: 30 from the first address + 1
    //    from the second, not the refused 31st.
    const after = await windowRows(villa.id, `chat|${villa.id}|*`);
    check(
      after.length === 1 && after[0].count === ceilingBefore + 1 && ceilingBefore >= 30,
      "3. the tenant's ceiling row counts allowed turns only (not the refused one)",
      `before ${ceilingBefore} · after ${after[0]?.count}`,
    );
  }

  // 4. The ceiling: with the tenant's row at 600 for the current window, a
  //    NEW address is refused in the same words, and no conversation is made.
  //    Seeded on the service client, removed in finally.
  {
    const key = `chat|${villa.id}|*`;
    const rows = await windowRows(villa.id, key);
    const current = rows[0];
    if (!current) throw new Error('ceiling row missing after step 1');
    const bump = await supabase.from('rate_windows').update({ count: 600 }).eq('tenant_id', villa.id).eq('key', key).eq('window_start', current.window_start).select('count');
    if (bump.error) throw new Error(`seed: ${bump.error.message}`);
    seeded.push({ key, window_start: current.window_start, count: current.count });
    const { count: before } = await supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('tenant_id', villa.id);
    const res = await post('villa', 'chat', { message: 'hello' }, fresh());
    const body = await res.json().catch(() => ({}));
    const { count: afterCount } = await supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('tenant_id', villa.id);
    check(
      res.status === 429 && /Too many questions/.test(body?.error ?? '') && afterCount === before,
      "4. the tenant's ceiling at 600: a new address is a 429 in the same words, and no conversation is made",
      `${res.status} · ${body?.error ?? ''} · conversations ${before} → ${afterCount}`,
    );
    // Put the row back so the walk's own turns do not refuse the user's.
    await supabase.from('rate_windows').update({ count: current.count + 1 }).eq('tenant_id', villa.id).eq('key', key).eq('window_start', current.window_start);
  }

  // 5. A streamed chat is refused the same way: one JSON 429, not an event
  //    stream (Rule 5: the check runs before the Accept header is read).
  {
    const ip = fresh();
    for (let i = 0; i < 30; i++) {
      const res = await post('villa', 'chat', { message: 'hello' }, ip);
      const body = await res.json().catch(() => ({}));
      if (body?.conversationId) conversations.push(body.conversationId);
    }
    const res = await fetch(`${BASE}/api/t/villa/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'x-forwarded-for': ip },
      body: JSON.stringify({ message: 'hello' }),
    });
    const type = res.headers.get('content-type') ?? '';
    const body = await res.json().catch(() => null);
    check(
      res.status === 429 && /application\/json/.test(type) && /Too many questions/.test(body?.error ?? ''),
      '5. a streamed request past the limit is one JSON 429, not a stream',
      `${res.status} · ${type} · ${body?.error ?? '(not json)'}`,
    );
  }

  // 6. The booking request: a body that passes the route's schema but fails
  //    the package's phone check is a 400 AFTER the window, so ten are 400
  //    and the eleventh is the 429; the words are unchanged.
  {
    const { data: unit } = await supabase.from('units').select('id').eq('tenant_id', villa.id).eq('active', true).order('sort_order').limit(1).single();
    const { data: slot } = await supabase.from('slots').select('id').eq('tenant_id', villa.id).eq('active', true).order('id').limit(1).single();
    const ip = fresh();
    const body = {
      consent: true, consentVersion: '1', slotId: slot.id, rooms: [{ unitId: unit.id, guests: 2 }],
      checkIn: '2027-03-10', nights: 1, name: 'Rate Walk', phone: '02 8123 4567', email: `rate-walk-${randomUUID().slice(0, 8)}@example.com`,
    };
    const statuses = [];
    let last = null;
    for (let i = 0; i < 11; i++) {
      const res = await post('villa', 'book/request', body, ip);
      statuses.push(res.status);
      last = await res.json().catch(() => ({}));
    }
    const rows = await windowRows(villa.id, `${villa.id}|${ip}`);
    check(
      statuses.slice(0, 10).every((s) => s === 400) && statuses[10] === 429 && /Too many requests from here/.test(last?.error ?? '')
        && rows.length === 1 && rows[0].count === 11,
      '6. book/request: ten 400s (the package refuses the phone) then the 429, unchanged words; the table holds 11',
      `statuses ${[...new Set(statuses)].join(',')} · ${last?.error ?? ''} · count ${rows[0]?.count}`,
    );
  }

  // 7. Manage booking: ten lookups of made-up references are 404s, the
  //    eleventh is the 429 with its own words, under its own key.
  {
    const ip = fresh();
    const statuses = [];
    let last = null;
    for (let i = 0; i < 11; i++) {
      const res = await post('villa', 'manage', { reference: `WAL-${randomUUID().slice(0, 6).toUpperCase()}`, contact: 'nobody@example.com' }, ip);
      statuses.push(res.status);
      last = await res.json().catch(() => ({}));
    }
    const rows = await windowRows(villa.id, `manage|${villa.id}|${ip}`);
    check(
      statuses.slice(0, 10).every((s) => s === 404) && statuses[10] === 429 && /Too many lookups/.test(last?.error ?? '')
        && rows.length === 1 && rows[0].count === 11,
      '7. manage: ten 404s then the 429 with its own words, under its own key; the table holds 11',
      `statuses ${[...new Set(statuses)].join(',')} · ${last?.error ?? ''} · count ${rows[0]?.count}`,
    );
  }
} finally {
  // 8. Cleanup: the conversations the greetings made, and this run's windows.
  if (conversations.length) {
    const { error } = await supabase.from('conversations').delete().in('id', conversations);
    check(!error, `8. cleanup: ${conversations.length} walk conversations removed`, error?.message ?? '');
  }
  const { error } = await supabase.from('rate_windows').delete().eq('tenant_id', villa.id).like('key', `%|10.7.${run}.%`);
  if (error) check(false, 'cleanup: windows', error.message);
}

console.log(failures === 0 ? '\nOK — the shared rate limit holds over HTTP.' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
