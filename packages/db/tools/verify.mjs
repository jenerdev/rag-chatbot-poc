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
// Run:  pnpm --filter @rag/db verify

import { supabase, parseStoredVector, VECTOR_DIMENSIONS } from '../dist/index.js';

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
