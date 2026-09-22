# `match_chunks` ids and pgvector version, before tenancy

Observed 2026-09-23 against commit `d01302a`, with `fixtures/northwind.json`
loaded and nothing else: **document 37, chunks 137–140** (1 document, 4 chunks).
Tenancy Phase 2 compares against these to prove the tenant filter did not
change what the index returns.

Called directly as `supabase.rpc('match_chunks', { match_count: 5, ... })`,
bypassing fusion, so these are the raw vector-search results.

**Only four ids exist, not the five `plan.md` asks for.** The corpus has four
chunks, so `match_count: 5` can return at most four.

| Question | `min_similarity` | Ids (similarity), in the order returned |
|---|---|---|
| What temperature does the Bay 3 freezer run at? | 0    | 139 (0.530) · 138 (0.364) · 140 (0.316) · 137 (0.289) |
| What temperature does the Bay 3 freezer run at? | 0.25 | 139 (0.530) · 138 (0.364) · 140 (0.316) · 137 (0.289) |
| Who do I contact on extension 4417?             | 0    | 140 (0.372) · 137 (0.318) · 138 (0.281) · 139 (0.223) |
| Who do I contact on extension 4417?             | 0.25 | 140 (0.372) · 137 (0.318) · 138 (0.281) |

`0.25` is `MIN_SIMILARITY` in `packages/rag/src/constants.ts`. The similarities
match `pnpm scores` and `pnpm eval` exactly, so both paths search the same
embeddings.

## pgvector version

**0.8.2**, reported by the user on 2026-09-23 from the Supabase SQL editor:

```sql
select extversion from pg_extension where extname = 'vector';
```

That is ≥ 0.8.0, so `hnsw.iterative_scan`, option 1 in `plan.md` § 2.1, is
available for Phase 2.
