// @rag/db — how a request reaches the database, the database's shape, and
// the two RPC row types the retrieval step reads.
//
// There is no client here that bypasses RLS. That one is `@rag/db/service`,
// for tools only (plan/auth-rls.md Rule 2).

export { anonClient, mintTenantToken, scopedClient, TENANT_TOKEN_SECONDS } from './tenant-client.js';
export type { DbClient } from './tenant-client.js';
export { generateAdminKey, hashAdminKey, verifyAdminKey } from './admin-key.js';
export type { Database, Json, StoredVector, VectorInput } from './database.types.js';

/** The expected dimensions, coupled to the embedding model by `vector(1536)` (D-004). */
export const VECTOR_DIMENSIONS = 1536;

/**
 * One row from `match_chunks` — cosine similarity search.
 *
 * Hand-written rather than read out of the generated `Database` type, because
 * this is the shape the pipeline actually codes against and it deserves a name
 * at the point of use. `similarity` is `1 - cosine distance`, so **higher is
 * closer** — while the SQL orders by distance **ascending**, which is what lets
 * Postgres use the HNSW index. Those two facts point in opposite directions and
 * getting them confused is the classic way to build a search that returns the
 * least relevant chunks with total confidence.
 */
export interface MatchRow {
  id: number;
  document_id: number;
  content: string;
  similarity: number;
}

/**
 * One row from `match_chunks_fts` — Postgres full-text search.
 *
 * Carries BOTH scores. `rank` is what found it; `similarity` is the cosine
 * score it would have had, included so the sources panel can tell the story of
 * a chunk that keyword search rescued at a similarity below the threshold
 * (D-015 — `"extension 4417"` scored 0.284, under `MIN_SIMILARITY` of 0.25's
 * predecessor 0.30, despite being an exact string match).
 */
export interface FtsRow extends MatchRow {
  rank: number;
}

/**
 * Read a stored embedding back into numbers.
 *
 * **The guard the type system cannot give you.** A `vector(1536)` column comes
 * back from PostgREST as a *string* — see `StoredVector`. That is normal. What
 * is not normal, and what `CLAUDE.md` § 5 warns about, is a vector that was
 * stored into a **text** column by accident: it round-trips, it looks similar,
 * and it makes search behave strangely with no error anywhere, because the
 * comparison silently stops being a vector comparison.
 *
 * Nothing in the pipeline reads an embedding back today — every comparison
 * happens inside Postgres, which is the whole point of `match_chunks`. This
 * exists for the verification script, and for the first piece of code that
 * does need one, so that it is not written from scratch in a hurry.
 */
export function parseStoredVector(value: unknown): number[] {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;

  if (!Array.isArray(parsed)) {
    throw new Error(`Expected an embedding array, got ${typeof parsed}`);
  }
  if (!parsed.every((n): n is number => typeof n === 'number' && Number.isFinite(n))) {
    throw new Error('Embedding contains a value that is not a finite number');
  }
  if (parsed.length !== VECTOR_DIMENSIONS) {
    // A different length means the embedding model changed without the schema
    // changing with it. Old vectors are not convertible (CLAUDE.md trap 3).
    throw new Error(
      `Embedding has ${parsed.length} dimensions; the schema declares ${VECTOR_DIMENSIONS}. ` +
        'The embedding model and the vector(n) column must agree.',
    );
  }
  return parsed;
}
