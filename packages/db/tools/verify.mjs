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

import { randomBytes, randomUUID } from 'node:crypto';
import { anonClient, mintPlatformToken, mintTenantToken, parseStoredVector, scopedClient, VECTOR_DIMENSIONS } from '../dist/index.js';
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
    // D-095: a row that names no status is born pending and holds nothing, so
    // every row these checks insert is confirmed unless it says otherwise.
    const confirmed = (r) => ({ status: 'confirmed', ...r });
    const { data, error } = await supabase.from('bookings').insert(Array.isArray(row) ? row.map(confirmed) : confirmed(row)).select('id');
    if (!error) await supabase.from('bookings').delete().in('id', data.map((r) => r.id));
    return error;
  };
  const book = (row) =>
    supabase
      .from('bookings')
      // status 'confirmed' (D-095): the default is pending, which holds nothing.
      .insert({ tenant_id: probeId, guest_name: 'verify.mjs probe', status: 'confirmed', ...row })
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
  //     Since tenant management Phase 1, switching the application OFF is
  //     itself refused while a booking has not ended
  //     (tenant_applications_no_delete_live, plan § 8 q7), so that refusal is
  //     checked first, its twin (off once every booking is cancelled) second,
  //     and only then the original check.
  {
    const off = () => supabase.from('tenant_applications').delete().eq('tenant_id', probeId).eq('application_key', 'bookings').select('tenant_id');
    const refused = await off();
    check(
      refused.error?.code === '23514' && /live booking/.test(refused.error.message),
      'roles: bookings cannot be switched off while a booking is live',
      refused.error ? `${refused.error.code} ${refused.error.message}` : `DELETED ${refused.data?.length} row(s)`,
    );
    const { data: before } = await supabase.from('bookings').select('id, status').eq('tenant_id', probeId);
    await supabase.from('bookings').update({ status: 'cancelled' }).eq('tenant_id', probeId);
    const allowed = await off();
    check(
      !allowed.error && allowed.data.length === 1,
      'roles: switched off once every booking is cancelled',
      allowed.error ? `${allowed.error.code} ${allowed.error.message}` : `${allowed.data.length} row deleted`,
    );
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
    // The statuses back as they were: authChecks (37–39) expects a taken slot.
    for (const row of before ?? []) {
      if (row.status !== 'cancelled') await supabase.from('bookings').update({ status: row.status }).eq('id', row.id);
    }
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
const platformToken = (userId) => mintPlatformToken({ userId }); // no tenant_id (tenant management Rule 1)

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
    status: 'confirmed', // D-095: the default is now pending, and a pending row holds nothing; these checks need a row that does
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
      !pub.error && keys === 'assistant_name,banner_url,business_name,fallback_messages,id,logo_url,slug,suggested_questions,theme',
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
    await supabase.from('memberships').insert({ user_id: userId, tenant_id: probeId, role: 'admin' });
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

  // 49. The schema is applied: the new columns and table exist, and villa has
  //     its one active unit. Its capacity was null until customer booking
  //     Phase 1 gave villa prices (capacity 45, plan/customer-booking.md
  //     § 2.4), so null or 45 are both villa as intended.
  {
    const { data, error } = await supabase.from('units').select('id, active, capacity, description').eq('tenant_id', villa ?? -1);
    const rates = await supabase.from('unit_rates').select('*', { count: 'exact', head: true });
    const ok = !error && typeof rates.count === 'number' && data.length === 1 && data[0].active === true && (data[0].capacity === null || data[0].capacity === 45);
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

  // 53. check_room_availability gives a tenant with NO RATES nothing (the
  //     verify-probe is whole_resort with none; since D-074 the gate is the
  //     rate, not the type), while check_availability still gives it rows.
  {
    const rooms = await supabase.rpc('check_room_availability', { p_tenant_id: probeId, p_from: '2026-10-01', p_to: '2026-10-02', p_slot: null, p_unit: null, p_guests: null });
    const slots = await supabase.rpc('check_availability', { p_tenant_id: probeId, p_from: '2026-10-01', p_to: '2026-10-02' });
    check(
      !rooms.error && rooms.data.length === 0 && !slots.error && slots.data.length > 0,
      'check_room_availability(no rates) returns 0 rows',
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
    // status 'confirmed' on every row (D-095): the default is pending, which holds nothing.
    const booking = (row) => ({ tenant_id: roomsId, slot_id: night.id, guest_name: 'verify.mjs probe', guest_count: 1, status: 'confirmed', ...row });
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
          && keys === 'booked_date,capacity,day_price,extra_guest_price,extra_person_rate,price,slot,standard_capacity,status,total,unit',
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
    await supabase.from('memberships').insert({ user_id: userId, tenant_id: roomsId, role: 'admin' });
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

// 77–92 are customer booking Phase 1 (plan/customer-booking.md § 3,
// schema-customer-booking.sql): holiday prices, a priced whole_resort tenant,
// multi-night stays, and the one public write, request_booking(). They run in
// their own throwaway tenant, verify-book: whole_resort, one unit with villa's
// numbers (30 included, 45 at most, ₱250 each above 30), an Overnight slot
// (nightly) and a Day Tour (not). Villa is only read.
//
// request_booking refuses the past and more than 365 days ahead, so its dates
// are computed from today in Manila, not fixed: the first Thursday at least
// 40 days out, so night 1 is a weekday and night 2 (Friday) a weekend night.
// The pricing checks call unit_quote() directly, which takes any date, so
// they use fixed ones (24 Dec 2026 is a Thursday).
async function customerBookingChecks() {
  const { data: villaRow } = await supabase.from('tenants').select('id').eq('slug', 'villa').single();
  const villa = villaRow?.id;

  // 77. The schema is applied: the calendar, the new columns, the function.
  {
    const cal = await supabase.from('rate_calendar').select('*', { count: 'exact', head: true });
    const cols = await supabase.from('bookings').select('source, reference, guest_email, surcharge').limit(1);
    const night = await supabase.from('slots').select('nightly').limit(1);
    const ok = typeof cal.count === 'number' && !cols.error && !night.error;
    check(ok, 'customer booking: schema applied', ok ? `rate_calendar ${cal.count} rows` : `${cal.error?.message ?? cols.error?.message ?? night.error?.message ?? 'rate_calendar unreadable'} — run sql/schema-customer-booking.sql`);
    if (!ok) return;
  }

  const localToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
  const addDays = (iso, n) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  let thursday = addDays(localToday, 40);
  while (new Date(`${thursday}T00:00:00Z`).getUTCDay() !== 4) thursday = addDays(thursday, 1);

  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .insert({ slug: 'verify-book', business_name: 'verify.mjs booking probe', assistant_name: 'Probe' })
    .select('id')
    .single();
  if (tenantError) {
    check(false, 'create the verify-book tenant', tenantError.message);
    return;
  }
  const bookId = tenant.id;
  const email = `verify-book-${Date.now()}@example.com`;
  let userId = null;
  try {
    await supabase.from('tenant_applications').insert({ tenant_id: bookId, application_key: 'bookings', config: { timezone: 'Asia/Manila' } });
    const { data: unit } = await supabase
      .from('units')
      .insert({ tenant_id: bookId, name: 'Whole property', standard_capacity: 30, capacity: 45, extra_person_rate: 25000 })
      .select('id')
      .single();
    const { data: slotRows } = await supabase
      .from('slots')
      .insert([
        { tenant_id: bookId, name: 'Overnight', start_time: '14:00', duration: '22 hours', nightly: true },
        { tenant_id: bookId, name: 'Day Tour', start_time: '08:00', duration: '9 hours', nightly: false },
      ])
      .select('id, name');
    const slot = Object.fromEntries((slotRows ?? []).map((s) => [s.name, s.id]));
    if (!unit || !slot.Overnight || !slot['Day Tour']) {
      check(false, 'set up the verify-book unit and slots', 'insert returned nothing');
      return;
    }

    // 78. whole_resort before and after a rate: a booking stored with no rate
    //     keeps price null, and one stored after the rate is priced.
    {
      const before = await supabase
        .from('bookings')
        .insert({ tenant_id: bookId, unit_id: unit.id, slot_id: slot.Overnight, booked_date: '2027-01-04', guest_name: 'verify.mjs probe', guest_count: 10 })
        .select('id, price')
        .single();
      await supabase.from('unit_rates').insert([
        { tenant_id: bookId, unit_id: unit.id, slot_id: slot.Overnight, weekday_price: 1600000, weekend_price: 2000000, holiday_price: null },
        { tenant_id: bookId, unit_id: unit.id, slot_id: slot['Day Tour'], weekday_price: 950000, weekend_price: 1200000, holiday_price: null },
      ]);
      const after = await supabase
        .from('bookings')
        .insert({ tenant_id: bookId, unit_id: unit.id, slot_id: slot.Overnight, booked_date: '2027-01-11', guest_name: 'verify.mjs probe', guest_count: 10 })
        .select('id, price')
        .single();
      const { data: kept } = await supabase.from('bookings').select('price').eq('tenant_id', bookId).eq('id', before.data?.id ?? -1).single();
      check(
        !before.error && before.data.price === null && kept?.price === null && !after.error && after.data.price === 1600000,
        'whole_resort: unpriced until it has a rate; an older booking stays null',
        `${before.error?.message ?? `before ${before.data.price}`} · kept ${kept?.price} · ${after.error?.message ?? `after ${after.data.price}`}`,
      );
      await supabase.from('bookings').delete().eq('tenant_id', bookId);
    }

    // 79. The calendar: villa's 24 Dec, 32 guests, is the weekend rate (a
    //     holiday with no holiday_price) + 2 × ₱250 + the ₱4,000 surcharge =
    //     ₱24,500 (plan § 2.3). 23 Dec, a Wednesday with no entry, is the
    //     weekday rate. Then a holiday_price, when set, wins over the weekend.
    {
      await supabase.from('rate_calendar').insert({ tenant_id: bookId, day: '2026-12-24', kind: 'peak', label: 'Christmas Eve', surcharge: 400000 });
      const quote = async (day) =>
        (await supabase.rpc('unit_quote', { p_tenant_id: bookId, p_unit_id: unit.id, p_slot_id: slot.Overnight, p_date: day, p_guests: 32 })).data?.[0];
      const eve = await quote('2026-12-24');
      const wed = await quote('2026-12-23');
      await supabase.from('unit_rates').update({ holiday_price: 2500000 }).eq('tenant_id', bookId).eq('unit_id', unit.id).eq('slot_id', slot.Overnight);
      const own = await quote('2026-12-24');
      await supabase.from('unit_rates').update({ holiday_price: null }).eq('tenant_id', bookId).eq('unit_id', unit.id).eq('slot_id', slot.Overnight);
      const show = (q) => `${q?.base_price}+${q?.extra_guest_price}+${q?.surcharge}=${q?.price}`;
      check(
        show(eve) === '2000000+50000+400000=2450000' && show(wed) === '1600000+50000+0=1650000' && show(own) === '2500000+50000+400000=2950000',
        'holidays: weekend rate + surcharge on 24 Dec (₱24,500); a holiday_price wins',
        `24 Dec ${show(eve)} · 23 Dec ${show(wed)} · with holiday_price ${show(own)}`,
      );
    }

    // 80. The stored breakdown carries the surcharge, and a forged one is ignored.
    {
      const { data, error } = await supabase
        .from('bookings')
        .insert({ tenant_id: bookId, unit_id: unit.id, slot_id: slot.Overnight, booked_date: '2026-12-24', guest_name: 'verify.mjs probe', guest_count: 32, surcharge: 1, price: 1 })
        .select('base_price, extra_guest_price, surcharge, price')
        .single();
      check(
        !error && data.base_price === 2000000 && data.extra_guest_price === 50000 && data.surcharge === 400000 && data.price === 2450000,
        'holidays: the stored booking is 2000000 + 50000 + 400000, forged values ignored',
        error ? `${error.code} ${error.message}` : `${data.base_price} + ${data.extra_guest_price} + ${data.surcharge} = ${data.price}`,
      );
      // Emptied again, so the computed dates below never land on a holiday.
      await supabase.from('bookings').delete().eq('tenant_id', bookId);
      await supabase.from('rate_calendar').delete().eq('tenant_id', bookId);
    }

    // The member, for the token checks below.
    const { data: created, error: createError } = await supabase.auth.admin.createUser({ email, password: randomBytes(24).toString('base64url'), email_confirm: true });
    if (createError) {
      check(false, 'customer booking: create a probe user', createError.message);
      return;
    }
    userId = created.user.id;
    await supabase.from('memberships').insert({ user_id: userId, tenant_id: bookId, role: 'admin' });
    const staff = asToken(staffToken(bookId, userId));
    const chat = asToken(chatToken(bookId));
    const request = (client, overrides = {}) =>
      client.rpc('request_booking', {
        p_tenant_id: bookId,
        p_slot_id: slot.Overnight,
        p_unit_ids: [unit.id],
        p_guests: [32],
        p_check_in: thursday,
        p_nights: 2,
        p_name: 'Verify Probe',
        p_phone: '0917 123 4567',
        p_email: 'probe@example.com',
        p_notes: null,
        ...overrides,
      });
    const rowsOf = async () =>
      (await supabase.from('bookings').select('id, group_id, reference, status, source, booked_date, price, guest_phone').eq('tenant_id', bookId).order('booked_date')).data ?? [];

    // 81. A chat token cannot insert into bookings directly (no policy), and
    //     anon cannot call request_booking at all: the function is the only way.
    {
      const direct = await chat.from('bookings').insert({ tenant_id: bookId, unit_id: unit.id, slot_id: slot.Overnight, booked_date: thursday, guest_name: 'x', status: 'pending' });
      const anon = await request(asToken(null));
      check(
        direct.error?.code === '42501' && anon.error?.code === '42501' && (await rowsOf()).length === 0,
        'request_booking is the only way in: chat insert and anon call refused',
        `chat insert ${direct.error?.code ?? 'INSERTED'} · anon ${anon.error?.code ?? 'CALLED'}`,
      );
    }

    // 82. THE positive case: 2 nights on a chat token → 2 pending web rows, one
    //     group, one reference, each night priced for its own date (Thursday
    //     weekday, Friday weekend), the phone normalised, check-out 12:00 on
    //     the third day.
    {
      const { data, error } = await request(chat);
      const rows = await rowsOf();
      const saturday = addDays(thursday, 2);
      const got = (data ?? []).map((r) => `${r.booked_date} ${r.price}`).join(', ');
      check(
        !error && data.length === 2 && got === `${thursday} 1650000, ${addDays(thursday, 1)} 2050000`
          && rows.length === 2 && rows.every((r) => r.status === 'pending' && r.source === 'web' && r.guest_phone === '09171234567')
          && new Set(rows.map((r) => r.group_id)).size === 1 && new Set(rows.map((r) => r.reference)).size === 1
          && /^VER-[A-Z2-9]{6}$/.test(rows[0].reference) && data[1].ends_at === `${saturday}T04:00:00+00:00`,
        'request_booking: a 2-night stay is 2 pending rows, one group, priced per night',
        error ? `${error.code} ${error.message}` : `${got} · ${rows[0]?.reference} · ends ${data[1]?.ends_at}`,
      );
    }

    // 83. A request holds nothing: check_availability still says open, and a
    //     staff booking of the same night lands. Then confirming the request
    //     is refused by the constraint (23P01), and nothing half-confirms.
    {
      const avail = await chat.rpc('check_availability', { p_tenant_id: bookId, p_from: thursday, p_to: thursday });
      const overnightOpen = avail.data?.find((r) => r.slot === 'Overnight')?.status;
      const staffBooking = await staff.from('bookings').insert({ tenant_id: bookId, unit_id: unit.id, slot_id: slot.Overnight, booked_date: addDays(thursday, 1), guest_name: 'Staff guest', guest_count: 20, status: 'confirmed' }).select('id').single();
      const group = (await rowsOf()).find((r) => r.source === 'web')?.group_id;
      const confirm = await staff.from('bookings').update({ status: 'confirmed' }).eq('tenant_id', bookId).eq('group_id', group ?? '');
      const statuses = (await rowsOf()).filter((r) => r.source === 'web').map((r) => r.status).join(',');
      check(
        overnightOpen === 'open' && !staffBooking.error && confirm.error?.code === '23P01' && statuses === 'pending,pending',
        'a request holds nothing; confirming it over a confirmed night is 23P01, all or nothing',
        `availability ${avail.error?.message ?? overnightOpen} · staff ${staffBooking.error?.message ?? 'ok'} · confirm ${confirm.error?.code ?? 'CONFIRMED'} · ${statuses}`,
      );

      // 84. ...and a new request for that confirmed night is refused up front.
      const late = await request(chat, { p_check_in: addDays(thursday, 1), p_nights: 1, p_phone: '09170000001', p_email: 'late@example.com' });
      check(late.error?.code === '23P01', 'request_booking: a confirmed night is refused up front', late.error ? `${late.error.code} ${late.error.message}` : 'REQUEST ACCEPTED');
      if (staffBooking.data) await supabase.from('bookings').delete().eq('tenant_id', bookId).eq('id', staffBooking.data.id);
    }

    // 85. The walls: another tenant's id is 42501; villa's unit, sent to our
    //     own tenant, is refused by the trigger, and nothing is saved.
    {
      const before = (await rowsOf()).length;
      const otherTenant = await request(chat, { p_tenant_id: villa ?? -1, p_phone: '09170000002', p_email: 'wall@example.com' });
      const { data: villaUnit } = await supabase.from('units').select('id').eq('tenant_id', villa ?? -1).limit(1).single();
      const otherUnit = await request(chat, { p_unit_ids: [villaUnit?.id ?? -1], p_phone: '09170000003', p_email: 'wall2@example.com' });
      const after = (await rowsOf()).length;
      check(
        otherTenant.error?.code === '42501' && otherUnit.error?.code === '23503' && after === before,
        "request_booking: another tenant's id or unit is refused, nothing saved",
        `tenant ${otherTenant.error?.code ?? 'ACCEPTED'} · unit ${otherUnit.error ? `${otherUnit.error.code} ${otherUnit.error.message}` : 'ACCEPTED'} · rows ${before} → ${after}`,
      );
    }

    // 86. Nights: 14 accepted, 15 refused; a Day Tour cannot be several nights.
    //     The 14-night request is removed again so it does not count toward
    //     the contact limit in 88.
    {
      const fourteen = await request(chat, { p_check_in: addDays(thursday, 30), p_nights: 14, p_phone: '09170000004', p_email: 'long@example.com' });
      const fifteen = await request(chat, { p_check_in: addDays(thursday, 60), p_nights: 15, p_phone: '09170000004', p_email: 'long@example.com' });
      const dayTour = await request(chat, { p_slot_id: slot['Day Tour'], p_check_in: addDays(thursday, 90), p_nights: 2, p_phone: '09170000004', p_email: 'long@example.com' });
      check(
        !fourteen.error && fourteen.data.length === 14 && fifteen.error?.code === '22023' && dayTour.error?.code === '22023',
        'request_booking: 14 nights accepted, 15 refused, a 2-night Day Tour refused',
        `14 ${fourteen.error?.code ?? `${fourteen.data.length} rows`} · 15 ${fifteen.error?.code ?? 'ACCEPTED'} · Day Tour ${dayTour.error?.code ?? 'ACCEPTED'}`,
      );
      await supabase.from('bookings').delete().eq('tenant_id', bookId).eq('guest_email', 'long@example.com');
    }

    // 86b. (tenant management Phase 1, plan § 2.4) The limits are the TENANT's:
    //      with max_stay_nights 3 and max_advance_days 200 in the config, 3
    //      nights are accepted, 4 are refused with a message naming 3, and a
    //      date 250 days out is refused naming 200. The keys removed, 86's 14
    //      and 365 hold again. request_booking() and the trigger read the same
    //      row, so there is no second copy of the number to drift.
    {
      const where = (q) => q.eq('tenant_id', bookId).eq('application_key', 'bookings');
      const { data: app } = await where(supabase.from('tenant_applications').select('config')).single();
      await where(supabase.from('tenant_applications').update({ config: { ...app.config, max_stay_nights: 3, max_advance_days: 200 } }));
      const three = await request(chat, { p_check_in: addDays(thursday, 150), p_nights: 3, p_phone: '09170000009', p_email: 'limits@example.com' });
      const four = await request(chat, { p_check_in: addDays(thursday, 160), p_nights: 4, p_phone: '09170000009', p_email: 'limits@example.com' });
      const far = await request(chat, { p_check_in: addDays(thursday, 250), p_nights: 1, p_phone: '09170000009', p_email: 'limits@example.com' });
      await where(supabase.from('tenant_applications').update({ config: app.config }));
      check(
        !three.error && three.data.length === 3
          && four.error?.code === '22023' && /1 to 3 nights/.test(four.error.message)
          && far.error?.code === '22023' && /200 days/.test(far.error.message),
        'request_booking: max_stay_nights and max_advance_days come from the tenant config',
        `3 ${three.error?.code ?? `${three.data.length} rows`} · 4 ${four.error ? `${four.error.code} "${four.error.message}"` : 'ACCEPTED'} · +250d ${far.error ? `${far.error.code} "${far.error.message}"` : 'ACCEPTED'}`,
      );
      await supabase.from('bookings').delete().eq('tenant_id', bookId).eq('guest_email', 'limits@example.com');
    }

    // 87. Contact details are checked for FORMAT: a landline-shaped phone, a
    //     bad email, a one-letter name and a date in the past are refused;
    //     +63 917 is accepted and stored as 0917 (the positive twin).
    {
      const codes = [];
      for (const bad of [{ p_phone: '02 8123 4567' }, { p_email: 'not-an-email' }, { p_name: 'X' }, { p_check_in: addDays(localToday, -1), p_nights: 1 }]) {
        const { error } = await request(chat, { p_phone: '09170000005', p_email: 'format@example.com', ...bad });
        codes.push(error?.code ?? 'ACCEPTED');
      }
      const plus63 = await request(chat, { p_check_in: addDays(thursday, 120), p_nights: 1, p_phone: '+63 917 000 0006', p_email: 'plus63@example.com' });
      const { data: stored } = await supabase.from('bookings').select('guest_phone').eq('tenant_id', bookId).eq('guest_email', 'plus63@example.com');
      check(
        codes.every((c) => c === '22023') && !plus63.error && stored?.[0]?.guest_phone === '09170000006',
        'request_booking: bad phone, email, name and a past date refused; +63 normalised',
        `${codes.join(',')} · +63 ${plus63.error?.message ?? stored?.[0]?.guest_phone}`,
      );
    }

    // 88. The per-contact limit: the phone from 82 has 1 open request; two
    //     more are accepted (3), the 4th is 54000, and a different contact is
    //     still accepted (the twin).
    {
      const codes = [];
      for (const offset of [150, 160, 170]) {
        const { error } = await request(chat, { p_check_in: addDays(thursday, offset), p_nights: 1, p_email: `limit-${offset}@example.com` });
        codes.push(error?.code ?? 'ok');
      }
      const other = await request(chat, { p_check_in: addDays(thursday, 180), p_nights: 1, p_phone: '09170000007', p_email: 'other@example.com' });
      check(
        codes.join(',') === 'ok,ok,54000' && !other.error,
        'request_booking: 3 open requests per phone, the 4th refused (54000)',
        `${codes.join(',')} · another contact ${other.error?.code ?? 'ok'}`,
      );
    }

    // 89. A slot with no rate: the request is refused and nothing is saved.
    {
      await supabase.from('unit_rates').delete().eq('tenant_id', bookId).eq('slot_id', slot['Day Tour']);
      const before = (await rowsOf()).length;
      const { error } = await request(chat, { p_slot_id: slot['Day Tour'], p_check_in: addDays(thursday, 200), p_nights: 1, p_phone: '09170000008', p_email: 'norate@example.com' });
      const after = (await rowsOf()).length;
      check(error?.code === '22023' && after === before, 'request_booking: a slot with no price is refused, nothing saved', `${error ? `${error.code} ${error.message}` : 'ACCEPTED'} · rows ${before} → ${after}`);
    }

    // 90. rate_calendar under tokens: staff write; the chat token reads its
    //     tenant's rows and cannot write; villa's token sees none of ours.
    {
      const staffInsert = await staff.from('rate_calendar').insert({ tenant_id: bookId, day: '2026-12-25', kind: 'peak', label: 'Christmas', surcharge: 400000 });
      const chatInsert = await chat.from('rate_calendar').insert({ tenant_id: bookId, day: '2026-12-31', kind: 'peak', label: 'New Year Eve' });
      const { count: truth } = await supabase.from('rate_calendar').select('*', { count: 'exact', head: true }).eq('tenant_id', bookId);
      const seen = await chat.from('rate_calendar').select('*', { count: 'exact', head: true });
      const villaSees = await asToken(chatToken(villa ?? -1)).from('rate_calendar').select('day').eq('tenant_id', bookId);
      check(
        truth > 0 && seen.count === truth && chatInsert.error?.code === '42501' && !staffInsert.error && !villaSees.error && villaSees.data.length === 0,
        'auth: rate_calendar read by the tenant, written by its staff, invisible to villa',
        `chat sees ${seen.error?.message ?? seen.count} of ${truth} · chat insert ${chatInsert.error?.code ?? 'INSERTED'} · staff ${staffInsert.error?.message ?? 'ok'} · villa ${villaSees.error?.message ?? villaSees.data.length}`,
      );
    }

    // 91. booking_page settings: an unknown key is refused, the two known ones
    //     are accepted.
    {
      const config = (page) => ({ timezone: 'Asia/Manila', booking_page: page });
      const bad = await supabase.from('tenant_applications').update({ config: config({ enabled: true }) }).eq('tenant_id', bookId);
      const good = await supabase.from('tenant_applications').update({ config: config({ instructions: 'Pay the fee by GCash.', guest_hint: 'Do not count children aged 3 and below.' }) }).eq('tenant_id', bookId);
      check(
        bad.error?.code === '23514' && !good.error,
        'booking_page: an unknown key refused, instructions and guest_hint accepted',
        `${bad.error?.code ?? 'ACCEPTED'} · ${good.error ? `${good.error.code} ${good.error.message}` : 'ok'}`,
      );
    }

    // 92. Villa's data, if the load script has run: its rates exist, its
    //     Overnight is nightly, and every booking it had before stays unpriced.
    {
      const { data: rates } = await supabase.from('unit_rates').select('weekday_price, weekend_price').eq('tenant_id', villa ?? -1);
      const { data: nightly } = await supabase.from('slots').select('name').eq('tenant_id', villa ?? -1).eq('nightly', true);
      const { count: priced } = await supabase.from('bookings').select('*', { count: 'exact', head: true }).eq('tenant_id', villa ?? -1).not('price', 'is', null).lt('created_at', '2026-09-29');
      check(
        rates?.length === 3 && nightly?.map((s) => s.name).join(',') === 'Overnight' && priced === 0,
        'villa: three rates, Overnight nightly, older bookings unpriced',
        `${rates?.length ?? 0} rates · nightly ${nightly?.map((s) => s.name).join(',') || '(none)'} · older priced ${priced}` +
          (rates?.length === 3 ? '' : ' — run plan/customer-booking-villa-rates.mjs'),
      );
    }

    // --- promos (plan/promos.md Phase 1, D-097) ---------------------------------
    // The same probe tenant (bookId: rates, an Overnight slot, a staff member),
    // its chat token and its staff token. Every RLS check has its positive twin.
    {
      // 111. The schema is applied: the table, the two columns, promo_uses().
      const table = await supabase.from('promos').select('id').limit(0);
      const cols = await supabase.from('bookings').select('promo_id, discount').limit(0);
      const uses0 = await supabase.rpc('promo_uses', { p_tenant_id: bookId, p_promo_id: 0 });
      const applied = !table.error && !cols.error && !uses0.error && uses0.data === 0;
      check(applied, 'promos: the schema is applied (table, columns, promo_uses)', applied ? 'ok' : `${table.error?.message ?? cols.error?.message ?? uses0.error?.message ?? uses0.data} — run packages/db/sql/schema-promos.sql`);

      if (applied) {
        const from = addDays(thursday, 14);
        const to = addDays(thursday, 60);
        const { data: ov } = await supabase.from('slots').select('nightly').eq('id', slot.Overnight).single();
        const nights = ov?.nightly ? 2 : 1;
        const subtotal = (r) => (r.base_price ?? 0) + (r.extra_guest_price ?? 0) + (r.surcharge ?? 0);
        const request = (checkIn, n, code) =>
          chat.rpc('request_booking', {
            p_tenant_id: bookId, p_slot_id: slot.Overnight, p_unit_ids: [unit.id], p_guests: [2], p_check_in: checkIn, p_nights: nights,
            p_name: 'Promo Guest', p_phone: `0917000010${n}`, p_email: `promo${n}@example.com`, p_notes: null, p_promo_code: code,
          });

        // 112. An admin creates two promos (a coded percent, an automatic fixed);
        //      a chat token sees none and inserts none (42501); the code is
        //      unique per tenant ignoring case (23505) and free at another.
        const pct = await staff.from('promos').insert({ tenant_id: bookId, name: 'Ten percent', kind: 'percent', value: 1000, valid_from: from, valid_to: to, code: 'TEN-10' }).select('id').single();
        const auto = await staff.from('promos').insert({ tenant_id: bookId, name: 'Off season', kind: 'fixed', value: 50000, valid_from: from, valid_to: to }).select('id').single();
        const chatSees = await chat.from('promos').select('id');
        const chatInsert = await chat.from('promos').insert({ tenant_id: bookId, name: 'x', kind: 'fixed', value: 1, valid_from: from, valid_to: to });
        const dup = await supabase.from('promos').insert({ tenant_id: bookId, name: 'dup', kind: 'fixed', value: 1, valid_from: from, valid_to: to, code: 'ten-10' });
        const elsewhere = await supabase.from('promos').insert([
          { tenant_id: villa ?? -1, name: 'villa ten', kind: 'percent', value: 1000, valid_from: from, valid_to: to, code: 'TEN-10' },
          { tenant_id: villa ?? -1, name: 'villa only', kind: 'fixed', value: 100, valid_from: from, valid_to: to, code: 'VILLA-ONLY' },
        ]).select('id, code');
        check(
          !pct.error && !auto.error && chatSees.data?.length === 0 && chatInsert.error?.code === '42501' && dup.error?.code === '23505' && elsewhere.data?.length === 2,
          'promos: an admin creates; a chat token sees none and inserts none; a code is unique per tenant, free at another',
          `create ${pct.error?.message ?? 'ok'}/${auto.error?.message ?? 'ok'} · chat sees ${chatSees.error?.message ?? chatSees.data?.length} · chat insert ${chatInsert.error?.code ?? 'INSERTED'} · dup ${dup.error?.code ?? 'INSERTED'} · villa ${elsewhere.error?.message ?? elsewhere.data?.length}`,
        );

        // 113. promo_for_request on the chat token: a wrong code and villa's code
        //      are nothing; the right code (any case) is the promo; outside its
        //      dates the reason says so; with no code the automatic one comes.
        const look = (code, f = from, t = addDays(from, 1)) => chat.rpc('promo_for_request', { p_tenant_id: bookId, p_code: code, p_from: f, p_to: t, p_subtotal: 1000000 });
        const wrong = await look('NOPE-1');
        const foreign = await look('VILLA-ONLY');
        const right = await look('ten-10');
        const outside = await look('TEN-10', addDays(to, 1), addDays(to, 1));
        const automatic = await look(null);
        check(
          wrong.data?.length === 0 && foreign.data?.length === 0 && right.data?.[0]?.id === pct.data?.id && right.data?.[0]?.reason === null
            && outside.data?.[0]?.reason === 'dates' && automatic.data?.[0]?.id === auto.data?.id,
          "promo_for_request: a wrong code and another tenant's code are nothing; the code is the promo; outside its dates 'dates'; no code gives the automatic one",
          `wrong ${wrong.error?.message ?? wrong.data?.length} · villa's ${foreign.error?.message ?? foreign.data?.length} · right ${right.error?.message ?? right.data?.[0]?.id} (${right.data?.[0]?.reason}) · outside ${outside.data?.[0]?.reason} · automatic ${automatic.error?.message ?? automatic.data?.[0]?.id}`,
        );

        // 114. request_booking with the code: 10 % off every night, rounded half
        //      up, the price net of it, the discount returned and stored.
        const req = await request(addDays(thursday, 20), 1, 'ten-10');
        const rows = req.data ?? [];
        const pctOk = rows.length === nights && rows.every((r) => r.discount === Math.round(subtotal(r) * 0.1) && r.price === subtotal(r) - r.discount);
        const { data: stored } = await supabase.from('bookings').select('promo_id, discount').eq('tenant_id', bookId).eq('reference', rows[0]?.reference ?? '');
        check(
          pctOk && stored?.length === nights && stored.every((b) => b.promo_id === pct.data?.id && b.discount === rows[0].discount),
          'request_booking with a code: 10 % off every night, the price net, promo_id and discount stored',
          req.error ? `${req.error.code} ${req.error.message}` : `${rows.map((r) => `${subtotal(r)} − ${r.discount} = ${r.price}`).join(', ')} · stored ${stored?.map((b) => `${b.promo_id}/${b.discount}`).join(', ')}`,
        );

        // 115. A fixed promo with max_uses 1: the amount on the FIRST night only;
        //      the 2nd request is refused in words (23514); a cancelled one gives
        //      the use back, so a 3rd is accepted; the count is 1.
        const fix = await staff.from('promos').insert({ tenant_id: bookId, name: 'Five hundred off', kind: 'fixed', value: 50000, valid_from: from, valid_to: to, code: 'FIX-500', max_uses: 1 }).select('id').single();
        const first = await request(addDays(thursday, 30), 2, 'FIX-500');
        const firstRows = first.data ?? [];
        const fixedOk = firstRows.length === nights && firstRows[0].discount === Math.min(50000, subtotal(firstRows[0])) && firstRows.slice(1).every((r) => r.discount === 0);
        const second = await request(addDays(thursday, 37), 3, 'FIX-500');
        const refused = second.error?.code === '23514' && /limit/.test(second.error.message);
        await supabase.from('bookings').update({ status: 'cancelled' }).eq('tenant_id', bookId).eq('reference', firstRows[0]?.reference ?? '');
        const third = await request(addDays(thursday, 37), 4, 'FIX-500');
        const usesNow = await supabase.rpc('promo_uses', { p_tenant_id: bookId, p_promo_id: fix.data?.id ?? 0 });
        check(
          !fix.error && fixedOk && refused && !third.error && usesNow.data === 1,
          'a fixed promo: on the first night only; max_uses 1 refuses the 2nd request; a cancelled one frees it; promo_uses counts 1',
          `first ${first.error?.message ?? firstRows.map((r) => r.discount).join(',')} · second ${second.error?.code ?? 'ACCEPTED'} · third ${third.error?.message ?? 'ok'} · uses ${usesNow.error?.message ?? usesNow.data}`,
        );

        // 116. The trigger, for staff: villa's promo on this tenant's booking is
        //      refused (23503); a forged discount with no promo is overwritten to
        //      null; editing a promo leaves a stored discount alone (Rule 4).
        const villaPromo = elsewhere.data?.find((p) => p.code === 'VILLA-ONLY')?.id ?? -1;
        const foreignInsert = await staff.from('bookings').insert({ tenant_id: bookId, unit_id: unit.id, slot_id: slot.Overnight, booked_date: addDays(thursday, 44), guest_name: 'Foreign promo', guest_count: 2, status: 'pending', promo_id: villaPromo }).select('id');
        const forged = await staff.from('bookings').insert({ tenant_id: bookId, unit_id: unit.id, slot_id: slot.Overnight, booked_date: addDays(thursday, 45), guest_name: 'Forged', guest_count: 2, status: 'pending', discount: 999 }).select('id, discount, promo_id').single();
        await supabase.from('promos').update({ value: 9999 }).eq('id', pct.data?.id ?? -1);
        const { data: kept } = await supabase.from('bookings').select('discount').eq('tenant_id', bookId).eq('reference', rows[0]?.reference ?? '');
        check(
          foreignInsert.error?.code === '23503' && !forged.error && forged.data?.discount === null && forged.data?.promo_id === null && kept?.every((b) => b.discount === rows[0]?.discount),
          "the trigger: another tenant's promo is refused; a forged discount is overwritten; an edited promo leaves a stored discount alone",
          `foreign ${foreignInsert.error?.code ?? 'INSERTED'} · forged ${forged.error?.message ?? forged.data?.discount} · kept ${kept?.map((b) => b.discount).join(',')} vs ${rows[0]?.discount}`,
        );

        // Villa's two probe promos go; the probe tenant's own cascade with it.
        await supabase.from('promos').delete().eq('tenant_id', villa ?? -1).in('code', ['TEN-10', 'VILLA-ONLY']);
      }
    }
  } finally {
    if (userId) {
      const { error } = await supabase.auth.admin.deleteUser(userId);
      if (error) console.log(`WARN  could not delete the probe user ${email}: ${error.message}`);
    }
    const { error } = await supabase.from('tenants').delete().eq('id', bookId);
    if (error) console.log(`WARN  could not delete the verify-book tenant: ${error.message}`);
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
      await customerBookingChecks();
      await rolesChecks();
      await calendarChecks();
      await manageBookingChecks();
    } finally {
      const { error } = await supabase.from('tenants').delete().eq('id', probe.id);
      if (error) console.log(`WARN  could not delete the verify-probe tenant: ${error.message}`);
    }
  }
} else if (chunk) {
  check(false, 'chunk has a tenant_id', 'run packages/db/sql/schema-tenancy.sql first');
}

// ---------------------------------------------------------------------------
// Tenant management Phase 1 (plan/tenant-management.md): roles on memberships,
// the platform table and token, and the tenants constraints. Every RLS check
// has its positive twin (CLAUDE.md trap 12). A throwaway `roles-probe`
// tenant and four probe users, all deleted at the end.
async function rolesChecks() {
  // 95. Is schema-roles.sql applied at all?
  const roleCol = await supabase.from('memberships').select('role', { count: 'exact', head: true });
  const platform = await supabase.from('platform_admins').select('user_id', { count: 'exact', head: true });
  check(
    !roleCol.error && !platform.error,
    'roles: schema-roles.sql is applied (memberships.role, platform_admins)',
    roleCol.error?.message ?? platform.error?.message ?? `${roleCol.count} memberships · ${platform.count} platform admins`,
  );
  if (roleCol.error || platform.error) return;

  const { data: probe, error: probeError } = await supabase
    .from('tenants')
    .insert({ slug: 'roles-probe', business_name: 'roles probe', assistant_name: 'Probe' })
    .select('id')
    .single();
  if (probeError) {
    check(false, 'roles: create the roles-probe tenant', probeError.message);
    return;
  }
  const stamp = Date.now();
  const ids = {};
  try {
    for (const name of ['owner', 'admin', 'staff', 'super']) {
      const { data, error } = await supabase.auth.admin.createUser({
        email: `roles-probe-${name}-${stamp}@example.com`,
        password: randomBytes(24).toString('base64url'),
        email_confirm: true,
      });
      if (error) throw new Error(`create ${name}: ${error.message}`);
      ids[name] = data.user.id;
    }
    const { error: memberError } = await supabase.from('memberships').insert([
      { user_id: ids.owner, tenant_id: probe.id, role: 'owner' },
      { user_id: ids.admin, tenant_id: probe.id, role: 'admin' },
      { user_id: ids.staff, tenant_id: probe.id, role: 'staff' },
    ]);
    if (memberError) throw new Error(`memberships: ${memberError.message}`);
    const as = { owner: asToken(staffToken(probe.id, ids.owner)), admin: asToken(staffToken(probe.id, ids.admin)), staff: asToken(staffToken(probe.id, ids.staff)) };
    const chat = asToken(chatToken(probe.id));

    // 96. app_role() is the ROW's role for a staff token, and null for a chat token.
    {
      const roles = {};
      for (const [name, client] of Object.entries({ ...as, chat })) roles[name] = (await client.rpc('app_role')).data ?? null;
      check(
        roles.owner === 'owner' && roles.admin === 'admin' && roles.staff === 'staff' && roles.chat === null,
        'roles: app_role() reads the row (owner, admin, staff), null for a chat token',
        JSON.stringify(roles),
      );
    }

    // 97. Wall 2 alone: a staff token cannot insert a document; an admin token
    //     can (the twin), and the row is deleted again.
    {
      const document = { tenant_id: probe.id, title: 'roles probe', content: 'roles probe' };
      const denied = await as.staff.from('documents').insert(document).select('id');
      if (!denied.error) await supabase.from('documents').delete().in('id', denied.data.map((r) => r.id));
      const allowed = await as.admin.from('documents').insert(document).select('id').single();
      if (!allowed.error) await supabase.from('documents').delete().eq('id', allowed.data.id);
      check(
        denied.error?.code === '42501' && !allowed.error,
        'roles: staff cannot insert a document, admin can',
        `staff ${denied.error ? denied.error.code : 'INSERTED'} · admin ${allowed.error ? allowed.error.message : `#${allowed.data.id}`}`,
      );
    }

    // 98. The widened policies: a staff token CAN insert and read a booking.
    {
      await supabase.from('tenant_applications').insert({ tenant_id: probe.id, application_key: 'bookings', config: { timezone: 'Asia/Manila' } });
      const { data: unit } = await supabase.from('units').insert({ tenant_id: probe.id, name: 'Roles unit' }).select('id').single();
      const { data: slot } = await supabase.from('slots').insert({ tenant_id: probe.id, name: 'Day Tour', start_time: '08:00', duration: '9 hours' }).select('id').single();
      const inserted = await as.staff
        .from('bookings')
        .insert({ tenant_id: probe.id, unit_id: unit.id, slot_id: slot.id, booked_date: '2027-06-01', guest_name: 'roles probe' })
        .select('id')
        .single();
      const seen = await as.staff.from('bookings').select('id').eq('tenant_id', probe.id);
      check(
        !inserted.error && !seen.error && seen.data.length === 1,
        'roles: staff can insert and read a booking',
        inserted.error ? `${inserted.error.code} ${inserted.error.message}` : `#${inserted.data.id} · reads ${seen.data?.length}`,
      );
      await supabase.from('bookings').delete().eq('tenant_id', probe.id);
    }

    // 99. tenants: a chat token and a staff token read 0 rows; a platform token
    //     WITH its platform_admins row reads every tenant (the count matches
    //     service_role's), archived included, and reads 0 rows of any tenant table.
    // 100. The claim without the row: the same token, once the row is gone,
    //     reads 0 tenants. Without this twin, 99 would prove only that the
    //     claim is honoured, not that the row is required (plan Rule 1).
    {
      const chatRows = await chat.from('tenants').select('id');
      const staffRows = await as.owner.from('tenants').select('id');
      await supabase.from('platform_admins').insert({ user_id: ids.super });
      const superClient = asToken(platformToken(ids.super));
      const all = await superClient.from('tenants').select('id');
      const { count } = await supabase.from('tenants').select('id', { count: 'exact', head: true });
      const documents = await superClient.from('documents').select('id');
      const chunks = await superClient.from('chunks').select('id');
      const bookings = await superClient.from('bookings').select('id');
      check(
        !chatRows.error && chatRows.data.length === 0 && !staffRows.error && staffRows.data.length === 0
          && !all.error && all.data.length === count && count >= 5
          && documents.data?.length === 0 && chunks.data?.length === 0 && bookings.data?.length === 0,
        'roles: tenants read by the platform only, and the platform reads no tenant table',
        `chat ${chatRows.data?.length} · staff ${staffRows.data?.length} · platform ${all.error ? all.error.message : all.data.length} of ${count} · documents ${documents.data?.length} chunks ${chunks.data?.length} bookings ${bookings.data?.length}`,
      );
      await supabase.from('platform_admins').delete().eq('user_id', ids.super);
      const none = await asToken(platformToken(ids.super)).from('tenants').select('id');
      check(!none.error && none.data.length === 0, 'roles: app_super without a platform_admins row reads 0 tenants', none.error ? none.error.message : `${none.data.length} rows`);
      await supabase.from('platform_admins').insert({ user_id: ids.super });
    }

    // --- dashboard (plan/dashboard.md Phase 1, D-098) ---------------------------
    // Here, after the super row exists and BEFORE 107–108 promote and delete
    // members: the roles probe has exactly one owner, one admin, one staff
    // member and a super user. It already holds the bookings application
    // (so `bookings` is an object and the money gate can be seen); it gets
    // one conversation and one refusal.
    {
      const app = await supabase.from('tenant_applications').insert({ tenant_id: probe.id, application_key: 'bookings', config: { timezone: 'Asia/Manila' } });
      const appOk = !app.error || app.error.code === '23505';
      const { data: conv } = await supabase.from('conversations').insert({ tenant_id: probe.id }).select('id').single();
      await supabase.from('messages').insert([
        { tenant_id: probe.id, conversation_id: conv?.id, role: 'user', content: 'verify.mjs: a question' },
        { tenant_id: probe.id, conversation_id: conv?.id, role: 'assistant', content: "I don't know based on the documents I have." },
      ]);
      const { data: villaRow } = await supabase.from('tenants').select('id').eq('slug', 'villa').single();

      // 117. tenant_dashboard: a chat token is refused (42501); the staff
      //      member's counts equal the truth just seeded (1 conversation, 1
      //      visitor message, 1 refusal, 1 open, 30 days of buckets, 1 member
      //      per role); its money is null; the owner's money is an object;
      //      another tenant's id on the staff token is refused.
      const chatCall = await asToken(chatToken(probe.id)).rpc('tenant_dashboard', { p_tenant_id: probe.id, p_days: 30 });
      const staffCall = await as.staff.rpc('tenant_dashboard', { p_tenant_id: probe.id, p_days: 30 });
      const ownerCall = await as.owner.rpc('tenant_dashboard', { p_tenant_id: probe.id, p_days: 30 });
      const foreign = await as.staff.rpc('tenant_dashboard', { p_tenant_id: villaRow?.id ?? -1, p_days: 30 });
      const d = staffCall.data;
      check(
        appOk && chatCall.error?.code === '42501' && !staffCall.error
          && d?.chat?.conversations === 1 && d?.chat?.visitorMessages === 1 && d?.chat?.refusals === 1 && d?.chat?.openUnanswered === 1
          && d?.chat?.perDay?.length === 30 && d?.team?.owners === 1 && d?.team?.admins === 1 && d?.team?.staff === 1
          && d?.bookings !== null && d?.bookings?.money === null && d?.bookings?.window?.days === 30
          && ownerCall.data?.bookings?.money?.confirmed === 0 && Array.isArray(ownerCall.data?.bookings?.money?.perWeek)
          && foreign.error?.code === '42501',
        'dashboard: a chat token refused; the staff counts equal the truth; money null for staff, present for the owner; another tenant refused',
        `app ${app.error?.code ?? 'ok'} · chat ${chatCall.error?.code ?? 'ANSWERED'} · staff ${staffCall.error?.message ?? `${d?.chat?.conversations}/${d?.chat?.visitorMessages}/${d?.chat?.refusals}/${d?.chat?.openUnanswered} buckets ${d?.chat?.perDay?.length}`} team ${JSON.stringify(d?.team)} money ${JSON.stringify(d?.bookings?.money)} · owner money ${JSON.stringify(ownerCall.data?.bookings?.money)?.slice(0, 50)} · foreign ${foreign.error?.code ?? 'ANSWERED'}`,
      );

      // 118. platform_dashboard: the super user gets every tenant with counts
      //      and no content column; this probe's row says 3 members, 1
      //      conversation, 1 refusal, 1 open; a tenant token is refused.
      const superClient = asToken(platformToken(ids.super));
      const strip = await superClient.rpc('platform_dashboard');
      const mine = strip.data?.find((r) => r.tenant_id === probe.id);
      const keys = mine ? Object.keys(mine).sort().join(',') : '';
      const ownerStrip = await as.owner.rpc('platform_dashboard');
      check(
        !strip.error && mine?.members === 3 && mine?.conversations_30d === 1 && mine?.refusals_30d === 1 && mine?.open_unanswered === 1 && mine?.pending_requests === 0
          && keys === 'archived_at,business_name,confirmed_stays_30d,conversations_30d,documents,members,open_unanswered,pending_requests,refusals_30d,slug,tenant_id'
          && ownerStrip.error?.code === '42501',
        'platform_dashboard: the super user gets counts only, this tenant 3 members / 1 conversation / 1 refusal; a tenant token refused',
        `${strip.error?.message ?? `${strip.data?.length} tenants`} · mine ${JSON.stringify(mine)} · owner ${ownerStrip.error?.code ?? 'ANSWERED'}`,
      );
    }

    // 101. The platform writes a tenant: update, archive (tenant_public stops
    //      returning it, so the app answers 404 everywhere), unarchive.
    {
      const superClient = asToken(platformToken(ids.super));
      const renamed = await superClient.from('tenants').update({ assistant_name: 'Probe 2' }).eq('id', probe.id).select('assistant_name').single();
      const archived = await superClient.from('tenants').update({ archived_at: new Date().toISOString() }).eq('id', probe.id).select('id');
      const gone = await asToken(null).rpc('tenant_public', { p_slug: 'roles-probe' });
      const back = await superClient.from('tenants').update({ archived_at: null }).eq('id', probe.id).select('id');
      const found = await asToken(null).rpc('tenant_public', { p_slug: 'roles-probe' });
      check(
        renamed.data?.assistant_name === 'Probe 2' && archived.data?.length === 1 && gone.data?.length === 0 && back.data?.length === 1 && found.data?.length === 1,
        'roles: the platform edits and archives a tenant; tenant_public hides an archived one',
        `renamed ${renamed.error ? renamed.error.message : renamed.data.assistant_name} · archived ${archived.data?.length} · public while archived ${gone.data?.length} · after ${found.data?.length}`,
      );
    }

    // 102. The write-side shapes on tenants, refused by Postgres (23514).
    {
      const bad = [];
      for (const [label, patch] of [
        ['theme url()', { theme: { accent: 'url(javascript:alert(1))' } }],
        ['theme unknown key', { theme: { accent: '#0f766e', font: 'Comic Sans' } }],
        ['http logo', { logo_url: 'http://example.com/logo.png' }],
        ['empty business name', { business_name: '' }],
        ['reserved slug', { slug: 'platform' }],
      ]) {
        const { error } = await supabase.from('tenants').update(patch).eq('id', probe.id);
        if (error?.code !== '23514') bad.push(`${label}: ${error ? error.code : 'ACCEPTED'}`);
      }
      const good = await supabase.from('tenants').update({ theme: { accent: '#0f766e', bg: '#fff' }, logo_url: 'https://example.com/logo.png' }).eq('id', probe.id).select('id');
      check(bad.length === 0 && !good.error, 'roles: theme, url, name and slug shapes refused; a valid theme accepted', bad.length ? bad.join(' · ') : `5 refused · valid ${good.error ? good.error.message : 'accepted'}`);
    }

    // 102b. Suggested questions (D-089): the platform writes them, anon reads
    //       them back in order through tenant_public(); every bad shape is
    //       refused by tenants_suggested_questions_shape (23514); null clears.
    {
      const superClient = asToken(platformToken(ids.super));
      const bad = [];
      for (const [label, value] of [
        ['seven questions', ['1', '2', '3', '4', '5', '6', '7']],
        ['an empty array', []],
        ['a number', ['Rooms?', 5]],
        ['an empty string', ['']],
        ['121 characters', ['x'.repeat(121)]],
        ['an object', { q: 'Rooms?' }],
      ]) {
        const { error } = await superClient.from('tenants').update({ suggested_questions: value }).eq('id', probe.id);
        if (error?.code !== '23514') bad.push(`${label}: ${error ? error.code : 'ACCEPTED'}`);
      }
      const set = await superClient.from('tenants').update({ suggested_questions: ['What rooms do you have?', 'Do you allow pets?'] }).eq('id', probe.id).select('id');
      const seen = (await asToken(null).rpc('tenant_public', { p_slug: 'roles-probe' })).data?.[0]?.suggested_questions;
      const cleared = await superClient.from('tenants').update({ suggested_questions: null }).eq('id', probe.id).select('suggested_questions').single();
      check(
        bad.length === 0 && set.data?.length === 1 && JSON.stringify(seen) === '["What rooms do you have?","Do you allow pets?"]' && cleared.data?.suggested_questions === null,
        'roles: suggested questions set by the platform, read by anon in order, bad shapes refused, null clears',
        bad.length ? bad.join(' · ') : `6 refused · public ${JSON.stringify(seen)} · cleared ${cleared.error ? cleared.error.message : cleared.data.suggested_questions}`,
      );
    }

    // 103. The two new config keys: whole numbers within bounds, or 23514.
    {
      const app = (config) => supabase.from('tenant_applications').update({ config }).eq('tenant_id', probe.id).eq('application_key', 'bookings');
      const bad = [];
      for (const [label, config] of [
        ['0 nights', { timezone: 'Asia/Manila', max_stay_nights: 0 }],
        ['3.5 nights', { timezone: 'Asia/Manila', max_stay_nights: 3.5 }],
        ['"7" as a string', { timezone: 'Asia/Manila', max_stay_nights: '7' }],
        ['800 days', { timezone: 'Asia/Manila', max_advance_days: 800 }],
      ]) {
        const { error } = await app(config);
        if (error?.code !== '23514') bad.push(`${label}: ${error ? error.code : 'ACCEPTED'}`);
      }
      const good = await app({ timezone: 'Asia/Manila', max_stay_nights: 7, max_advance_days: 90 }).select('config');
      check(bad.length === 0 && !good.error, 'roles: max_stay_nights and max_advance_days validated by the trigger', bad.length ? bad.join(' · ') : `4 refused · 7 / 90 accepted`);
    }

    // 104. member_emails(): a member sees the tenant's members with emails; a
    //      chat token is refused, and so is another tenant's id.
    // 105. user_id_by_email(): an owner resolves an address; a staff token is refused.
    {
      const list = await as.staff.rpc('member_emails', { p_tenant_id: probe.id });
      const chatList = await chat.rpc('member_emails', { p_tenant_id: probe.id });
      const { data: villaRow } = await supabase.from('tenants').select('id').eq('slug', 'villa').single();
      const otherList = await as.owner.rpc('member_emails', { p_tenant_id: villaRow.id });
      const emails = (list.data ?? []).map((r) => r.email).sort();
      check(
        !list.error && list.data.length === 3 && emails.every((e) => e.startsWith('roles-probe-')) && chatList.error?.code === '42501' && otherList.error?.code === '42501',
        'roles: member_emails() lists the tenant to its members, refuses a chat token and another tenant',
        list.error ? list.error.message : `${list.data.length} members with emails · chat ${chatList.error?.code ?? 'ROWS'} · villa ${otherList.error?.code ?? 'ROWS'}`,
      );
      const found = await as.owner.rpc('user_id_by_email', { p_email: `  Roles-Probe-staff-${stamp}@example.com ` });
      const missing = await as.owner.rpc('user_id_by_email', { p_email: 'nobody-${stamp}@example.com' });
      const denied = await as.staff.rpc('user_id_by_email', { p_email: `roles-probe-owner-${stamp}@example.com` });
      check(
        found.data === ids.staff && missing.data === null && denied.error?.code === '42501',
        'roles: user_id_by_email() for an owner (trimmed, any case), null when unknown, refused for staff',
        `found ${found.data === ids.staff} · missing ${missing.data} · staff ${denied.error?.code ?? 'ANSWERED'}`,
      );
    }

    // 106. Members read their tenant's rows (memberships_read_tenant): staff
    //      sees 3, a chat token 0; and an UPDATE reaches only rows its token
    //      can SELECT, which is what the next check relies on.
    {
      const staffSees = await as.staff.from('memberships').select('user_id').eq('tenant_id', probe.id);
      const chatSees = await chat.from('memberships').select('user_id');
      check(
        !staffSees.error && staffSees.data.length === 3 && !chatSees.error && chatSees.data.length === 0,
        "roles: a member reads its tenant's memberships, a chat token none",
        `staff ${staffSees.error ? staffSees.error.message : staffSees.data.length} · chat ${chatSees.error ? chatSees.error.message : chatSees.data.length}`,
      );
    }

    // 107. Owners manage their tenant's rows: an owner promotes staff to admin
    //      (1 row); a staff token changes nothing (0 rows); an owner's update
    //      aimed at villa's rows touches nothing (0 rows, and villa unchanged).
    {
      const promoted = await as.owner.from('memberships').update({ role: 'admin' }).eq('tenant_id', probe.id).eq('user_id', ids.staff).select('role');
      const byStaff = await as.staff.from('memberships').update({ role: 'staff' }).eq('tenant_id', probe.id).eq('user_id', ids.owner).select('role');
      const { data: villaRow } = await supabase.from('tenants').select('id').eq('slug', 'villa').single();
      const acrossTenants = await as.owner.from('memberships').update({ role: 'staff' }).eq('tenant_id', villaRow.id).select('role');
      const { data: villaRoles } = await supabase.from('memberships').select('role').eq('tenant_id', villaRow.id);
      check(
        promoted.data?.length === 1 && promoted.data[0].role === 'admin' && byStaff.data?.length === 0 && acrossTenants.data?.length === 0 && villaRoles.every((r) => r.role !== 'staff'),
        'roles: an owner changes a role in its tenant only; staff changes nothing',
        `owner→ ${promoted.error ? promoted.error.message : promoted.data.length} row · staff→ ${byStaff.data?.length ?? byStaff.error?.code} · across tenants ${acrossTenants.data?.length ?? acrossTenants.error?.code} · villa still ${villaRoles.map((r) => r.role).join(',')}`,
      );
    }

    // 108. The last owner stays: the owner cannot delete or demote itself while
    //      it is the only owner (23514); after making a second owner, it can.
    {
      const selfDelete = await as.owner.from('memberships').delete().eq('tenant_id', probe.id).eq('user_id', ids.owner).select('user_id');
      const selfDemote = await as.owner.from('memberships').update({ role: 'staff' }).eq('tenant_id', probe.id).eq('user_id', ids.owner).select('role');
      const second = await as.owner.from('memberships').update({ role: 'owner' }).eq('tenant_id', probe.id).eq('user_id', ids.admin).select('role');
      const now = await as.owner.from('memberships').delete().eq('tenant_id', probe.id).eq('user_id', ids.owner).select('user_id');
      check(
        selfDelete.error?.code === '23514' && selfDemote.error?.code === '23514' && second.data?.length === 1 && now.data?.length === 1,
        'roles: the last owner cannot leave or step down; with a second owner it can',
        `delete ${selfDelete.error?.code ?? 'DELETED'} · demote ${selfDemote.error?.code ?? 'DEMOTED'} · second owner ${second.data?.length ?? second.error?.code} · then delete ${now.data?.length ?? now.error?.code}`,
      );
    }

  } catch (error) {
    check(false, 'roles: probe setup', error.message);
  } finally {
    // The tenant first (its memberships and application cascade; the
    // last-owner and no-delete-live triggers let a cascade through), then the
    // users (platform_admins cascades).
    const { error } = await supabase.from('tenants').delete().eq('id', probe.id);
    if (error) console.log(`WARN  could not delete the roles-probe tenant: ${error.message}`);
    for (const userId of Object.values(ids)) {
      const { error: userError } = await supabase.auth.admin.deleteUser(userId);
      if (userError) console.log(`WARN  could not delete a roles-probe user: ${userError.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// The calendar (plan/calendar.md Phase 1, D-103): calendar_pending(),
// calendar_slots(), calendar_days(). A throwaway per_room `calendar-probe`
// with two rooms × two slots (4 sellable pairs a day) and one retired room,
// and a seeded week, Monday 1 March 2027 to Sunday 7 March, whose every
// date's state is known by hand:
//
//   Mon 1  nothing                               available 0/4
//   Tue 2  A/Day confirmed                       partial   1/4
//   Wed 3  all four confirmed                    full      4/4
//   Thu 4  closed (rate_calendar kind closed)    closed
//   Fri 5  holiday; ONE two-room pending stay    available 0/4, pending 1 (not 2: § 2.3)
//   Sat 6  A/Evening confirmed, B/Evening pending  partial 1/4, pending 1
//   Sun 7  nothing                               available, weekend
//
// Every refusal has its positive twin (trap 12): a chat token is refused
// and the staff token gets the seven rows; another tenant's id is refused
// and this tenant's is answered; another tenant's room gives nothing and
// this tenant's room gives its half.
async function calendarChecks() {
  const { data: probe, error: probeError } = await supabase
    .from('tenants')
    .insert({ slug: 'calendar-probe', business_name: 'calendar probe', assistant_name: 'Probe' })
    .select('id')
    .single();
  if (probeError) {
    check(false, 'calendar: create the calendar-probe tenant', probeError.message);
    return;
  }
  let userId = null;
  try {
    const app = await supabase
      .from('tenant_applications')
      .insert({ tenant_id: probe.id, application_key: 'bookings', config: { timezone: 'Asia/Manila', booking_type: 'per_room' } });
    if (app.error) throw new Error(`application: ${app.error.message}`);
    const { data: units, error: unitError } = await supabase
      .from('units')
      .insert([
        { tenant_id: probe.id, name: 'A', capacity: 2, sort_order: 1, active: true },
        { tenant_id: probe.id, name: 'B', capacity: 2, sort_order: 2, active: true },
        { tenant_id: probe.id, name: 'Retired', capacity: 2, sort_order: 3, active: false },
      ])
      .select('id, name');
    if (unitError) throw new Error(`units: ${unitError.message}`);
    const unit = Object.fromEntries(units.map((u) => [u.name, u.id]));
    const { data: slots, error: slotError } = await supabase
      .from('slots')
      .insert([
        { tenant_id: probe.id, name: 'Day', start_time: '08:00', duration: '8 hours' },
        { tenant_id: probe.id, name: 'Evening', start_time: '17:00', duration: '6 hours' },
      ])
      .select('id, name');
    if (slotError) throw new Error(`slots: ${slotError.message}`);
    const slot = Object.fromEntries(slots.map((s) => [s.name, s.id]));
    const rates = [];
    for (const u of ['A', 'B', 'Retired']) for (const s of ['Day', 'Evening']) rates.push({ tenant_id: probe.id, unit_id: unit[u], slot_id: slot[s], weekday_price: 100000, weekend_price: 100000 });
    const rateInsert = await supabase.from('unit_rates').insert(rates);
    if (rateInsert.error) throw new Error(`rates: ${rateInsert.error.message}`);

    const row = (u, s, day, status, group) => ({
      tenant_id: probe.id, unit_id: unit[u], slot_id: slot[s], booked_date: day, guest_name: 'calendar probe', guest_count: 1, status,
      ...(group ? { group_id: group } : {}),
    });
    const seed = async (rows) => {
      const { error } = await supabase.from('bookings').insert(rows);
      if (error) throw new Error(`bookings: ${error.code} ${error.message}`);
    };
    await seed([row('A', 'Day', '2027-03-02', 'confirmed')]);
    await seed([row('A', 'Day', '2027-03-03', 'confirmed'), row('A', 'Evening', '2027-03-03', 'confirmed'), row('B', 'Day', '2027-03-03', 'confirmed'), row('B', 'Evening', '2027-03-03', 'confirmed')]);
    const stay = randomUUID();
    await seed([row('A', 'Day', '2027-03-05', 'pending', stay), row('B', 'Day', '2027-03-05', 'pending', stay)]);
    await seed([row('A', 'Evening', '2027-03-06', 'confirmed')]);
    await seed([row('B', 'Evening', '2027-03-06', 'pending')]);
    const days = await supabase.from('rate_calendar').insert([
      { tenant_id: probe.id, day: '2027-03-04', kind: 'closed', label: 'Probe closed', surcharge: 0 },
      { tenant_id: probe.id, day: '2027-03-05', kind: 'holiday', label: 'Probe holiday', surcharge: 0 },
    ]);
    if (days.error) throw new Error(`rate_calendar: ${days.error.message}`);

    const { data: user, error: userError } = await supabase.auth.admin.createUser({
      email: `calendar-probe-${Date.now()}@example.com`,
      password: randomBytes(24).toString('base64url'),
      email_confirm: true,
    });
    if (userError) throw new Error(`user: ${userError.message}`);
    userId = user.user.id;
    const member = await supabase.from('memberships').insert({ user_id: userId, tenant_id: probe.id, role: 'staff' });
    if (member.error) throw new Error(`membership: ${member.error.message}`);
    const staff = asToken(staffToken(probe.id, userId));
    const chat = asToken(chatToken(probe.id));
    const { data: villaRow } = await supabase.from('tenants').select('id').eq('slug', 'villa').single();
    const { data: villaUnit } = await supabase.from('units').select('id').eq('tenant_id', villaRow?.id ?? -1).limit(1).maybeSingle();
    const week = { p_tenant_id: probe.id, p_from: '2027-03-01', p_to: '2027-03-07' };

    // 119. Who may read it: a chat token is refused (42501), the staff token is
    //      answered; the staff token naming another tenant is refused.
    {
      const chatCall = await chat.rpc('calendar_days', week);
      const chatSlots = await chat.rpc('calendar_slots', week);
      const staffCall = await staff.rpc('calendar_days', week);
      const foreign = await staff.rpc('calendar_days', { ...week, p_tenant_id: villaRow?.id ?? -1 });
      check(
        chatCall.error?.code === '42501' && chatSlots.error?.code === '42501' && !staffCall.error && staffCall.data?.length === 7 && foreign.error?.code === '42501',
        'calendar: a chat token refused, the staff token answered with 7 days, another tenant refused',
        `chat ${chatCall.error?.code ?? 'ANSWERED'}/${chatSlots.error?.code ?? 'ANSWERED'} · staff ${staffCall.error?.message ?? `${staffCall.data?.length} days`} · foreign ${foreign.error?.code ?? 'ANSWERED'}`,
      );
    }

    // 120. Every date's roll-up equals the hand count above.
    {
      const { data, error } = await staff.rpc('calendar_days', week);
      const got = (data ?? []).map((d) => `${d.day.slice(8)} ${d.state} ${d.taken}/${d.sellable} p${d.pending} ${d.rate_kind}${d.label ? ` "${d.label}"` : ''}${d.bookable ? '' : ' !book'}`);
      const want = [
        '01 available 0/4 p0 weekday',
        '02 partial 1/4 p0 weekday',
        '03 full 4/4 p0 weekday',
        '04 closed 0/4 p0 closed "Probe closed" !book',
        '05 available 0/4 p1 holiday "Probe holiday"',
        '06 partial 1/4 p1 weekend',
        '07 available 0/4 p0 weekend',
      ];
      check(
        !error && JSON.stringify(got) === JSON.stringify(want),
        'calendar: each date of the seeded week is available / partial / full / closed / holiday with one two-room pending stay / partial with a pending / weekend',
        error ? error.message : got.join(' | '),
      );
    }

    // 121. The slots under it: 28 rows (7 days × 2 rooms × 2 slots; the retired
    //      room left out); the closed date's four are `closed`; the two-room
    //      stay is pending on A/Day and B/Day, once each.
    {
      const { data, error } = await staff.rpc('calendar_slots', week);
      const on = (day, u, s) => data?.find((r) => r.day === day && r.unit === u && r.slot === s);
      const closed = (data ?? []).filter((r) => r.day === '2027-03-04');
      check(
        !error && data.length === 28 && !data.some((r) => r.unit === 'Retired')
          && closed.length === 4 && closed.every((r) => r.state === 'closed')
          && on('2027-03-05', 'A', 'Day')?.pending === 1 && on('2027-03-05', 'B', 'Day')?.pending === 1 && on('2027-03-05', 'A', 'Evening')?.pending === 0
          && on('2027-03-03', 'B', 'Evening')?.state === 'taken' && on('2027-03-01', 'A', 'Day')?.state === 'open',
        'calendar: 28 slot rows, the closed date closed in every slot, the two-room stay pending once on each of its rooms',
        error ? error.message : `${data.length} rows · closed ${closed.map((r) => r.state).join(',')} · 5th A/Day ${JSON.stringify(on('2027-03-05', 'A', 'Day'))}`,
      );
    }

    // 122. One room: this tenant's room A gives its half (2 sellable a day, the
    //      3rd full at 2/2); another tenant's room gives 0 slot rows and every
    //      day `none`; the retired room is `none` too (0 of 0 is never
    //      "available", plan § 2.1).
    {
      const a = await staff.rpc('calendar_days', { ...week, p_unit_id: unit.A });
      const foreignUnit = await staff.rpc('calendar_slots', { ...week, p_unit_id: villaUnit?.id ?? -1 });
      const retired = await staff.rpc('calendar_days', { ...week, p_unit_id: unit.Retired });
      const third = a.data?.find((d) => d.day === '2027-03-03');
      check(
        !a.error && a.data.every((d) => d.sellable === 2) && third?.state === 'full' && third?.taken === 2
          && !foreignUnit.error && foreignUnit.data.length === 0
          && !retired.error && retired.data.every((d) => d.state === 'none' || d.state === 'closed'),
        "calendar: one room gives its half; another tenant's room gives nothing; a retired room is `none`, not available",
        `A ${a.error?.message ?? `${a.data.map((d) => d.sellable).join('')} 3rd ${third?.state}`} · villa's room ${foreignUnit.error?.message ?? `${foreignUnit.data.length} rows`} · retired ${retired.error?.message ?? retired.data.map((d) => d.state).join(',')}`,
      );
    }

    // 124. The Day view's bookings (calendar_bookings): the full 3rd lists its
    //      four confirmed bookings, one per (room, slot); the 5th lists the
    //      two-room pending stay on A/Day and B/Day; a chat token is refused.
    {
      const third = await staff.rpc('calendar_bookings', { p_tenant_id: probe.id, p_day: '2027-03-03' });
      const fifth = await staff.rpc('calendar_bookings', { p_tenant_id: probe.id, p_day: '2027-03-05' });
      const chatCall = await chat.rpc('calendar_bookings', { p_tenant_id: probe.id, p_day: '2027-03-03' });
      const pairs = (rows) => (rows ?? []).map((r) => `${Object.keys(unit).find((k) => unit[k] === r.unit_id)}/${Object.keys(slot).find((k) => slot[k] === r.slot_id)}:${r.status}`).sort().join(',');
      check(
        !third.error && pairs(third.data) === 'A/Day:confirmed,A/Evening:confirmed,B/Day:confirmed,B/Evening:confirmed'
          && !fifth.error && pairs(fifth.data) === 'A/Day:pending,B/Day:pending'
          && chatCall.error?.code === '42501',
        "calendar: the Day view's bookings are the ones overlapping each slot; a chat token refused",
        `3rd ${third.error?.message ?? pairs(third.data)} · 5th ${fifth.error?.message ?? pairs(fifth.data)} · chat ${chatCall.error?.code ?? 'ANSWERED'}`,
      );
    }

    // 123. The range: 62 days answered, 63 refused (22023), reversed refused.
    {
      const ok = await staff.rpc('calendar_days', { p_tenant_id: probe.id, p_from: '2027-03-01', p_to: '2027-05-01' });
      const long = await staff.rpc('calendar_days', { p_tenant_id: probe.id, p_from: '2027-03-01', p_to: '2027-05-02' });
      const reversed = await staff.rpc('calendar_days', { p_tenant_id: probe.id, p_from: '2027-03-07', p_to: '2027-03-01' });
      check(
        !ok.error && ok.data.length === 62 && long.error?.code === '22023' && reversed.error?.code === '22023',
        'calendar: 62 days answered, 63 and a reversed range refused',
        `62 ${ok.error?.message ?? ok.data.length} · 63 ${long.error?.code ?? 'ANSWERED'} · reversed ${reversed.error?.code ?? 'ANSWERED'}`,
      );
    }
  } catch (error) {
    check(false, 'calendar: probe setup', error.message);
  } finally {
    const { error } = await supabase.from('tenants').delete().eq('id', probe.id);
    if (error) console.log(`WARN  could not delete the calendar-probe tenant: ${error.message}`);
    if (userId) {
      const { error: userError } = await supabase.auth.admin.deleteUser(userId);
      if (userError) console.log(`WARN  could not delete the calendar-probe user: ${userError.message}`);
    }
  }
}

// 125–132 are manage-booking Phase 1 (plan/manage-booking.md): stays, the
// event log, 'expired', and guest_stay(), the guest's one read. Their own
// throwaway tenant, deleted at the end (the cascade takes stays and events).
async function manageBookingChecks() {
  const { data: probe, error: probeError } = await supabase
    .from('tenants')
    .insert({ slug: 'manage-probe', business_name: 'manage probe', assistant_name: 'Probe' })
    .select('id')
    .single();
  if (probeError) {
    check(false, 'manage: create the manage-probe tenant', probeError.message);
    return;
  }
  let userId = null;
  const probeProofs = [];
  const probeUsers = [];
  try {
    const app = await supabase
      .from('tenant_applications')
      .insert({ tenant_id: probe.id, application_key: 'bookings', config: { timezone: 'Asia/Manila', booking_type: 'per_room' } });
    if (app.error) throw new Error(`application: ${app.error.message}`);
    const { data: units, error: unitError } = await supabase
      .from('units')
      .insert([
        { tenant_id: probe.id, name: 'A', capacity: 2, sort_order: 1, active: true },
        { tenant_id: probe.id, name: 'B', capacity: 2, sort_order: 2, active: true },
      ])
      .select('id, name');
    if (unitError) throw new Error(`units: ${unitError.message}`);
    const unit = Object.fromEntries(units.map((u) => [u.name, u.id]));
    const { data: slotRow, error: slotError } = await supabase
      .from('slots')
      .insert({ tenant_id: probe.id, name: 'Day', start_time: '08:00', duration: '8 hours' })
      .select('id')
      .single();
    if (slotError) throw new Error(`slots: ${slotError.message}`);
    const rates = await supabase.from('unit_rates').insert(
      ['A', 'B'].map((u) => ({ tenant_id: probe.id, unit_id: unit[u], slot_id: slotRow.id, weekday_price: 100000, weekend_price: 150000 })),
    );
    if (rates.error) throw new Error(`rates: ${rates.error.message}`);

    const contact = { guest_email: 'Probe.Guest@Example.com', guest_phone: '0917 845 2290' };
    const row = (u, day, group, withContact) => ({
      tenant_id: probe.id, unit_id: unit[u], slot_id: slotRow.id, booked_date: day, guest_name: 'Manage Probe', guest_count: 1,
      status: 'pending', group_id: group, ...(withContact ? contact : {}),
    });
    const seed = async (rows) => {
      const { data, error } = await supabase.from('bookings').insert(rows).select('id, group_id, reference');
      if (error) throw new Error(`bookings: ${error.code} ${error.message}`);
      return data;
    };
    // Stay 1: two rooms, one group, a contact (2027-04-05 is a Monday, so
    // weekday rates: 2 × 1,000.00). Stay 2: one room, a contact. Stay 3: no
    // contact at all (a walk-in typed by staff).
    const g1 = randomUUID();
    const one = await seed([row('A', '2027-04-05', g1, true), row('B', '2027-04-05', g1, true)]);
    const two = await seed([row('A', '2027-04-12', randomUUID(), true)]);
    const three = await seed([row('B', '2027-04-19', randomUUID(), false)]);
    const ref1 = one[0].reference;

    const { data: user, error: userError } = await supabase.auth.admin.createUser({
      email: `manage-probe-${Date.now()}@example.com`,
      password: randomBytes(24).toString('base64url'),
      email_confirm: true,
    });
    if (userError) throw new Error(`user: ${userError.message}`);
    userId = user.user.id;
    const member = await supabase.from('memberships').insert({ user_id: userId, tenant_id: probe.id, role: 'staff' });
    if (member.error) throw new Error(`membership: ${member.error.message}`);
    const staff = asToken(staffToken(probe.id, userId));
    const chat = asToken(chatToken(probe.id));
    const lookup = (ref, who, tenantId = probe.id) => chat.rpc('guest_stay', { p_tenant_id: tenantId, p_reference: ref, p_contact: who });

    // 125. One stay per group: the two-room insert made ONE stay with its
    //      reference; every group in the database has its stay; staff read
    //      the probe's three, a chat token reads none.
    {
      const mine = await supabase.from('stays').select('group_id, reference').eq('tenant_id', probe.id);
      const groups = await supabase.from('bookings').select('tenant_id, group_id');
      const stays = await supabase.from('stays').select('tenant_id, group_id');
      const key = (r) => `${r.tenant_id}|${r.group_id}`;
      const missing = new Set((groups.data ?? []).map(key));
      for (const r of stays.data ?? []) missing.delete(key(r));
      const staffRead = await staff.from('stays').select('reference');
      const chatRead = await chat.from('stays').select('reference');
      check(
        !mine.error && mine.data.length === 3 && mine.data.some((r) => r.reference === ref1 && r.group_id === g1)
          && one[0].reference === one[1].reference && missing.size === 0
          && staffRead.data?.length === 3 && (chatRead.data ?? []).length === 0,
        'manage: one stay per group (a two-room insert is one), every group has its stay, staff read 3, a chat token 0',
        `probe stays ${mine.data?.length} · groups without a stay ${missing.size} · staff ${staffRead.error?.message ?? staffRead.data.length} · chat ${chatRead.error?.message ?? (chatRead.data ?? []).length}`,
      );
    }

    // 126. The right pair finds the stay, by email (any case) and by phone
    //      (any format), on a chat token; the answer is guest-facing only.
    {
      const byEmail = await lookup(` ${ref1.toLowerCase()} `, 'probe.guest@EXAMPLE.com');
      const byPhone = await lookup(ref1, '+63 917 845 2290');
      const s = byEmail.data;
      const keys = s ? Object.keys(s).sort().join(',') : '';
      check(
        !byEmail.error && s?.reference === ref1 && s.status === 'pending' && s.rooms?.length === 2 && s.nights === 1
          && Number(s.price?.total) === 200000 && !('notes' in s) && !('guest_email' in s) && !('decision_note' in s)
          && !byPhone.error && byPhone.data?.reference === ref1,
        'manage: guest_stay finds a stay by reference + email or phone, guest-facing columns only',
        `email ${byEmail.error?.message ?? `${s?.status} ${s?.rooms?.length} rooms total ${s?.price?.total}`} · phone ${byPhone.error?.message ?? byPhone.data?.reference} · keys ${keys}`,
      );
    }

    // 127. Every miss is the same null: a wrong contact, an unknown
    //      reference, a stay with no contact on file; another tenant's id
    //      is refused outright (42501). Positive twin: stay 2's right pair.
    {
      const wrong = await lookup(two[0].reference, 'someone.else@example.com');
      const unknown = await lookup('MAN-ZZZZZZ', contact.guest_email);
      const noContact = await lookup(three[0].reference, contact.guest_email);
      const { data: villaRow } = await supabase.from('tenants').select('id').eq('slug', 'villa').single();
      const foreign = await lookup(ref1, contact.guest_email, villaRow?.id ?? -1);
      const twin = await lookup(two[0].reference, contact.guest_email);
      check(
        !wrong.error && wrong.data === null && !unknown.error && unknown.data === null && !noContact.error && noContact.data === null
          && foreign.error?.code === '42501' && twin.data?.reference === two[0].reference,
        "manage: a wrong contact, an unknown reference and a stay with no contact are all null; another tenant's id is refused",
        `wrong ${wrong.error?.message ?? JSON.stringify(wrong.data)} · unknown ${JSON.stringify(unknown.data)} · no contact ${JSON.stringify(noContact.data)} · foreign ${foreign.error?.code ?? 'ANSWERED'} · twin ${twin.data?.reference}`,
      );
    }

    // 128. The lockout: stay 2 has 1 miss from 127; 4 more make 5, and then
    //      the RIGHT pair is null too; stay 1 (another reference) still answers.
    {
      for (let i = 0; i < 4; i++) await lookup(two[0].reference, `nobody${i}@example.com`);
      const locked = await lookup(two[0].reference, contact.guest_email);
      const other = await lookup(ref1, contact.guest_email);
      const counted = await supabase.from('guest_lookup_failures').select('id', { count: 'exact', head: true }).eq('tenant_id', probe.id).eq('reference', two[0].reference);
      const chatRead = await chat.from('guest_lookup_failures').select('id');
      check(
        !locked.error && locked.data === null && other.data?.reference === ref1 && counted.count === 5 && (chatRead.data ?? []).length === 0,
        'manage: after 5 misses the right pair is null for that reference only; the misses are counted and unreadable',
        `locked ${JSON.stringify(locked.data)} · other ${other.data?.reference} · misses ${counted.count} · chat read ${chatRead.error?.message ?? (chatRead.data ?? []).length}`,
      );
    }

    // 129. The event log: each seed left ONE 'created' event per stay (system,
    //      row_count 2 for the two-room one); a staff Confirm of stay 1 is ONE
    //      status event, actor staff with the user's id; a decline with a
    //      note carries the note. Staff read them, a chat token none.
    {
      const confirm = await staff.from('bookings').update({ status: 'confirmed' }).eq('tenant_id', probe.id).eq('group_id', g1).select('id');
      const decline = await staff.from('bookings').update({ status: 'cancelled', decision_note: 'probe: guest called' }).eq('tenant_id', probe.id).eq('group_id', two[0].group_id).select('id');
      const { data: events } = await supabase.from('booking_events').select('group_id, actor_kind, actor_user, kind, from_value, to_value, row_count, note').eq('tenant_id', probe.id).order('id');
      const of = (g) => (events ?? []).filter((e) => e.group_id === g);
      const e1 = of(g1);
      const e2 = of(two[0].group_id);
      const staffRead = await staff.from('booking_events').select('id');
      const chatRead = await chat.from('booking_events').select('id');
      check(
        !confirm.error && confirm.data.length === 2 && !decline.error
          && e1.length === 2 && e1[0].kind === 'created' && e1[0].actor_kind === 'system' && e1[0].row_count === 2 && e1[0].to_value === 'pending'
          && e1[1].kind === 'status' && e1[1].from_value === 'pending' && e1[1].to_value === 'confirmed' && e1[1].actor_kind === 'staff' && e1[1].actor_user === userId && e1[1].row_count === 2
          && e2.at(-1)?.to_value === 'cancelled' && e2.at(-1)?.note === 'probe: guest called'
          && staffRead.data?.length === (events ?? []).length && (chatRead.data ?? []).length === 0,
        'manage: one created event per stay, one status event per statement with the staff user and the note; staff read them, a chat token none',
        `stay 1 ${e1.map((e) => `${e.kind}:${e.from_value ?? ''}>${e.to_value}/${e.actor_kind}/${e.row_count}`).join(' ')} · stay 2 last ${JSON.stringify(e2.at(-1)?.note)} · staff ${staffRead.data?.length}/${events?.length} · chat ${(chatRead.data ?? []).length}`,
      );
    }

    // 130. Nobody writes the log: a staff token's insert is refused, its
    //      update and delete touch nothing (counted by the service client).
    {
      const before = await supabase.from('booking_events').select('id', { count: 'exact', head: true }).eq('tenant_id', probe.id);
      const ins = await staff.from('booking_events').insert({ tenant_id: probe.id, group_id: g1, actor_kind: 'staff', kind: 'status', to_value: 'confirmed' });
      const upd = await staff.from('booking_events').update({ note: 'forged' }).eq('tenant_id', probe.id).select('id');
      const del = await staff.from('booking_events').delete().eq('tenant_id', probe.id).select('id');
      const after = await supabase.from('booking_events').select('id', { count: 'exact', head: true }).eq('tenant_id', probe.id);
      const forged = await supabase.from('booking_events').select('id', { count: 'exact', head: true }).eq('tenant_id', probe.id).eq('note', 'forged');
      check(
        Boolean(ins.error) && (upd.data ?? []).length === 0 && (del.data ?? []).length === 0 && before.count === after.count && forged.count === 0 && before.count > 0,
        'manage: no token writes the event log (insert refused, update and delete touch 0)',
        `insert ${ins.error?.code ?? 'ACCEPTED'} · update ${(upd.data ?? []).length} · delete ${(del.data ?? []).length} · ${before.count} → ${after.count}`,
      );
    }

    // 131. 'expired' is a status (the system's event says so); a made-up one
    //      is still refused (23514).
    {
      const exp = await supabase.from('bookings').update({ status: 'expired' }).eq('tenant_id', probe.id).eq('group_id', three[0].group_id).select('id');
      const bogus = await supabase.from('bookings').update({ status: 'bogus' }).eq('tenant_id', probe.id).eq('group_id', three[0].group_id);
      const { data: last } = await supabase.from('booking_events').select('actor_kind, from_value, to_value').eq('tenant_id', probe.id).eq('group_id', three[0].group_id).order('id', { ascending: false }).limit(1).single();
      check(
        !exp.error && exp.data.length === 1 && bogus.error?.code === '23514' && last?.to_value === 'expired' && last?.actor_kind === 'system',
        "manage: 'expired' is accepted and logged; an unknown status is 23514",
        `expired ${exp.error?.message ?? exp.data.length} · bogus ${bogus.error?.code ?? 'ACCEPTED'} · event ${JSON.stringify(last)}`,
      );
    }

    // 132. Hard-deleting a stay's bookings removes the stay and its events
    //      (the tools' fixtures); a stay that still has bookings cannot go.
    {
      const blocked = await supabase.from('stays').delete().eq('tenant_id', probe.id).eq('group_id', g1);
      const gone = await supabase.from('bookings').delete().eq('tenant_id', probe.id).eq('group_id', three[0].group_id);
      const stay = await supabase.from('stays').select('group_id').eq('tenant_id', probe.id).eq('group_id', three[0].group_id);
      const ev = await supabase.from('booking_events').select('id', { count: 'exact', head: true }).eq('tenant_id', probe.id).eq('group_id', three[0].group_id);
      check(
        blocked.error?.code === '23503' && !gone.error && stay.data?.length === 0 && ev.count === 0,
        'manage: deleting the last booking of a stay removes the stay and its events; a stay with bookings cannot go',
        `blocked ${blocked.error?.code ?? 'DELETED'} · stay left ${stay.data?.length} · events left ${ev.count}`,
      );
    }

    // 133–138 are manage-booking Phase 3: settings, the required amount,
    // submit_payment(), stay_payment(), the proof bucket.

    // 133. The ONE required-amount rule, and the settings validator.
    {
      const req = async (total, fee) => (await supabase.rpc('stay_required', { p_total: total, p_fee: fee })).data;
      const got = [
        await req(450000, { kind: 'full' }),
        await req(450000, { kind: 'fixed', value: 200000 }),
        await req(450000, { kind: 'fixed', value: 900000 }),
        await req(100001, { kind: 'percent', value: 3333 }),
        await req(100000, { kind: 'percent', value: 3000 }),
      ];
      const base = { timezone: 'Asia/Manila', booking_type: 'per_room' };
      const method = { kind: 'gcash', label: 'GCash', account_name: 'Probe', account_number: '0917 000 0000' };
      const bad = async (payments) => (await supabase.from('tenant_applications').update({ config: { ...base, payments } }).eq('tenant_id', probe.id).eq('application_key', 'bookings')).error?.code;
      const refused = [
        await bad({ methods: [method], fee: { kind: 'percent', value: 10001 } }),
        await bad({ methods: [method, { ...method }], fee: { kind: 'full' } }),
        await bad({ methods: [method], fee: { kind: 'full' }, deposit: 1 }),
        await bad({ methods: [], fee: { kind: 'full' } }),
        await bad({ methods: [{ ...method, kind: 'cash' }], fee: { kind: 'full' } }),
      ];
      const set = await supabase.from('tenant_applications')
        .update({ config: { ...base, payments: { methods: [method, { kind: 'bank', label: 'BPI', account_number: '1234-5678' }], fee: { kind: 'percent', value: 3000 }, terms: 'Probe terms' } } })
        .eq('tenant_id', probe.id).eq('application_key', 'bookings');
      check(
        JSON.stringify(got) === JSON.stringify([450000, 200000, 450000, 33331, 30000]) && refused.every((c) => c === '23514') && !set.error,
        'manage: stay_required (full, fixed, fixed capped, percent rounded UP); five bad settings refused, a good one kept',
        `${got.join(',')} · refused ${refused.join(',')} · set ${set.error?.message ?? 'ok'}`,
      );
    }

    // A WEB stay through request_booking() (as the tools' service client),
    // on Monday 2027-04-26: 1,000.00 at 30 % → 300.00 required.
    const payContact = { email: 'Payer.Probe@Example.com', phone: '0918 111 2222' };
    const { data: webRows, error: webError } = await supabase.rpc('request_booking', {
      p_tenant_id: probe.id, p_slot_id: slotRow.id, p_unit_ids: [unit.A], p_guests: [1], p_check_in: '2027-04-26', p_nights: 1,
      p_name: 'Payer Probe', p_phone: payContact.phone, p_email: payContact.email, p_notes: null,
    });
    if (webError) throw new Error(`request_booking: ${webError.message}`);
    const webRef = webRows[0].reference;
    const { data: webStay } = await supabase.from('bookings').select('group_id').eq('tenant_id', probe.id).eq('reference', webRef).limit(1).single();
    const proofs = probeProofs; // removed in finally, even if a check throws
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const uploadProof = async () => {
      const path = `${probe.id}/incoming/${randomUUID()}.png`;
      const { error } = await chat.storage.from('payment-proofs').upload(path, PNG, { contentType: 'image/png', upsert: false });
      if (error) throw new Error(`proof upload: ${error.message}`);
      proofs.push(path);
      return path;
    };
    const submit = (over = {}) => chat.rpc('submit_payment', {
      p_tenant_id: probe.id, p_reference: webRef, p_contact: payContact.email, p_proof_path: '', p_method: 'gcash',
      p_claimed_amount: 30000, p_paid_on: '2026-10-10', p_payer_reference: 'TXN 1', p_idempotency_key: randomUUID(), ...over,
    });

    // 134. The web stay's terms were set when it was born; a staff stay is
    //      not tracked; the guest sees "unpaid" with how to pay.
    {
      const { data: s } = await supabase.from('stays').select('required_amount').eq('tenant_id', probe.id).eq('group_id', webStay.group_id).single();
      const { data: staffStay } = await supabase.from('stays').select('required_amount').eq('tenant_id', probe.id).eq('group_id', g1).single();
      const guest = (await lookup(webRef, payContact.email)).data;
      const staffSide = (await lookup(ref1, contact.guest_email)).data;
      check(
        s?.required_amount === 30000 && staffStay?.required_amount === null
          && guest?.payment?.status === 'unpaid' && guest.payment.required === 30000 && guest.payment.price === 100000 && guest.payment.enough === false
          && guest.pay?.methods?.length === 2 && guest.pay.terms === 'Probe terms'
          && staffSide?.payment?.status === 'not_tracked',
        'manage: a web stay is born with its required amount (30 % of 1,000.00 = 300.00); a staff stay is not tracked; the guest sees unpaid and how to pay',
        `web ${s?.required_amount} · staff ${staffStay?.required_amount} · guest ${JSON.stringify(guest?.payment)} methods ${guest?.pay?.methods?.length} · staff stay ${staffSide?.payment?.status}`,
      );
    }

    // 135. submit_payment(): refusals in words, then one row; the same key
    //      again is the same row; another key while one is open is refused.
    {
      const wrongMethod = await submit({ p_method: 'Cash', p_proof_path: await uploadProof() });
      const noObject = await submit({ p_proof_path: `${probe.id}/incoming/${randomUUID()}.png` });
      const tooMuch = await submit({ p_claimed_amount: 100001, p_proof_path: await uploadProof() });
      const future = await submit({ p_paid_on: '2030-01-01', p_proof_path: await uploadProof() });
      const key = randomUUID();
      const first = await submit({ p_idempotency_key: key, p_proof_path: await uploadProof() });
      const again = await submit({ p_idempotency_key: key, p_proof_path: '' });
      const second = await submit({ p_proof_path: await uploadProof() });
      const { count } = await supabase.from('payments').select('id', { count: 'exact', head: true }).eq('tenant_id', probe.id);
      check(
        wrongMethod.error?.code === '22023' && noObject.error?.code === '22023' && tooMuch.error?.code === '22023' && future.error?.code === '22023'
          && !first.error && typeof first.data === 'number' && again.data === first.data
          && second.error?.code === '55000' && /already being checked/.test(second.error.message) && count === 1,
        'manage: submit_payment refuses a wrong method, a missing file, too much and a future date (22023); a double click is one row; a second proof while one is open is 55000 in words',
        `method ${wrongMethod.error?.code} · object ${noObject.error?.code} · amount ${tooMuch.error?.code} · date ${future.error?.code} · first ${first.error?.message ?? first.data} again ${again.data} · second ${second.error?.code} "${second.error?.message}" · rows ${count}`,
      );
    }

    // 136. Who sees it: the guest (status submitted, the history without the
    //      file's path), staff (the row), a chat token reading the table
    //      (nothing); the log has the payment, by the guest.
    {
      const guest = (await lookup(webRef, payContact.phone)).data;
      const staffRows = await staff.from('payments').select('id, proof_path');
      const chatRows = await chat.from('payments').select('id');
      const { data: ev } = await supabase.from('booking_events').select('kind, to_value, actor_kind, amount').eq('tenant_id', probe.id).eq('group_id', webStay.group_id).eq('kind', 'payment');
      const viaStaff = await staff.rpc('stay_payment', { p_tenant_id: probe.id, p_group_id: webStay.group_id });
      check(
        guest?.payment?.status === 'submitted' && guest.payment.open === true && guest.payments?.length === 1 && !('proof_path' in guest.payments[0]) && guest.payments[0].method === 'GCash'
          && staffRows.data?.length === 1 && staffRows.data[0].proof_path?.startsWith(`${probe.id}/incoming/`) && (chatRows.data ?? []).length === 0
          && ev?.length === 1 && ev[0].to_value === 'payment:submitted' && ev[0].actor_kind === 'guest' && ev[0].amount === 30000
          && viaStaff.data?.status === 'submitted',
        'manage: the guest sees the proof as being checked (no file path); staff read the row and stay_payment(); a chat token reads none; the log has it, by the guest',
        `guest ${guest?.payment?.status}/${guest?.payments?.length} · staff ${staffRows.data?.length} · chat ${(chatRows.data ?? []).length} · events ${JSON.stringify(ev)} · stay_payment ${viaStaff.error?.message ?? viaStaff.data?.status}`,
      );
    }

    // 137. Doors that stay shut: a not-tracked (staff) stay and a cancelled
    //      stay are 55000; the wrong contact is P0002 (a miss); another
    //      tenant's id is 42501.
    {
      const notTracked = await chat.rpc('submit_payment', {
        p_tenant_id: probe.id, p_reference: ref1, p_contact: contact.guest_email, p_proof_path: '', p_method: 'GCash',
        p_claimed_amount: 100, p_paid_on: '2026-10-10', p_payer_reference: null, p_idempotency_key: randomUUID(),
      });
      const cancelled = await chat.rpc('submit_payment', {
        p_tenant_id: probe.id, p_reference: two[0].reference, p_contact: contact.guest_email, p_proof_path: '', p_method: 'GCash',
        p_claimed_amount: 100, p_paid_on: '2026-10-10', p_payer_reference: null, p_idempotency_key: randomUUID(),
      });
      const miss = await submit({ p_contact: 'not.the.payer@example.com' });
      const { data: villaRow } = await supabase.from('tenants').select('id').eq('slug', 'villa').single();
      const foreign = await submit({ p_tenant_id: villaRow?.id ?? -1 });
      check(
        notTracked.error?.code === '55000' && (cancelled.error?.code === '55000' || cancelled.error?.code === 'P0002') && miss.error?.code === 'P0002' && foreign.error?.code === '42501',
        "manage: a not-tracked stay and a cancelled one take no payment (55000); the wrong contact is a miss (P0002); another tenant's id is 42501",
        `not tracked ${notTracked.error?.code} "${notTracked.error?.message}" · cancelled ${cancelled.error?.code} · miss ${miss.error?.code} · foreign ${foreign.error?.code}`,
      );
    }

    // 138. The proof is unreadable to the guest's token and signable by staff.
    {
      const path = proofs.at(-2) ?? proofs[0];
      const { data: dl } = await chat.storage.from('payment-proofs').download(path);
      const { data: signed, error: signError } = await staff.storage.from('payment-proofs').createSignedUrl(path, 300);
      const body = signed?.signedUrl ? Buffer.from(await (await fetch(signed.signedUrl)).arrayBuffer()) : null;
      check(
        !dl && body?.equals(PNG),
        'manage: a chat token cannot read a proof back; staff sign a URL that serves it',
        `chat download ${dl ? 'READ' : 'refused'} · staff ${signError?.message ?? `${body?.length} bytes identical ${body?.equals(PNG)}`}`,
      );
    }

    // 139–144 are manage-booking Phase 4: review, refund, settings, and the
    // confirm-needs-a-note rule. An ADMIN member joins the probe beside the
    // staff one, so every refusal of staff has its positive twin.
    const { data: adminUser, error: adminError } = await supabase.auth.admin.createUser({
      email: `manage-probe-admin-${Date.now()}@example.com`,
      password: randomBytes(24).toString('base64url'),
      email_confirm: true,
    });
    if (adminError) throw new Error(`admin user: ${adminError.message}`);
    probeUsers.push(adminUser.user.id);
    const adminMember = await supabase.from('memberships').insert({ user_id: adminUser.user.id, tenant_id: probe.id, role: 'admin' });
    if (adminMember.error) throw new Error(`admin membership: ${adminMember.error.message}`);
    const admin = asToken(staffToken(probe.id, adminUser.user.id));
    const { data: openPay } = await supabase.from('payments').select('id').eq('tenant_id', probe.id).eq('status', 'submitted').single();
    const reviewArgs = (over = {}) => ({ p_tenant_id: probe.id, p_payment_id: openPay.id, p_action: 'verify', p_amount: 30000, p_account_checked: true, p_note: null, p_confirm: true, ...over });

    // 139. Staff read but cannot decide: review, refund and settings are
    //      42501 for the staff role; nothing changed.
    {
      const review = await staff.rpc('review_payment', reviewArgs());
      const refund = await staff.rpc('record_refund', { p_tenant_id: probe.id, p_group_id: webStay.group_id, p_amount: 100, p_method: 'GCash', p_note: 'x' });
      const settings = await staff.rpc('set_payment_settings', { p_tenant_id: probe.id, p_payments: null });
      const { data: still } = await supabase.from('payments').select('status').eq('id', openPay.id).single();
      check(
        review.error?.code === '42501' && refund.error?.code === '42501' && settings.error?.code === '42501' && still?.status === 'submitted',
        'manage: a staff member cannot verify, refund or change payment settings (42501); the proof is still waiting',
        `review ${review.error?.code ?? 'DONE'} · refund ${refund.error?.code ?? 'DONE'} · settings ${settings.error?.code ?? 'DONE'} · ${still?.status}`,
      );
    }

    // 140. The admin's refusals in words: no "I checked the account", more
    //      than the total, a rejection with no reason.
    {
      const unchecked = await admin.rpc('review_payment', reviewArgs({ p_account_checked: false }));
      const tooMuch = await admin.rpc('review_payment', reviewArgs({ p_amount: 100001 }));
      const noReason = await admin.rpc('review_payment', reviewArgs({ p_action: 'reject', p_note: '  ' }));
      check(
        unchecked.error?.code === '22023' && /checked the account/.test(unchecked.error.message) && tooMuch.error?.code === '22023' && noReason.error?.code === '22023',
        'manage: verify needs "I checked the account" and an amount up to the total; reject needs a reason (22023, in words)',
        `unchecked ${unchecked.error?.code} · too much ${tooMuch.error?.code} · no reason ${noReason.error?.code}`,
      );
    }

    // 141. Verify-and-confirm: the payment verified with the admin's id, the
    //      stay confirmed in the same call, two events by staff; a second
    //      review is 55000.
    {
      const done = await admin.rpc('review_payment', reviewArgs());
      const { data: pay } = await supabase.from('payments').select('status, verified_amount, reviewed_by, account_checked').eq('id', openPay.id).single();
      const { data: rows } = await supabase.from('bookings').select('status, decision_note').eq('tenant_id', probe.id).eq('group_id', webStay.group_id);
      const { data: ev } = await supabase.from('booking_events').select('kind, from_value, to_value, actor_kind, actor_user').eq('tenant_id', probe.id).eq('group_id', webStay.group_id).order('id');
      const again = await admin.rpc('review_payment', reviewArgs());
      const tail = (ev ?? []).slice(-2);
      check(
        !done.error && done.data?.confirmed === true && done.data.payment?.status === 'partially_paid'
          && pay?.status === 'verified' && pay.verified_amount === 30000 && pay.reviewed_by === adminUser.user.id && pay.account_checked
          && rows?.every((r) => r.status === 'confirmed' && r.decision_note === 'Payment verified')
          && tail[0]?.to_value === 'payment:verified' && tail[1]?.to_value === 'confirmed' && tail.every((e) => e.actor_kind === 'staff' && e.actor_user === adminUser.user.id)
          && again.error?.code === '55000',
        'manage: verify-and-confirm verifies with the admin\'s id and confirms the stay in one call (two events, by that admin); a second review is 55000',
        `${done.error?.message ?? JSON.stringify(done.data)} · ${JSON.stringify(pay)} · rows ${rows?.map((r) => r.status).join(',')} · events ${tail.map((e) => e.to_value).join(',')} · again ${again.error?.code}`,
      );
    }

    // 142. § 9 q3: a TRACKED pending stay with nothing verified cannot be
    //      confirmed by staff without a note (23514); with one it can. A
    //      stay that is not tracked confirmed without a note in 129 already.
    {
      const { data: rows2, error: e2 } = await supabase.rpc('request_booking', {
        p_tenant_id: probe.id, p_slot_id: slotRow.id, p_unit_ids: [unit.B], p_guests: [1], p_check_in: '2027-04-26', p_nights: 1,
        p_name: 'Unpaid Probe', p_phone: '0918 333 4444', p_email: 'unpaid.probe@example.com', p_notes: null,
      });
      if (e2) throw new Error(`request_booking 2: ${e2.message}`);
      const { data: s2 } = await supabase.from('bookings').select('group_id').eq('tenant_id', probe.id).eq('reference', rows2[0].reference).limit(1).single();
      const bare = await staff.from('bookings').update({ status: 'confirmed' }).eq('tenant_id', probe.id).eq('group_id', s2.group_id).select('id');
      const noted = await staff.from('bookings').update({ status: 'confirmed', decision_note: 'Paid in cash at the front desk' }).eq('tenant_id', probe.id).eq('group_id', s2.group_id).select('id');
      check(
        bare.error?.code === '23514' && /No payment has been verified/.test(bare.error.message) && !noted.error && noted.data.length === 1,
        'manage: confirming a tracked stay with nothing verified needs a note (23514 without, done with "Paid in cash")',
        `bare ${bare.error?.code ?? 'CONFIRMED'} · noted ${noted.error?.message ?? noted.data.length}`,
      );
    }

    // 143. A refund: more than received is 22023; 100.00 of 300.00 is
    //      recorded, and the stay's received drops to 200.00.
    {
      const tooMuch = await admin.rpc('record_refund', { p_tenant_id: probe.id, p_group_id: webStay.group_id, p_amount: 30001, p_method: 'GCash', p_note: 'probe' });
      const ok = await admin.rpc('record_refund', { p_tenant_id: probe.id, p_group_id: webStay.group_id, p_amount: 10000, p_method: 'GCash', p_note: 'probe: partial refund' });
      const money = await admin.rpc('stay_payment', { p_tenant_id: probe.id, p_group_id: webStay.group_id });
      check(
        tooMuch.error?.code === '22023' && !ok.error && money.data?.received === 20000 && money.data.status === 'partially_paid',
        'manage: a refund over what was received is 22023; 100.00 refunded leaves 200.00 received',
        `too much ${tooMuch.error?.code} · ok ${ok.error?.message ?? ok.data} · ${JSON.stringify(money.data)}`,
      );
    }

    // 144. Settings: the admin's write touches the `payments` key only (the
    //      timezone stays); a bad shape is 23514; null turns payments off.
    {
      const next = { methods: [{ kind: 'bank', label: 'BDO', account_number: '0000-1111' }], fee: { kind: 'full' } };
      const saved = await admin.rpc('set_payment_settings', { p_tenant_id: probe.id, p_payments: next });
      const { data: cfg } = await supabase.from('tenant_applications').select('config').eq('tenant_id', probe.id).eq('application_key', 'bookings').single();
      const bad = await admin.rpc('set_payment_settings', { p_tenant_id: probe.id, p_payments: { methods: [], fee: { kind: 'full' } } });
      const off = await admin.rpc('set_payment_settings', { p_tenant_id: probe.id, p_payments: null });
      const { data: cfg2 } = await supabase.from('tenant_applications').select('config').eq('tenant_id', probe.id).eq('application_key', 'bookings').single();
      check(
        !saved.error && saved.data?.methods?.[0]?.label === 'BDO' && cfg?.config?.timezone === 'Asia/Manila' && cfg.config.booking_type === 'per_room'
          && bad.error?.code === '23514' && !off.error && cfg2?.config && !('payments' in cfg2.config) && cfg2.config.timezone === 'Asia/Manila',
        'manage: set_payment_settings writes the payments key alone; a bad shape is 23514; null turns payments off',
        `saved ${saved.error?.message ?? saved.data?.methods?.[0]?.label} · tz ${cfg?.config?.timezone} · bad ${bad.error?.code} · off ${off.error?.message ?? ('payments' in (cfg2?.config ?? {}) ? 'STILL ON' : 'off')}`,
      );
    }

    // 145–150 are manage-booking Phase 5: deadlines and holds
    // (schema-holds.sql). Fresh Mondays in May 2027, so nothing above is met.
    const baseConfig = { timezone: 'Asia/Manila', booking_type: 'per_room' };
    const setPay = async (hold) => {
      const { error } = await supabase.from('tenant_applications')
        .update({ config: { ...baseConfig, payments: { methods: [{ kind: 'gcash', label: 'GCash' }], fee: { kind: 'full' }, pay_within_hours: 24, review_within_hours: 24, hold } } })
        .eq('tenant_id', probe.id).eq('application_key', 'bookings');
      if (error) throw new Error(`settings ${hold}: ${error.message}`);
    };
    let contactN = 0;
    const requestStay = async (u, day) => {
      contactN++;
      const who = { email: `hold.probe.${contactN}@example.com`, phone: `0919${String(10000000 + contactN).slice(1)}` };
      const r = await supabase.rpc('request_booking', {
        p_tenant_id: probe.id, p_slot_id: slotRow.id, p_unit_ids: [unit[u]], p_guests: [1], p_check_in: day, p_nights: 1,
        p_name: 'Hold Probe', p_phone: who.phone, p_email: who.email, p_notes: null,
      });
      if (r.error) return { error: r.error };
      const { data: g } = await supabase.from('bookings').select('group_id').eq('tenant_id', probe.id).eq('reference', r.data[0].reference).limit(1).single();
      return { ref: r.data[0].reference, group: g.group_id, ...who };
    };
    const rowsOf = async (group) => (await supabase.from('bookings').select('status, held, held_until').eq('tenant_id', probe.id).eq('group_id', group)).data ?? [];
    const slotState = async (u, day) => {
      const { data } = await chat.rpc('check_room_availability', { p_tenant_id: probe.id, p_from: day, p_to: day, p_slot: null, p_unit: u, p_guests: null });
      return data?.[0]?.status;
    };
    const proofFor = async (stay) => chat.rpc('submit_payment', {
      p_tenant_id: probe.id, p_reference: stay.ref, p_contact: stay.email, p_proof_path: await uploadProof(), p_method: 'GCash',
      p_claimed_amount: 100000, p_paid_on: '2026-10-10', p_payer_reference: null, p_idempotency_key: randomUUID(),
    });

    // 145. hold "none" (today's rule, D-070): two requests share a night and
    //      the night stays open.
    {
      await setPay('none');
      const r1 = await requestStay('A', '2027-05-03');
      const r2 = await requestStay('A', '2027-05-03');
      const state = await slotState('A', '2027-05-03');
      const held = [...(await rowsOf(r1.group)), ...(await rowsOf(r2.group))].some((r) => r.held);
      check(
        !r1.error && !r2.error && state === 'open' && !held,
        'manage: with hold "none", two requests share a night, nothing is held, the night is open (D-070 stands)',
        `r1 ${r1.error?.message ?? r1.ref} · r2 ${r2.error?.message ?? r2.ref} · ${state} · held ${held}`,
      );
    }

    // 146. on_request: a web stay holds from birth until pay_by; the night
    //      reads taken; a second request is refused; a staff pending insert
    //      is refused in the hold's own words; the guest sees heldUntil.
    let held1 = null;
    {
      await setPay('on_request');
      held1 = await requestStay('A', '2027-05-10');
      const rows = await rowsOf(held1.group);
      const { data: s } = await supabase.from('stays').select('pay_by').eq('tenant_id', probe.id).eq('group_id', held1.group).single();
      const state = await slotState('A', '2027-05-10');
      const second = await requestStay('A', '2027-05-10');
      const staffInsert = await staff.from('bookings').insert({ tenant_id: probe.id, unit_id: unit.A, slot_id: slotRow.id, booked_date: '2027-05-10', guest_name: 'Walk-in', guest_count: 1 }).select('id');
      const guest = (await lookup(held1.ref, held1.email)).data;
      check(
        rows.every((r) => r.held && r.held_until === s?.pay_by) && state === 'taken' && second.error?.code === '23P01'
          && staffInsert.error?.code === '23P01' && /held for another guest/.test(staffInsert.error.message) && guest?.held_until,
        'manage: on_request holds a web stay until pay_by; the night is taken; a second request and a staff booking are refused (the hold\'s words)',
        `rows ${JSON.stringify(rows)} pay_by ${s?.pay_by} · ${state} · second ${second.error?.code} · staff ${staffInsert.error?.code} "${staffInsert.error?.message}" · guest held_until ${guest?.held_until}`,
      );
    }

    // 147. A lapsed hold blocks nothing, with no job: the read says open at
    //      once, and the next insert releases it and lands.
    {
      await supabase.from('bookings').update({ held_until: new Date(Date.now() - 60000).toISOString() }).eq('tenant_id', probe.id).eq('group_id', held1.group);
      const state = await slotState('A', '2027-05-10');
      const next = await requestStay('A', '2027-05-10');
      const old = await rowsOf(held1.group);
      check(
        state === 'open' && !next.error && old.every((r) => !r.held && r.status === 'pending'),
        'manage: a lapsed hold reads open at once and is released by the next insert, which lands (no job needed)',
        `${state} · next ${next.error?.message ?? next.ref} · old ${JSON.stringify(old)}`,
      );
      held1 = next.error ? held1 : next;
    }

    // 148. on_proof: no hold at birth; a proof holds until review_by; a
    //      rejection releases it.
    {
      await setPay('on_proof');
      const r = await requestStay('B', '2027-05-17');
      const before = await rowsOf(r.group);
      const sent = await proofFor(r);
      const during = await rowsOf(r.group);
      const { data: s } = await supabase.from('stays').select('review_by').eq('tenant_id', probe.id).eq('group_id', r.group).single();
      const rejected = await admin.rpc('review_payment', { p_tenant_id: probe.id, p_payment_id: sent.data, p_action: 'reject', p_amount: null, p_account_checked: false, p_note: 'probe: blurry', p_confirm: false });
      const after = await rowsOf(r.group);
      check(
        before.every((x) => !x.held) && !sent.error && during.every((x) => x.held && x.held_until === s?.review_by) && !rejected.error && after.every((x) => !x.held),
        'manage: on_proof holds nothing at birth, holds from the proof until review_by, and a rejection releases it',
        `before ${JSON.stringify(before)} · sent ${sent.error?.message ?? sent.data} · during ${JSON.stringify(during)} · after ${JSON.stringify(after)}`,
      );
    }

    // 149. Expiry: past pay_by with nothing sent, the guest reads "expired"
    //      before any sweep and cannot pay; the sweep writes it as the system,
    //      once. A stay whose proof came BEFORE pay_by is left alone.
    {
      const late = await requestStay('B', '2027-05-24');
      const inTime = await requestStay('B', '2027-05-31');
      const proof = await proofFor(inTime);
      const past = new Date(Date.now() - 60000).toISOString();
      await supabase.from('stays').update({ pay_by: past }).eq('tenant_id', probe.id).in('group_id', [late.group, inTime.group]);
      // the proof must count as sent BEFORE pay_by
      await supabase.from('payments').update({ created_at: new Date(Date.now() - 120000).toISOString() }).eq('id', proof.data);
      const guest = (await lookup(late.ref, late.email)).data;
      const pay = await chat.rpc('submit_payment', {
        p_tenant_id: probe.id, p_reference: late.ref, p_contact: late.email, p_proof_path: await uploadProof(), p_method: 'GCash',
        p_claimed_amount: 100, p_paid_on: '2026-10-10', p_payer_reference: null, p_idempotency_key: randomUUID(),
      });
      const swept = await staff.rpc('expire_due_stays', { p_tenant_id: probe.id });
      const again = await staff.rpc('expire_due_stays', { p_tenant_id: probe.id });
      const lateRows = await rowsOf(late.group);
      const inTimeRows = await rowsOf(inTime.group);
      const { data: ev } = await supabase.from('booking_events').select('actor_kind, to_value, note').eq('tenant_id', probe.id).eq('group_id', late.group).order('id', { ascending: false }).limit(1).single();
      check(
        guest?.status === 'expired' && pay.error?.code === '55000' && /time to pay/.test(pay.error.message)
          && swept.data >= 1 && again.data === 0 && lateRows.every((r) => r.status === 'expired')
          && inTimeRows.every((r) => r.status === 'pending') && ev?.actor_kind === 'system' && ev.to_value === 'expired',
        'manage: a due stay reads expired before the sweep and takes no proof; the sweep expires it once, as the system; a proof sent in time keeps its stay',
        `guest ${guest?.status} · pay ${pay.error?.code} · swept ${swept.error?.message ?? swept.data} again ${again.data} · late ${lateRows.map((r) => r.status)} · in time ${inTimeRows.map((r) => r.status)} · ${JSON.stringify(ev)}`,
      );
    }

    // 150. Leaving pending drops the hold: confirming the held stay (with a
    //      note) leaves it confirmed and not held; cancelling another frees it.
    {
      await setPay('on_request');
      const r = await requestStay('B', '2027-06-07');
      const heldBefore = (await rowsOf(r.group)).every((x) => x.held);
      const confirm = await staff.from('bookings').update({ status: 'confirmed', decision_note: 'probe: paid at the desk' }).eq('tenant_id', probe.id).eq('group_id', r.group).select('id');
      const after = await rowsOf(r.group);
      const other = await requestStay('A', '2027-06-07');
      const cancel = await staff.from('bookings').update({ status: 'cancelled', decision_note: 'probe' }).eq('tenant_id', probe.id).eq('group_id', other.group).select('id');
      const freed = await rowsOf(other.group);
      check(
        heldBefore && !confirm.error && after.every((x) => x.status === 'confirmed' && !x.held && x.held_until === null)
          && !cancel.error && freed.every((x) => x.status === 'cancelled' && !x.held),
        'manage: confirming a held stay keeps it confirmed and drops the flag; cancelling one frees it',
        `held ${heldBefore} · ${confirm.error?.message ?? JSON.stringify(after)} · cancel ${cancel.error?.message ?? JSON.stringify(freed)}`,
      );
    }
  } catch (error) {
    check(false, 'manage: probe setup', error.message);
  } finally {
    if (probeProofs.length) {
      const { data: removed } = await supabase.storage.from('payment-proofs').remove(probeProofs);
      if ((removed?.length ?? 0) !== probeProofs.length) console.log(`WARN  removed ${removed?.length ?? 0} of ${probeProofs.length} probe proofs`);
    }
    const { error } = await supabase.from('tenants').delete().eq('id', probe.id);
    if (error) console.log(`WARN  could not delete the manage-probe tenant: ${error.message}`);
    for (const id of [userId, ...probeUsers].filter(Boolean)) {
      const { error: userError } = await supabase.auth.admin.deleteUser(id);
      if (userError) console.log(`WARN  could not delete a manage-probe user: ${userError.message}`);
    }
  }
}

console.log();
console.log(
  `documents ${counts.documents} · chunks ${counts.chunks} · ` +
    `conversations ${counts.conversations} · messages ${counts.messages}`,
);
console.log(failures === 0 ? '\nOK — the database layer is wired correctly.' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
