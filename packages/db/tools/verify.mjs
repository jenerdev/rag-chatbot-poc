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
  for (const table of ['documents', 'chunks', 'conversations', 'messages']) {
    const { data, error } = await villaChat.from(table).select('tenant_id');
    const { count: truth } = await supabase.from(table).select('*', { count: 'exact', head: true }).eq('tenant_id', villa);
    const foreign = (data ?? []).filter((r) => r.tenant_id !== villa).length;
    check(
      !error && foreign === 0 && data.length === truth,
      `auth: RLS alone, ${table} under villa's token`,
      error ? error.message : `${data.length} rows, ${foreign} foreign, villa has ${truth}`,
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
      !pub.error && keys === 'assistant_name,banner_url,business_name,id,logo_url,slug,theme',
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
