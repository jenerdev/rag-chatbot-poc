// verify.mjs — is @rag/db actually talking to the right database, correctly?
//
// Phase 3's checks, none of which need an OpenAI key: the connection works, the
// four tables are reachable, a stored embedding round-trips as 1,536 finite
// numbers, and `match_chunks` returns rows in the shape `MatchRow` claims.
//
// The query vector is an embedding ALREADY IN the database, so this costs
// nothing and needs no API key. A chunk searched against its own embedding must
// come back first with a similarity of 1 — if it does not, the vector column is
// not behaving as a vector, which is the failure `CLAUDE.md` § 5 describes and
// the one that produces no error of its own.
//
// Checks 11–14 are tenancy Phase 1 (plan.md § 1.2). They need a second tenant
// to prove isolation against, so they create a throwaway `verify-probe` tenant
// and delete it again. Deleting a tenant cascades, so nothing is left behind
// even when a check fails.
//
// Checks 28–46 are auth-rls Phase 1: the RLS policies, seen through tenant
// tokens. They need TENANT_SIGNING_JWK in .env, and create and delete their
// own probe user in Supabase Auth.
//
// Run:  pnpm --filter @rag/db verify

import { randomBytes } from 'node:crypto';
import { anonClient, mintTenantToken, parseStoredVector, scopedClient, VECTOR_DIMENSIONS } from '../dist/index.js';
import { supabase } from '../dist/service.js';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

// 1. Every table is reachable, and service_role can read it. If the anon key
//    were in .env instead, RLS (enabled, no policies) would fail every one of
//    these loudly rather than half-working.
const counts = {};
for (const table of ['documents', 'chunks', 'conversations', 'messages']) {
  const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
  check(!error, `read ${table}`, error ? error.message : `${count} rows`);
  counts[table] = count;
}

// 2. A stored embedding is 1,536 finite numbers.
const { data: chunk, error: chunkError } = await supabase
  .from('chunks')
  .select('id, document_id, tenant_id, content, embedding')
  .limit(1)
  .single();

if (chunkError || !chunk) {
  check(false, 'read one chunk', chunkError?.message ?? 'no rows — ingest a document first');
} else {
  check(typeof chunk.embedding === 'string', 'embedding arrives as a string', `typeof ${typeof chunk.embedding}`);

  let vector;
  try {
    vector = parseStoredVector(chunk.embedding);
    check(vector.length === VECTOR_DIMENSIONS, 'parses to 1536 finite numbers', `${vector.length} dims`);
  } catch (error) {
    check(false, 'parseStoredVector', error.message);
  }

  // 3. The RPC returns rows shaped like MatchRow, and the vector column really
  //    is a vector: a chunk compared with its own embedding scores 1.
  if (vector) {
    const { data: matches, error: rpcError } = await supabase.rpc('match_chunks', {
      query_embedding: vector,
      // Scoped to the chunk's own tenant. match_chunks has no unscoped form
      // once the D-031 bridge is removed.
      p_tenant_id: chunk.tenant_id,
      match_count: 3,
      min_similarity: 0,
    });

    if (rpcError) {
      check(false, 'match_chunks', rpcError.message);
    } else {
      const top = matches[0];
      const shapeOk =
        typeof top?.id === 'number' &&
        typeof top?.document_id === 'number' &&
        typeof top?.content === 'string' &&
        typeof top?.similarity === 'number';

      check(shapeOk, 'match_chunks rows match MatchRow', shapeOk ? '' : JSON.stringify(top)?.slice(0, 120));
      check(top?.id === chunk.id, 'a chunk is its own nearest neighbour', `chunk ${chunk.id}, top ${top?.id}`);
      check(
        Math.abs((top?.similarity ?? 0) - 1) < 1e-6,
        'self-similarity is 1',
        `${top?.similarity?.toFixed(6)}`,
      );
      check(
        matches.every((m, i) => i === 0 || m.similarity <= matches[i - 1].similarity),
        'results are ordered most-similar first',
        matches.map((m) => m.similarity.toFixed(3)).join(' > '),
      );
    }
  }
}

// 11. Every table has a tenant_id and not one NULL in it. A NULL is invisible to
//     `where tenant_id = …`, so a missed backfill looks like an empty knowledge
//     base, not an error.
{
  const nulls = [];
  for (const table of ['documents', 'chunks', 'conversations', 'messages']) {
    const { count, error } = await supabase
      .from(table)
      .select('*', { count: 'exact', head: true })
      .is('tenant_id', null);
    nulls.push(error ? `${table}: ${error.message}` : `${table} ${count}`);
    if (error || count !== 0) nulls.bad = true;
  }
  check(!nulls.bad, 'every row has a tenant_id', nulls.join(' · '));
}

// 15–27 are bookings Phase 1 (plan/bookings.md § 1). They run inside the same
// throwaway verify-probe tenant as 12–14, give it the bookings application, a
// unit and three slots, and book against those. Villa's real bookings are
// never touched: Villa is only READ, for the cross-tenant checks. Deleting the
// probe tenant cascades through all four new tables.
//
// The dates are fixed. The database does not care whether a date is in the
// past (@rag/bookings does), and fixed dates make the expected ranges exact.
async function bookingChecks(probeId) {
  // An insert that is SUPPOSED to fail. If it succeeds, the guard is missing:
  // the row is removed so it cannot affect later checks, and the error is null.
  const insertExpectingFailure = async (row) => {
    const { data, error } = await supabase.from('bookings').insert(row).select('id');
    if (!error) await supabase.from('bookings').delete().in('id', data.map((r) => r.id));
    return error;
  };
  const book = (row) =>
    supabase
      .from('bookings')
      .insert({ tenant_id: probeId, guest_name: 'verify.mjs probe', ...row })
      .select('id, during')
      .single();

  // 15. The four new tables are reachable.
  {
    const seen = [];
    let bad = false;
    for (const table of ['tenant_applications', 'units', 'slots', 'bookings']) {
      const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
      seen.push(error ? `${table}: ${error.message}` : `${table} ${count}`);
      // A HEAD request for a table that does not exist can come back with NO
      // error and a null count, because the error travels in a body HEAD does
      // not have. Observed here before the SQL was run. So a missing count is
      // a failure too.
      if (error || typeof count !== 'number') bad = true;
    }
    check(!bad, 'read the bookings tables', bad ? `${seen.join(' · ')} — run sql/schema-bookings.sql` : seen.join(' · '));
    if (bad) return;
  }

  // 16. The seed: villa has bookings in Asia/Manila, northwind has nothing.
  const { data: tenants } = await supabase.from('tenants').select('id, slug').in('slug', ['villa', 'northwind']);
  const idOf = Object.fromEntries((tenants ?? []).map((t) => [t.slug, t.id]));
  const { data: apps } = await supabase
    .from('tenant_applications')
    .select('tenant_id, application_key, config')
    .in('tenant_id', [idOf.villa ?? -1, idOf.northwind ?? -1]);
  const villaApp = apps?.find((a) => a.tenant_id === idOf.villa);
  const northwindApps = apps?.filter((a) => a.tenant_id === idOf.northwind) ?? [];
  check(
    villaApp?.config?.timezone === 'Asia/Manila' && northwindApps.length === 0,
    'villa has bookings, northwind has none',
    `villa ${JSON.stringify(villaApp?.config ?? null)} · northwind ${northwindApps.length} rows`,
  );

  // 17. An unknown timezone is refused on write (22023), not on the first
  //     booking eight hours out.
  {
    const { error } = await supabase
      .from('tenant_applications')
      .insert({ tenant_id: probeId, application_key: 'bookings', config: { timezone: 'Mars/Olympus_Mons' } });
    if (!error) await supabase.from('tenant_applications').delete().eq('tenant_id', probeId);
    check(
      error?.code === '22023',
      'an unknown timezone is refused',
      error ? `${error.code} ${error.message}` : 'INSERT SUCCEEDED — the timezone trigger is missing',
    );
  }

  // The probe's own setup. Evening exists only here: it starts at exactly the
  // instant Day Tour ends, which is what check 20 needs.
  await supabase
    .from('tenant_applications')
    .insert({ tenant_id: probeId, application_key: 'bookings', config: { timezone: 'Asia/Manila' } });
  const { data: unit } = await supabase.from('units').insert({ tenant_id: probeId, name: 'Probe unit' }).select('id').single();
  const { data: slotRows } = await supabase
    .from('slots')
    .insert([
      { tenant_id: probeId, name: 'Day Tour', start_time: '08:00', duration: '9 hours' },
      { tenant_id: probeId, name: 'Overnight', start_time: '14:00', duration: '22 hours' },
      { tenant_id: probeId, name: 'Evening', start_time: '17:00', duration: '4 hours' },
    ])
    .select('id, name');
  const slot = Object.fromEntries((slotRows ?? []).map((s) => [s.name, s.id]));
  if (!unit || !slot['Day Tour'] || !slot.Overnight || !slot.Evening) {
    check(false, 'set up the probe unit and slots', 'insert returned nothing');
    return;
  }

  // 18. `during` is computed in SQL from the slot and the timezone. Overnight
  //     on 1 Oct in Manila is 14:00+08 to 12:00+08 the next day.
  const overnight = await book({ unit_id: unit.id, slot_id: slot.Overnight, booked_date: '2026-10-01' });
  const expected = '["2026-10-01 06:00:00+00","2026-10-02 04:00:00+00")';
  check(
    overnight.data?.during === expected,
    'during is computed from slot and timezone',
    overnight.error ? overnight.error.message : overnight.data.during,
  );

  // 19. A `during` supplied by the caller is overwritten, not trusted.
  {
    const forged = await book({
      unit_id: unit.id,
      slot_id: slot.Overnight,
      booked_date: '2026-11-01',
      during: '[2000-01-01,2000-01-02)',
    });
    check(
      forged.data?.during === '["2026-11-01 06:00:00+00","2026-11-02 04:00:00+00")',
      'a supplied during is overwritten',
      forged.error ? forged.error.message : forged.data.during,
    );
  }

  // 20. The exclusion constraint. Overnight on 1 Oct runs until 12:00 on 2 Oct,
  //     so a Day Tour from 08:00 on 2 Oct overlaps it. This PASSES when the
  //     insert FAILS with 23P01.
  {
    const error = await insertExpectingFailure({
      tenant_id: probeId,
      unit_id: unit.id,
      slot_id: slot['Day Tour'],
      booked_date: '2026-10-02',
      guest_name: 'verify.mjs probe',
    });
    check(
      error?.code === '23P01',
      "an Overnight blocks the next day's Day Tour",
      error ? `${error.code} ${error.message}` : 'INSERT SUCCEEDED — the exclusion constraint is missing',
    );
  }

  // 21. Half-open ranges. Day Tour ends at 17:00 and Evening starts at 17:00:
  //     back to back, not overlapping. A closed range would refuse the second.
  {
    const day = await book({ unit_id: unit.id, slot_id: slot['Day Tour'], booked_date: '2026-10-05' });
    const evening = await book({ unit_id: unit.id, slot_id: slot.Evening, booked_date: '2026-10-05' });
    check(
      !day.error && !evening.error,
      'back-to-back slots do not overlap',
      day.error?.message ?? evening.error?.message ?? `${day.data.during} then ${evening.data.during}`,
    );
  }

  // 22. A cancelled booking frees its span: the Day Tour of check 20 now fits.
  {
    await supabase.from('bookings').update({ status: 'cancelled' }).eq('tenant_id', probeId).eq('id', overnight.data?.id ?? -1);
    const retry = await book({ unit_id: unit.id, slot_id: slot['Day Tour'], booked_date: '2026-10-02' });
    check(!retry.error, 'a cancelled booking frees its slot', retry.error ? `${retry.error.code} ${retry.error.message}` : retry.data.during);
  }

  // 23–24. Cross-tenant writes are refused, for the unit (composite FK) and
  //        for the slot (the trigger, with the same 23503).
  {
    const { data: villaUnit } = await supabase.from('units').select('id').eq('tenant_id', idOf.villa ?? -1).limit(1).maybeSingle();
    const { data: villaSlot } = await supabase.from('slots').select('id').eq('tenant_id', idOf.villa ?? -1).limit(1).maybeSingle();
    if (!villaUnit || !villaSlot) {
      check(false, "a booking cannot use another tenant's unit or slot", 'villa has no unit or slot — the seed did not run');
    } else {
      const unitError = await insertExpectingFailure({
        tenant_id: probeId,
        unit_id: villaUnit.id,
        slot_id: slot['Day Tour'],
        booked_date: '2026-12-01',
        guest_name: 'verify.mjs: this row must never exist',
      });
      check(
        unitError?.code === '23503',
        "a booking cannot use another tenant's unit",
        unitError ? `${unitError.code} ${unitError.message}` : 'INSERT SUCCEEDED — the composite FK is missing',
      );
      const slotError = await insertExpectingFailure({
        tenant_id: probeId,
        unit_id: unit.id,
        slot_id: villaSlot.id,
        booked_date: '2026-12-01',
        guest_name: 'verify.mjs: this row must never exist',
      });
      check(
        slotError?.code === '23503',
        "a booking cannot use another tenant's slot",
        slotError ? `${slotError.code} ${slotError.message}` : 'INSERT SUCCEEDED — the slot check is missing',
      );
    }
  }

  // 25. check_availability agrees with the constraint, and carries no guest
  //     data. Live bookings now: Day Tour 2 Oct (08–17), and nothing else near.
  //     So on 1 Oct, Overnight (to 12:00 on 2 Oct) is taken and the rest open.
  //     On 2 Oct, Day Tour is taken, and so is Overnight, which starts at
  //     14:00 inside that Day Tour. That is Villa's "only one slot is sold per
  //     day", with no rule written for it. Evening starts at 17:00, exactly as
  //     the Day Tour ends, so it is open. (The first version of this check
  //     expected Overnight open on 2 Oct. The SQL was right and the
  //     expectation was wrong.)
  {
    const { data, error } = await supabase.rpc('check_availability', {
      p_tenant_id: probeId,
      p_from: '2026-10-01',
      p_to: '2026-10-02',
    });
    const got = (data ?? []).map((r) => `${r.booked_date} ${r.slot} ${r.status}`).join(', ');
    const want = [
      '2026-10-01 Day Tour open',
      '2026-10-01 Overnight taken',
      '2026-10-01 Evening open',
      '2026-10-02 Day Tour taken',
      '2026-10-02 Overnight taken',
      '2026-10-02 Evening open',
    ].join(', ');
    const keys = data?.[0] ? Object.keys(data[0]).sort().join(',') : '';
    check(!error && got === want, 'check_availability matches the constraint', error ? error.message : got);
    check(keys === 'booked_date,slot,status,unit', 'check_availability returns no guest data', `keys: ${keys}`);
  }

  // 26. The same function, asked as another tenant, returns nothing: the
  //     leakage check of 14, for bookings.
  {
    const { data, error } = await supabase.rpc('check_availability', {
      p_tenant_id: idOf.northwind ?? -1,
      p_from: '2026-10-01',
      p_to: '2026-10-02',
    });
    check(
      !error && data.length === 0,
      'check_availability(northwind) returns zero rows',
      error ? error.message : `${data.length} rows`,
    );
  }

  // 27. Without the application, a tenant cannot hold bookings at all.
  {
    await supabase.from('tenant_applications').delete().eq('tenant_id', probeId).eq('application_key', 'bookings');
    const error = await insertExpectingFailure({
      tenant_id: probeId,
      unit_id: unit.id,
      slot_id: slot.Evening,
      booked_date: '2026-12-02',
      guest_name: 'verify.mjs: this row must never exist',
    });
    check(
      error?.code === '23503',
      'no bookings application, no bookings',
      error ? `${error.code} ${error.message}` : 'INSERT SUCCEEDED — the trigger does not check the application',
    );
  }
}

// 28–46 are auth-rls Phase 1 (plan/auth-rls.md § 1.3, § 3 Phase 1). Every
// other check in this file runs as service_role, which bypasses RLS, so none
// of them can see a policy. These mint tenant tokens and query through
// PostgREST with the publishable key, exactly as the app will from Phase 3.
//
// Rule 1 says each wall must stop a leak ALONE. So the RLS checks run
// queries with NO tenant_id filter, or with a filter naming the WRONG tenant,
// and pass only if the policy still confines the result.
//
// The tokens come from mintTenantToken() in @rag/db, the same function the
// app mints every request's token with (D-039). So these checks test the
// shipped signer, not a copy of it.

// A client that is exactly what a request holds: the publishable key plus
// one token, or no token at all (anon). No service key anywhere near it.
const asToken = (token) => (token ? scopedClient(token) : anonClient());
const chatToken = (tenantId) => mintTenantToken({ tenantId }); // no sub (§ 2.4)
const staffToken = (tenantId, userId) => mintTenantToken({ tenantId, userId, admin: true });

async function authChecks(probeId, anyChunk) {
  const { data: tenants } = await supabase.from('tenants').select('id, slug').in('slug', ['villa', 'northwind']);
  const idOf = Object.fromEntries((tenants ?? []).map((t) => [t.slug, t.id]));
  const villa = idOf.villa;
  if (!villa) {
    check(false, 'auth: villa exists', 'the RLS checks read villa, which is missing');
    return;
  }
  const villaChat = asToken(chatToken(villa));
  const probeChat = asToken(chatToken(probeId));

  // 28. Before anything else: is schema-auth.sql applied at all? Without it a
  //     chat token reads NOTHING (RLS on, no policies), which would make every
  //     "only villa's rows" check below pass vacuously on zero rows.
  {
    const { error } = await supabase.from('memberships').select('user_id', { count: 'exact', head: true });
    const { count } = await villaChat.from('chunks').select('id', { count: 'exact', head: true });
    const applied = !error && typeof count === 'number' && count > 0;
    check(applied, 'auth: schema-auth.sql is applied', applied ? `villa's token sees ${count} chunks` : `${error?.message ?? `villa's token sees ${count} chunks`} — run sql/schema-auth.sql`);
    if (!applied) return;
  }

  // 29. anon, the publishable key with no token, gets nothing: no rows, and
  //     no search function to call.
  {
    const anon = asToken(null);
    const rows = await anon.from('chunks').select('id');
    const rpc = await anon.rpc('match_chunks', { query_embedding: parseStoredVector(anyChunk.embedding), p_tenant_id: anyChunk.tenant_id });
    check(
      !rows.error && rows.data.length === 0 && rpc.error?.code === '42501',
      'auth: anon reads 0 chunks and cannot call match_chunks',
      `${rows.error?.message ?? `${rows.data.length} rows`} · ${rpc.error ? `${rpc.error.code} ${rpc.error.message}` : 'match_chunks CALLABLE'}`,
    );
  }

  // 30–33. THE RLS-ALONE CHECK (Rule 1). Villa's chat token, NO filter: every
  //        row is villa's, AND it is all of villa's rows. The count match is
  //        the other half: a policy that is too strict would pass "every row
  //        is villa's" on fewer rows, and then flip eval verdicts in Phase 4.
  //
  //        Counted in Postgres, not by fetching rows: PostgREST returns at most
  //        1000 rows, and once villa had 1236 messages the fetched page could
  //        never match the count (2026-09-27). `seen` is the token's own count
  //        with NO filter, so RLS alone decides it; `foreign` asks the token
  //        for any row that is not villa's, across every row, not one page.
  for (const table of ['documents', 'chunks', 'conversations', 'messages']) {
    const seen = await villaChat.from(table).select('*', { count: 'exact', head: true });
    const other = await villaChat.from(table).select('*', { count: 'exact', head: true }).neq('tenant_id', villa);
    const { count: truth } = await supabase.from(table).select('*', { count: 'exact', head: true }).eq('tenant_id', villa);
    const error = seen.error ?? other.error;
    check(
      !error && other.count === 0 && seen.count === truth && truth > 0,
      `auth: RLS alone, ${table} under villa's token`,
      error ? error.message : `${seen.count} rows, ${other.count} foreign, villa has ${truth}`,
    );
  }

  // 34–35. Inside a search function. match_chunks is security invoker, so RLS
  //        applies within it. Own token, own tenant: finds the chunk at 1.
  //        Another tenant's token asking for THIS tenant by p_tenant_id: the
  //        filter says yes, RLS says no, and RLS alone must win.
  {
    const vector = parseStoredVector(anyChunk.embedding);
    const args = { query_embedding: vector, p_tenant_id: anyChunk.tenant_id, match_count: 3, min_similarity: 0 };
    const own = await asToken(chatToken(anyChunk.tenant_id)).rpc('match_chunks', args);
    check(
      !own.error && own.data[0]?.id === anyChunk.id,
      'auth: match_chunks under its own token finds the chunk',
      own.error ? own.error.message : `top ${own.data[0]?.id}, want ${anyChunk.id}`,
    );
    const stolen = await probeChat.rpc('match_chunks', args);
    check(
      !stolen.error && stolen.data.length === 0,
      "auth: match_chunks naming another tenant returns 0 under RLS",
      stolen.error ? stolen.error.message : `${stolen.data.length} rows`,
    );
  }

  // The probe's bookings setup, after bookingChecks: check 27 removed the
  // application, and its live bookings are still there.
  await supabase
    .from('tenant_applications')
    .insert({ tenant_id: probeId, application_key: 'bookings', config: { timezone: 'Asia/Manila' } });
  const { data: probeUnit } = await supabase.from('units').select('id').eq('tenant_id', probeId).limit(1).single();
  const { data: probeSlot } = await supabase.from('slots').select('id').eq('tenant_id', probeId).eq('name', 'Evening').single();
  const newBooking = (tenantId) => ({
    tenant_id: tenantId,
    unit_id: probeUnit?.id,
    slot_id: probeSlot?.id,
    booked_date: '2027-03-01',
    guest_name: 'verify.mjs: this row must never exist',
  });

  // 36. A chat token cannot read ONE booking, though bookings exist (§ 2.5).
  {
    const { count: truth } = await supabase.from('bookings').select('*', { count: 'exact', head: true }).eq('tenant_id', probeId);
    const { data, error } = await probeChat.from('bookings').select('id, guest_name');
    check(
      truth > 0 && !error && data.length === 0,
      "auth: a chat token reads 0 bookings",
      `${error?.message ?? `${data.length} rows`}, the probe has ${truth}`,
    );
  }

  // 37. ...nor write one.
  {
    const { data, error } = await probeChat.from('bookings').insert(newBooking(probeId)).select('id');
    if (!error) await supabase.from('bookings').delete().in('id', data.map((r) => r.id));
    check(error?.code === '42501', 'auth: a chat token cannot insert a booking', error ? `${error.code} ${error.message}` : 'INSERT SUCCEEDED');
  }

  // 38–39. check_availability works for the token's own tenant, through
  //        security definer, and refuses any other tenant id.
  {
    const own = await probeChat.rpc('check_availability', { p_tenant_id: probeId, p_from: '2026-10-01', p_to: '2026-10-02' });
    check(
      !own.error && own.data.length === 6 && own.data.some((r) => r.status === 'taken'),
      'auth: check_availability under its own token',
      own.error ? own.error.message : own.data.map((r) => `${r.slot} ${r.status}`).join(', '),
    );
    const other = await probeChat.rpc('check_availability', { p_tenant_id: villa, p_from: '2026-10-01', p_to: '2026-10-02' });
    check(
      other.error?.code === '42501',
      "auth: check_availability refuses another tenant's id",
      other.error ? `${other.error.code} ${other.error.message}` : `${other.data.length} rows RETURNED`,
    );
  }

  // 40. app_is_admin() under a chat token is false, not an error. A chat token
  //     has no `sub`; with a non-uuid sub, auth.uid() would raise (§ 2.4).
  {
    const { data, error } = await villaChat.rpc('app_is_admin');
    check(!error && data === false, 'auth: app_is_admin() is false for a chat token', error ? `${error.code} ${error.message}` : String(data));
  }

  // 41. tenants has no policies, so a token reads nothing from it directly...
  // 42. ...and tenant_public() returns exactly the public columns, to anon.
  {
    const { data, error } = await villaChat.from('tenants').select('id');
    check(!error && data.length === 0, 'auth: a chat token reads 0 tenants rows', error ? error.message : `${data.length} rows`);
    const pub = await asToken(null).rpc('tenant_public', { p_slug: 'villa' });
    const keys = pub.data?.[0] ? Object.keys(pub.data[0]).sort().join(',') : '';
    check(
      !pub.error && keys === 'assistant_name,banner_url,business_name,fallback_messages,id,logo_url,slug,theme',
      "auth: tenant_public('villa') has only public columns",
      pub.error ? pub.error.message : `keys: ${keys}`,
    );
  }

  // 43–46 need a real user in auth.users: memberships references it, and
  // app_is_admin() looks the `sub` up there.
  const email = `verify-probe-${Date.now()}@example.com`;
  const password = randomBytes(24).toString('base64url');
  const { data: created, error: createError } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (createError) {
    check(false, 'auth: create a probe user', createError.message);
    return;
  }
  const userId = created.user.id;
  try {
    const document = (tenantId) => ({ tenant_id: tenantId, title: 'verify.mjs probe', content: 'verify.mjs: auth probe' });

    // 43. A staff token for a user with NO membership cannot write.
    {
      const { data, error } = await asToken(staffToken(probeId, userId)).from('documents').insert(document(probeId)).select('id');
      if (!error) await supabase.from('documents').delete().in('id', data.map((r) => r.id));
      check(error?.code === '42501', 'auth: staff without a membership cannot insert', error ? `${error.code} ${error.message}` : 'INSERT SUCCEEDED');
    }

    // 44. With a membership, it can insert, and delete what it inserted.
    await supabase.from('memberships').insert({ user_id: userId, tenant_id: probeId });
    {
      const staff = asToken(staffToken(probeId, userId));
      const inserted = await staff.from('documents').insert(document(probeId)).select('id').single();
      const removed = inserted.error
        ? null
        : await staff.from('documents').delete({ count: 'exact' }).eq('tenant_id', probeId).eq('id', inserted.data.id);
      check(
        !inserted.error && !removed.error && removed.count === 1,
        'auth: a member can insert and delete a document',
        inserted.error ? `insert: ${inserted.error.code} ${inserted.error.message}` : removed.error ? `delete: ${removed.error.message}` : `deleted ${removed.count}`,
      );
    }

    // 48. unanswered_resolutions is staff-only (schema-unanswered.sql, D-045).
    //     A chat token can neither write nor read a resolution; a member's
    //     staff token can do both, and delete it. The positive twin (the
    //     member reads 1 row) is what stops "chat reads 0" passing vacuously.
    {
      const staff = asToken(staffToken(probeId, userId));
      const { data: conv } = await supabase.from('conversations').insert({ tenant_id: probeId }).select('id').single();
      const { data: rows } = await supabase
        .from('messages')
        .insert([
          { tenant_id: probeId, conversation_id: conv.id, role: 'user', content: 'verify.mjs: a question' },
          { tenant_id: probeId, conversation_id: conv.id, role: 'assistant', content: "I don't know based on the documents I have." },
        ])
        .select('id, role');
      const refusalId = rows.find((r) => r.role === 'assistant').id;
      const row = { message_id: refusalId, tenant_id: probeId };
      const chatInsert = await probeChat.from('unanswered_resolutions').insert(row);
      const staffInsert = await staff.from('unanswered_resolutions').insert(row);
      const chatRead = await probeChat.from('unanswered_resolutions').select('message_id');
      const staffRead = await staff.from('unanswered_resolutions').select('message_id');
      const staffDelete = await staff.from('unanswered_resolutions').delete({ count: 'exact' }).eq('tenant_id', probeId).eq('message_id', refusalId);
      const missing = [chatInsert, staffInsert, chatRead].find((r) => r.error?.code === '42P01' || r.error?.code === 'PGRST205');
      check(
        !missing && chatInsert.error?.code === '42501' && !staffInsert.error && !chatRead.error && chatRead.data.length === 0
          && !staffRead.error && staffRead.data.length === 1 && !staffDelete.error && staffDelete.count === 1,
        'auth: resolutions are staff-only',
        missing
          ? `${missing.error.message} — run sql/schema-unanswered.sql`
          : `chat insert ${chatInsert.error?.code ?? 'INSERTED'} · staff insert ${staffInsert.error?.code ?? 'ok'} · chat reads ${chatRead.error?.message ?? chatRead.data.length} · staff reads ${staffRead.error?.message ?? staffRead.data.length} · staff deletes ${staffDelete.error?.message ?? staffDelete.count}`,
      );
      // The probe tenant's deletion at the end cascades to these rows too.
      await supabase.from('conversations').delete().eq('id', conv.id);
    }

    // 45. A minting bug: a member of the probe, with a token claiming VILLA.
    //     app_is_admin() finds no membership for villa, so every write fails,
    //     and bookings (admin-only reads) show nothing. Its chat-level reads
    //     would see villa's documents, which villa's public chat already can.
    {
      const forged = asToken(staffToken(villa, userId));
      const doc = await forged.from('documents').insert(document(villa)).select('id');
      if (!doc.error) await supabase.from('documents').delete().in('id', doc.data.map((r) => r.id));
      // Villa's OWN unit and slot, so the row is valid in every other way. With
      // the probe's unit, a trigger refuses it with 23503 before RLS is even
      // asked (observed on the first run), and the check would prove nothing.
      const { data: villaUnit } = await supabase.from('units').select('id').eq('tenant_id', villa).limit(1).single();
      const { data: villaSlot } = await supabase.from('slots').select('id').eq('tenant_id', villa).limit(1).single();
      const booking = await forged
        .from('bookings')
        .insert({ ...newBooking(villa), unit_id: villaUnit?.id, slot_id: villaSlot?.id, booked_date: '2031-01-15' })
        .select('id');
      if (!booking.error) await supabase.from('bookings').delete().in('id', booking.data.map((r) => r.id));
      const reads = await forged.from('bookings').select('id');
      check(
        doc.error?.code === '42501' && booking.error?.code === '42501' && !reads.error && reads.data.length === 0,
        'auth: a token for the wrong tenant cannot write or read bookings',
        `document ${doc.error?.code ?? 'INSERTED'} · booking ${booking.error?.code ?? 'INSERTED'} · bookings read ${reads.error?.message ?? reads.data.length}`,
      );
    }

    // 46. A real Supabase Auth session, signed by Supabase, carries no
    //     tenant_id. So on its own it reads nothing, member or not.
    {
      const client = asToken(null);
      const { error: signInError } = await client.auth.signInWithPassword({ email, password });
      const { data, error } = signInError ? { data: null, error: signInError } : await client.from('chunks').select('id');
      check(!error && data.length === 0, 'auth: a Supabase Auth token alone reads 0 chunks', error ? error.message : `${data.length} rows`);
    }
  } finally {
    // Deleting the user cascades to its memberships.
    const { error } = await supabase.auth.admin.deleteUser(userId);
    if (error) console.log(`WARN  could not delete the probe user ${email}: ${error.message}`);
  }
}

// 49–68 are booking-types Phase 1 (plan/booking-types.md § 3,
// schema-booking-types.sql). Two probes:
//   - verify-probe, left whole_resort by the checks above, for "villa's kind
//     of tenant sees no change";
//   - verify-rooms, a per_room tenant made here: two rooms, one slot, rates.
// Villa is never written to, only read (check 49). Every refusal has its
// positive twin (CLAUDE.md trap 12): a refused write is evidence only beside
// an allowed one of the same shape.
//
// The dates are fixed and in the future: 2026-10-05 is a Monday (weekday
// rate), 2026-10-09 a Friday (weekend rate under the default Fri–Sun).
async function bookingTypeChecks(probeId) {
  const { data: tenants } = await supabase.from('tenants').select('id, slug').eq('slug', 'villa');
  const villa = tenants?.[0]?.id;

  // 49. The schema is applied: the new columns and table exist, and villa's
  //     unit got the defaults (active, no capacity), which is Rule 1's "villa
  //     is untouched" in data.
  {
    const { data, error } = await supabase.from('units').select('id, active, capacity, description').eq('tenant_id', villa ?? -1);
    const rates = await supabase.from('unit_rates').select('*', { count: 'exact', head: true });
    const ok = !error && typeof rates.count === 'number' && data.length === 1 && data[0].active === true && data[0].capacity === null;
    check(
      ok,
      'booking types: schema applied, villa has one active unit',
      error || typeof rates.count !== 'number'
        ? `${error?.message ?? 'unit_rates unreadable'} — run sql/schema-booking-types.sql`
        : JSON.stringify(data),
    );
    if (!ok) return;
  }

  const { data: probeUnit } = await supabase.from('units').select('id').eq('tenant_id', probeId).limit(1).single();
  const { data: probeSlot } = await supabase.from('slots').select('id').eq('tenant_id', probeId).eq('name', 'Evening').single();

  // 50. whole_resort: a forged price is overwritten with null.
  {
    const { data, error } = await supabase
      .from('bookings')
      .insert({ tenant_id: probeId, unit_id: probeUnit.id, slot_id: probeSlot.id, booked_date: '2027-04-01', guest_name: 'verify.mjs probe', price: 123 })
      .select('id, price')
      .single();
    check(!error && data.price === null, 'whole_resort: a supplied price is stored as null', error ? `${error.code} ${error.message}` : `price ${data.price}`);
  }

  // 51. whole_resort: a second active unit is refused (deferred, so at commit)...
  // 52. ...and a second INACTIVE unit is allowed: the positive twin.
  {
    const { data, error } = await supabase.from('units').insert({ tenant_id: probeId, name: 'Second unit' }).select('id');
    if (!error) await supabase.from('units').delete().in('id', data.map((r) => r.id));
    check(error?.code === '23514', 'whole_resort: a second active unit is refused', error ? `${error.code} ${error.message}` : 'INSERT SUCCEEDED');
    const inactive = await supabase.from('units').insert({ tenant_id: probeId, name: 'Retired unit', active: false }).select('id');
    if (!inactive.error) await supabase.from('units').delete().in('id', inactive.data.map((r) => r.id));
    check(!inactive.error, 'whole_resort: a second inactive unit is allowed', inactive.error ? `${inactive.error.code} ${inactive.error.message}` : 'inserted');
  }

  // 53. check_room_availability gives a whole_resort tenant nothing, while
  //     check_availability still gives it rows (the twin).
  {
    const rooms = await supabase.rpc('check_room_availability', { p_tenant_id: probeId, p_from: '2026-10-01', p_to: '2026-10-02', p_slot: null, p_unit: null, p_guests: null });
    const slots = await supabase.rpc('check_availability', { p_tenant_id: probeId, p_from: '2026-10-01', p_to: '2026-10-02' });
    check(
      !rooms.error && rooms.data.length === 0 && !slots.error && slots.data.length > 0,
      'check_room_availability(whole_resort) returns 0 rows',
      `${rooms.error?.message ?? `${rooms.data.length} rows`}; check_availability ${slots.error?.message ?? `${slots.data.length} rows`}`,
    );
  }

  // The per_room probe. Created with the application but no booking_type, so
  // it starts whole_resort, then switched while it has nothing: the positive
  // twin for the refused switches in 55 and 64.
  const { data: rooms, error: roomsError } = await supabase
    .from('tenants')
    .insert({ slug: 'verify-rooms', business_name: 'verify.mjs rooms probe', assistant_name: 'Probe' })
    .select('id')
    .single();
  if (roomsError) {
    check(false, 'create the verify-rooms tenant', roomsError.message);
    return;
  }
  const roomsId = rooms.id;
  const email = `verify-rooms-${Date.now()}@example.com`;
  let userId = null;
  try {
    await supabase.from('tenant_applications').insert({ tenant_id: roomsId, application_key: 'bookings', config: { timezone: 'Asia/Manila' } });

    // 54. An unknown booking_type is refused; per_room is accepted.
    {
      const bad = await supabase.from('tenant_applications').update({ config: { timezone: 'Asia/Manila', booking_type: 'per_bed' } }).eq('tenant_id', roomsId);
      const good = await supabase.from('tenant_applications').update({ config: { timezone: 'Asia/Manila', booking_type: 'per_room' } }).eq('tenant_id', roomsId);
      check(
        bad.error?.code === '23514' && !good.error,
        'booking_type: "per_bed" refused, "per_room" accepted',
        `${bad.error ? bad.error.code : 'per_bed ACCEPTED'} · ${good.error ? `${good.error.code} ${good.error.message}` : 'per_room ok'}`,
      );
    }

    // Every row carries EVERY key. In a multi-row insert PostgREST sends a key
    // one row lacks as NULL, not as the column default: with `active` on the
    // last row only, the first three failed `not null` (observed 2026-09-27,
    // 23502). The same applies to @rag/bookings' multi-room inserts.
    const { data: unitRows, error: unitsError } = await supabase
      .from('units')
      .insert([
        { tenant_id: roomsId, name: 'Garden Room', capacity: 2, sort_order: 1, active: true },
        { tenant_id: roomsId, name: 'Family Room', capacity: 6, sort_order: 2, active: true },
        { tenant_id: roomsId, name: 'Unpriced Room', capacity: 4, sort_order: 3, active: true },
        { tenant_id: roomsId, name: 'Closed Room', capacity: 4, sort_order: 4, active: false },
      ])
      .select('id, name');
    if (unitsError || unitRows?.length !== 4) {
      check(false, 'set up the verify-rooms units', unitsError ? `${unitsError.code} ${unitsError.message}` : `${unitRows?.length} rows`);
      return;
    }
    const unit = Object.fromEntries((unitRows ?? []).map((u) => [u.name, u.id]));
    const { data: night } = await supabase
      .from('slots')
      .insert({ tenant_id: roomsId, name: 'Night', start_time: '14:00', duration: '22 hours' })
      .select('id')
      .single();
    await supabase.from('unit_rates').insert([
      { tenant_id: roomsId, unit_id: unit['Garden Room'], slot_id: night.id, weekday_price: 350000, weekend_price: 450000 },
      { tenant_id: roomsId, unit_id: unit['Family Room'], slot_id: night.id, weekday_price: 600000, weekend_price: 750000 },
      { tenant_id: roomsId, unit_id: unit['Closed Room'], slot_id: night.id, weekday_price: 100000, weekend_price: 100000 },
    ]);
    // guest_count on EVERY row: a per_room booking must have one
    // (schema-extra-guests.sql), and a multi-row insert sends a missing key as
    // NULL (trap 15). 1 guest is inside every room's standard.
    const booking = (row) => ({ tenant_id: roomsId, slot_id: night.id, guest_name: 'verify.mjs probe', guest_count: 1, ...row });
    const insertExpectingFailure = async (rows) => {
      const { data, error } = await supabase.from('bookings').insert(rows).select('id');
      if (!error) await supabase.from('bookings').delete().in('id', data.map((r) => r.id));
      return error;
    };

    // 55. Four units, per_room: switching back to whole_resort is refused.
    {
      const { error } = await supabase.from('tenant_applications').update({ config: { timezone: 'Asia/Manila' } }).eq('tenant_id', roomsId);
      check(error?.code === '23514', 'per_room → whole_resort refused with several active units', error ? `${error.code} ${error.message}` : 'SWITCH SUCCEEDED');
    }

    // 56. Two rooms, same night: both land. The price is the database's, by
    //     weekday (Monday) and weekend (Friday), and a forged one is ignored.
    {
      const { data, error } = await supabase
        .from('bookings')
        .insert([
          booking({ unit_id: unit['Garden Room'], booked_date: '2026-10-05', price: 1 }),
          booking({ unit_id: unit['Family Room'], booked_date: '2026-10-05', price: 1 }),
          booking({ unit_id: unit['Garden Room'], booked_date: '2026-10-09', price: null }),
        ])
        .select('unit_id, booked_date, price');
      const got = (data ?? []).map((b) => `${b.unit_id === unit['Garden Room'] ? 'Garden' : 'Family'} ${b.booked_date} ${b.price}`).join(', ');
      check(
        !error && got === 'Garden 2026-10-05 350000, Family 2026-10-05 600000, Garden 2026-10-09 450000',
        'per_room: two rooms on one night, priced by the database',
        error ? `${error.code} ${error.message}` : got,
      );
    }

    // 57. The same room twice is 23P01, and a group with one clash saves NONE
    //     of its rows: the free Family Room on the 12th is not left behind.
    {
      const error = await insertExpectingFailure([
        booking({ unit_id: unit['Family Room'], booked_date: '2026-10-12' }),
        booking({ unit_id: unit['Garden Room'], booked_date: '2026-10-05' }),
      ]);
      const { count } = await supabase.from('bookings').select('*', { count: 'exact', head: true }).eq('tenant_id', roomsId).eq('booked_date', '2026-10-12');
      check(error?.code === '23P01' && count === 0, 'per_room: a group with one clash saves nothing', `${error ? error.code : 'INSERT SUCCEEDED'}; rows left on 12 Oct: ${count}`);
    }

    // 58–60. Refused rooms: over capacity (23514), no rate (23514), inactive (23503).
    {
      const over = await insertExpectingFailure([booking({ unit_id: unit['Garden Room'], booked_date: '2026-10-19', guest_count: 3 })]);
      const fits = await insertExpectingFailure([booking({ unit_id: unit['Garden Room'], booked_date: '2026-10-19', guest_count: 2 })]);
      check(over?.code === '23514' && !fits, 'per_room: over capacity refused, at capacity allowed', `3 guests ${over ? over.code : 'ACCEPTED'} · 2 guests ${fits ? fits.code : 'ok'}`);
      const unpriced = await insertExpectingFailure([booking({ unit_id: unit['Unpriced Room'], booked_date: '2026-10-19' })]);
      check(unpriced?.code === '23514', 'per_room: a room with no rate is refused', unpriced ? `${unpriced.code} ${unpriced.message}` : 'INSERT SUCCEEDED');
      const closed = await insertExpectingFailure([booking({ unit_id: unit['Closed Room'], booked_date: '2026-10-19' })]);
      check(closed?.code === '23503', 'per_room: an inactive room is refused, even with a rate', closed ? `${closed.code} ${closed.message}` : 'INSERT SUCCEEDED');
    }

    // 61. A rate change does not reprice an existing booking, and a later
    //     update of the booking's guest count keeps its stored price too.
    {
      await supabase.from('unit_rates').update({ weekday_price: 999900 }).eq('tenant_id', roomsId).eq('unit_id', unit['Garden Room']);
      await supabase.from('bookings').update({ guest_count: 1, price: 5 }).eq('tenant_id', roomsId).eq('unit_id', unit['Garden Room']).eq('booked_date', '2026-10-05');
      const { data } = await supabase.from('bookings').select('price').eq('tenant_id', roomsId).eq('unit_id', unit['Garden Room']).eq('booked_date', '2026-10-05').single();
      const { data: quoted } = await supabase.rpc('unit_price', { p_tenant_id: roomsId, p_unit_id: unit['Garden Room'], p_slot_id: night.id, p_date: '2026-10-05' });
      check(data?.price === 350000 && quoted === 999900, 'per_room: a rate edit leaves history alone', `stored ${data?.price}, new quote ${quoted}`);
    }

    // 62. check_room_availability: active and priced rooms only, with capacity
    //     and price and no guest data; `taken` agrees with the constraint; the
    //     guest filter drops the Garden Room (2) for 3 guests.
    {
      const all = await supabase.rpc('check_room_availability', { p_tenant_id: roomsId, p_from: '2026-10-05', p_to: '2026-10-05', p_slot: null, p_unit: null, p_guests: null });
      const three = await supabase.rpc('check_room_availability', { p_tenant_id: roomsId, p_from: '2026-10-06', p_to: '2026-10-06', p_slot: 'Night', p_unit: null, p_guests: 3 });
      const got = (all.data ?? []).map((r) => `${r.unit} ${r.capacity} ${r.status} ${r.price}`).join(', ');
      const keys = all.data?.[0] ? Object.keys(all.data[0]).sort().join(',') : '';
      check(
        !all.error && got === 'Garden Room 2 taken 999900, Family Room 6 taken 600000'
          && keys === 'booked_date,capacity,extra_guest_price,extra_person_rate,price,slot,standard_capacity,status,total,unit',
        'check_room_availability: priced active rooms, no guest data',
        all.error ? all.error.message : `${got} · keys ${keys}`,
      );
      check(
        !three.error && three.data.map((r) => r.unit).join(',') === 'Family Room',
        'check_room_availability: 3 guests leaves only the Family Room',
        three.error ? three.error.message : three.data.map((r) => r.unit).join(',') || '(none)',
      );
    }

    // 63. check_availability no longer offers an inactive unit.
    {
      const { data, error } = await supabase.rpc('check_availability', { p_tenant_id: roomsId, p_from: '2026-10-05', p_to: '2026-10-05' });
      const names = [...new Set((data ?? []).map((r) => r.unit))].join(',');
      check(!error && !names.includes('Closed Room') && names.includes('Garden Room'), 'check_availability skips inactive units', error ? error.message : names);
    }

    // 64. With live bookings, the type cannot change at all.
    {
      await supabase.from('units').update({ active: false }).eq('tenant_id', roomsId).in('id', [unit['Family Room'], unit['Unpriced Room']]);
      const { error } = await supabase.from('tenant_applications').update({ config: { timezone: 'Asia/Manila' } }).eq('tenant_id', roomsId);
      check(error?.code === '23514' && /live booking/.test(error.message), 'a type switch is refused while bookings are live', error ? `${error.code} ${error.message}` : 'SWITCH SUCCEEDED');
      await supabase.from('units').update({ active: true }).eq('tenant_id', roomsId).in('id', [unit['Family Room'], unit['Unpriced Room']]);
    }

    // 69–74 are plan/extra-guests.md Phase 1: a standard capacity, the
    //        maximum (`capacity`), and a per-guest fee, all priced by ONE
    //        function, unit_quote(). The Quad Room: standard 2, maximum 4,
    //        ₱250 (25000 centavos), ₱3,500 on a weekday. 2026-10-26, 11-02
    //        and 11-09 are Mondays.
    {
      const noCount = await insertExpectingFailure([
        { tenant_id: roomsId, slot_id: night.id, guest_name: 'verify.mjs probe', unit_id: unit['Family Room'], booked_date: '2026-10-26', guest_count: null },
      ]);
      check(noCount?.code === '23514' && /guest count/.test(noCount.message), 'extra guests: a room booking needs a guest count', noCount ? `${noCount.code} ${noCount.message}` : 'INSERT SUCCEEDED');
    }
    const { data: quad, error: quadError } = await supabase
      .from('units')
      .insert({ tenant_id: roomsId, name: 'Quad Room', capacity: 4, standard_capacity: 2, extra_person_rate: 25000, sort_order: 9, active: true })
      .select('id')
      .single();
    {
      const tooHigh = await supabase.from('units').update({ standard_capacity: 3 }).eq('tenant_id', roomsId).eq('id', unit['Garden Room']);
      check(!quadError && tooHigh.error?.code === '23514', 'extra guests: standard above the maximum is refused; 2 of 4 is accepted',
        `Quad ${quadError ? quadError.message : 'ok'} · Garden standard 3 of 2: ${tooHigh.error?.code ?? 'ACCEPTED'}`);
    }
    await supabase.from('unit_rates').insert({ tenant_id: roomsId, unit_id: quad.id, slot_id: night.id, weekday_price: 350000, weekend_price: 450000 });

    // 71. The arithmetic, from the one function: 1–4 guests, weekday.
    {
      const quotes = [];
      for (const guests of [1, 2, 3, 4]) {
        const { data } = await supabase.rpc('unit_quote', { p_tenant_id: roomsId, p_unit_id: quad.id, p_slot_id: night.id, p_date: '2026-10-26', p_guests: guests });
        quotes.push(`${guests}:${data?.[0]?.base_price}+${data?.[0]?.extra_guest_price}=${data?.[0]?.price}`);
      }
      check(
        quotes.join(' ') === '1:350000+0=350000 2:350000+0=350000 3:350000+25000=375000 4:350000+50000=400000',
        'extra guests: unit_quote for 1–4 guests', quotes.join(' '),
      );
    }

    // 72. Stored: 3 guests with a forged breakdown → the database's; 5 guests refused.
    {
      const { data, error } = await supabase
        .from('bookings')
        .insert(booking({ unit_id: quad.id, booked_date: '2026-10-26', guest_count: 3, price: 1, base_price: 1, extra_guest_price: 1 }))
        .select('base_price, extra_guest_price, price')
        .single();
      const five = await insertExpectingFailure([booking({ unit_id: quad.id, booked_date: '2026-11-09', guest_count: 5 })]);
      check(
        !error && data.base_price === 350000 && data.extra_guest_price === 25000 && data.price === 375000 && five?.code === '23514',
        'extra guests: 3 guests stored as 350000 + 25000, forged values ignored; 5 refused',
        `${error ? error.message : `${data.base_price} + ${data.extra_guest_price} = ${data.price}`} · 5 guests: ${five?.code ?? 'ACCEPTED'}`,
      );
    }

    // 73. A guest-count change reprices; a re-save with the same count does not.
    {
      await supabase.from('bookings').insert(booking({ unit_id: quad.id, booked_date: '2026-11-02', guest_count: 2 }));
      const read = async () =>
        (await supabase.from('bookings').select('price, extra_guest_price').eq('tenant_id', roomsId).eq('unit_id', quad.id).eq('booked_date', '2026-11-02').single()).data;
      await supabase.from('unit_rates').update({ weekday_price: 360000 }).eq('tenant_id', roomsId).eq('unit_id', quad.id);
      await supabase.from('bookings').update({ guest_count: 2, notes: 'same count' }).eq('tenant_id', roomsId).eq('unit_id', quad.id).eq('booked_date', '2026-11-02');
      const kept = await read();
      await supabase.from('bookings').update({ guest_count: 4 }).eq('tenant_id', roomsId).eq('unit_id', quad.id).eq('booked_date', '2026-11-02');
      const repriced = await read();
      check(
        kept?.price === 350000 && repriced?.price === 410000 && repriced.extra_guest_price === 50000,
        'extra guests: 2 → 4 guests reprices (at the current rate); the same count keeps the old price',
        `same count ${kept?.price} · 4 guests ${repriced?.price} (extra ${repriced?.extra_guest_price})`,
      );
      await supabase.from('unit_rates').update({ weekday_price: 350000 }).eq('tenant_id', roomsId).eq('unit_id', quad.id);
    }

    // 74. Room availability carries the fee: for 3 guests, the total; with no
    //     guest count, the base price and no fee.
    {
      const args = (guests) => ({ p_tenant_id: roomsId, p_from: '2026-11-16', p_to: '2026-11-16', p_slot: null, p_unit: 'Quad Room', p_guests: guests });
      const three = (await supabase.rpc('check_room_availability', args(3))).data?.[0];
      const none = (await supabase.rpc('check_room_availability', args(null))).data?.[0];
      check(
        three?.price === 350000 && three.extra_guest_price === 25000 && three.total === 375000 && three.standard_capacity === 2
          && three.extra_person_rate === 25000 && none?.extra_guest_price === 0 && none.total === 350000,
        'extra guests: room availability shows base, fee and total',
        `3 guests ${three?.price} + ${three?.extra_guest_price} = ${three?.total} · no count ${none?.price} + ${none?.extra_guest_price} = ${none?.total}`,
      );
    }

    // 75. A room with NO maximum (capacity null) fits any party: it must be
    //     returned for 5 guests, not dropped by `capacity >= 5` being null
    //     (code review, 2026-09-28).
    {
      const { data: open } = await supabase
        .from('units')
        .insert({ tenant_id: roomsId, name: 'No Limit', capacity: null, standard_capacity: null, extra_person_rate: null, sort_order: 10, active: true })
        .select('id')
        .single();
      await supabase.from('unit_rates').insert({ tenant_id: roomsId, unit_id: open.id, slot_id: night.id, weekday_price: 100000, weekend_price: 100000 });
      const { data } = await supabase.rpc('check_room_availability', { p_tenant_id: roomsId, p_from: '2026-11-16', p_to: '2026-11-16', p_slot: null, p_unit: null, p_guests: 5 });
      const names = (data ?? []).map((r) => r.unit);
      check(names.includes('No Limit') && !names.includes('Garden Room'), 'extra guests: a room with no maximum fits 5 guests; a 2-guest room does not',
        names.join(', ') || '(none)');
    }

    // 65–68 are the same rules through tokens (RLS), with a real member.
    const { data: created, error: createError } = await supabase.auth.admin.createUser({ email, password: randomBytes(24).toString('base64url'), email_confirm: true });
    if (createError) {
      check(false, 'booking types: create a probe user', createError.message);
      return;
    }
    userId = created.user.id;
    await supabase.from('memberships').insert({ user_id: userId, tenant_id: roomsId });
    const staff = asToken(staffToken(roomsId, userId));
    const chat = asToken(chatToken(roomsId));

    // 65. unit_rates: a chat token reads all of its tenant's rates and none of
    //     anyone else's, and cannot write; the member can.
    {
      const { count: truth } = await supabase.from('unit_rates').select('*', { count: 'exact', head: true }).eq('tenant_id', roomsId);
      const seen = await chat.from('unit_rates').select('*', { count: 'exact', head: true });
      const write = { tenant_id: roomsId, unit_id: unit['Unpriced Room'], slot_id: night.id, weekday_price: 1, weekend_price: 1 };
      const chatInsert = await chat.from('unit_rates').insert(write);
      const staffInsert = await staff.from('unit_rates').insert(write);
      check(
        truth > 0 && seen.count === truth && chatInsert.error?.code === '42501' && !staffInsert.error,
        'auth: unit_rates read by the tenant, written by its staff',
        `chat sees ${seen.error?.message ?? seen.count} of ${truth} · chat insert ${chatInsert.error?.code ?? 'INSERTED'} · staff insert ${staffInsert.error ? `${staffInsert.error.code} ${staffInsert.error.message}` : 'ok'}`,
      );
    }

    // 66. units: staff add and deactivate a room; a chat token cannot; a
    //     villa-claiming token from this member cannot add one to villa.
    {
      const chatInsert = await chat.from('units').insert({ tenant_id: roomsId, name: 'Chat Room' });
      const staffInsert = await staff.from('units').insert({ tenant_id: roomsId, name: 'Staff Room', capacity: 2 }).select('id').single();
      const staffOff = staffInsert.error
        ? null
        : await staff.from('units').update({ active: false }).eq('tenant_id', roomsId).eq('id', staffInsert.data.id).select('active').single();
      const forged = await asToken(staffToken(villa, userId)).from('units').insert({ tenant_id: villa, name: 'Forged Room' });
      check(
        chatInsert.error?.code === '42501' && !staffInsert.error && staffOff?.data?.active === false && forged.error?.code === '42501',
        'auth: units written by their own staff only',
        `chat ${chatInsert.error?.code ?? 'INSERTED'} · staff ${staffInsert.error?.message ?? 'ok'} · deactivate ${staffOff?.error?.message ?? staffOff?.data?.active} · villa-claiming ${forged.error?.code ?? 'INSERTED'}`,
      );
    }

    // 67. unit_images: staff add a row under their own folder; another
    //     tenant's folder breaks the path check; the 7th photo is refused;
    //     sort_order can change and path cannot.
    {
      const row = (n, prefix = `${roomsId}/${unit['Garden Room']}`) => ({ tenant_id: roomsId, unit_id: unit['Garden Room'], path: `${prefix}/verify-${Date.now()}-${n}.webp` });
      const chatInsert = await chat.from('unit_images').insert(row('chat'));
      const wrongFolder = await staff.from('unit_images').insert(row('wrong', `${villa}/${unit['Garden Room']}`));
      const six = await staff.from('unit_images').insert([1, 2, 3, 4, 5, 6].map((n) => row(n))).select('id');
      const seventh = await staff.from('unit_images').insert(row(7));
      const firstId = six.data?.[0]?.id ?? -1;
      const reorder = await staff.from('unit_images').update({ sort_order: 9 }).eq('tenant_id', roomsId).eq('id', firstId).select('sort_order');
      const repath = await staff.from('unit_images').update({ path: `${roomsId}/${unit['Garden Room']}/moved.webp` }).eq('tenant_id', roomsId).eq('id', firstId);
      check(
        chatInsert.error?.code === '42501' && wrongFolder.error?.code === '23514' && !six.error && six.data.length === 6
          && seventh.error?.code === '23514' && reorder.data?.[0]?.sort_order === 9 && repath.error?.code === '42501',
        'auth: unit_images staff-only, own folder, 6 per room, path fixed',
        `chat ${chatInsert.error?.code ?? 'INSERTED'} · villa folder ${wrongFolder.error?.code ?? 'INSERTED'} · six ${six.error?.message ?? six.data.length} · 7th ${seventh.error?.code ?? 'INSERTED'} · reorder ${reorder.error?.message ?? reorder.data?.[0]?.sort_order} · repath ${repath.error?.code ?? 'UPDATED'}`,
      );
    }

    // 68. check_room_availability under tokens: own tenant works, another
    //     tenant's id is refused (it is security definer, so it checks itself).
    {
      const args = (tenantId) => ({ p_tenant_id: tenantId, p_from: '2026-10-05', p_to: '2026-10-05', p_slot: null, p_unit: null, p_guests: null });
      const own = await chat.rpc('check_room_availability', args(roomsId));
      const other = await chat.rpc('check_room_availability', args(villa));
      check(
        !own.error && own.data.length > 0 && other.error?.code === '42501',
        'auth: check_room_availability for its own tenant only',
        `own ${own.error?.message ?? `${own.data.length} rows`} · villa ${other.error?.code ?? `${other.data.length} rows RETURNED`}`,
      );
    }
  } finally {
    if (userId) {
      const { error } = await supabase.auth.admin.deleteUser(userId);
      if (error) console.log(`WARN  could not delete the probe user ${email}: ${error.message}`);
    }
    const { error } = await supabase.from('tenants').delete().eq('id', roomsId);
    if (error) console.log(`WARN  could not delete the verify-rooms tenant: ${error.message}`);
  }
}

// 12–14 need a chunk to work with, and a second tenant that owns nothing.
if (chunk && typeof chunk.tenant_id === 'number') {
  const { data: probe, error: probeError } = await supabase
    .from('tenants')
    .insert({ slug: 'verify-probe', business_name: 'verify.mjs probe', assistant_name: 'Probe' })
    .select('id')
    .single();

  if (probeError) {
    check(false, 'create the verify-probe tenant', probeError.message);
  } else {
    try {
      // 12. The composite FK refuses a chunk whose tenant disagrees with its
      //     document's. This check PASSES when the insert FAILS with 23503
      //     (foreign_key_violation). If the insert succeeds, the guard is
      //     missing: the row is removed, and the check fails.
      const { data: rogue, error: fkError } = await supabase
        .from('chunks')
        .insert({
          document_id: chunk.document_id,
          tenant_id: probe.id,
          chunk_index: -1,
          content: 'verify.mjs: this row must never exist',
          embedding: chunk.embedding,
        })
        .select('id');
      if (!fkError) await supabase.from('chunks').delete().in('id', rogue.map((r) => r.id));
      check(
        fkError?.code === '23503',
        "a chunk cannot belong to another tenant's document",
        fkError ? `${fkError.code} ${fkError.message}` : 'INSERT SUCCEEDED — the composite FK is missing',
      );

      const vector = parseStoredVector(chunk.embedding);

      // 13. Tenant-scoped search still finds a chunk from its own embedding,
      //     at similarity 1 — check 9 again, through the new overload.
      const own = await supabase.rpc('match_chunks', {
        query_embedding: vector,
        p_tenant_id: chunk.tenant_id,
        match_count: 3,
        min_similarity: 0,
      });
      check(
        !own.error && own.data[0]?.id === chunk.id && Math.abs(own.data[0].similarity - 1) < 1e-6,
        'match_chunks(own tenant) finds the chunk at 1.000000',
        own.error ? own.error.message : `top ${own.data[0]?.id} at ${own.data[0]?.similarity?.toFixed(6)}`,
      );

      // 14. The same embedding, searched as a different tenant, finds NOTHING.
      //     That is leakage caught in SQL, with no API key and no model: the
      //     cheapest possible version of plan.md Rule 2.
      const other = await supabase.rpc('match_chunks', {
        query_embedding: vector,
        p_tenant_id: probe.id,
        match_count: 3,
        min_similarity: 0,
      });
      check(
        !other.error && other.data.length === 0,
        'match_chunks(another tenant) returns zero rows',
        other.error ? other.error.message : `${other.data.length} rows`,
      );

      await bookingChecks(probe.id);
      await authChecks(probe.id, chunk);
      await bookingTypeChecks(probe.id);
    } finally {
      const { error } = await supabase.from('tenants').delete().eq('id', probe.id);
      if (error) console.log(`WARN  could not delete the verify-probe tenant: ${error.message}`);
    }
  }
} else if (chunk) {
  check(false, 'chunk has a tenant_id', 'run packages/db/sql/schema-tenancy.sql first');
}

console.log();
console.log(
  `documents ${counts.documents} · chunks ${counts.chunks} · ` +
    `conversations ${counts.conversations} · messages ${counts.messages}`,
);
console.log(failures === 0 ? '\nOK — the database layer is wired correctly.' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
