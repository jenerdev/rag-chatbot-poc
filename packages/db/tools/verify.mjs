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
