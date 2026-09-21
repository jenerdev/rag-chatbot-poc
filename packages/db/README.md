# `@rag/db`

One configured Supabase client, the database's shape, and the two RPC row types
retrieval reads. No query logic — every database call stays visible at its call
site in `@rag/pipeline`.

## The guard, and its one cost

`src/client.ts` opens with `import 'server-only'`. A Client Component that
imports this package — directly, or through a barrel file re-exporting both
halves of an app — **fails at build time** instead of inlining the
`service_role` key into a JavaScript bundle and serving it to every visitor.
That key bypasses Row Level Security entirely (D-006, `risks.md` § R-2).

The mechanism is a conditional export: `server-only` resolves to an empty module
under the `react-server` condition and to a module that throws under every
other. Verified both ways on 2026-09-22:

```
node                             → This module cannot be imported from a Client Component module.
node --conditions=react-server   → imports fine
```

**The cost: a plain Node process has no `react-server` condition either.** Any
script that imports this package, or anything that imports it, must run as:

```sh
node --conditions=react-server your-script.mjs
```

That is why `pnpm --filter @rag/db verify` carries the flag, and it is why
`pnpm eval` and `pnpm scores` will need it from Phase 4 onward, when the tools
start importing `@rag/pipeline`. A flag on a few scripts is a smaller price than
a master key in a bundle.

## Verifying the connection

```sh
pnpm --filter @rag/db verify
```

Ten checks, **none of which need an OpenAI key**: all four tables readable, a
stored embedding parsing to 1,536 finite numbers, and `match_chunks` returning
`MatchRow`-shaped rows. The query vector is an embedding already in the
database, so the run is free.

The sharpest check is the cheapest: a chunk searched against **its own**
embedding must come back first with a similarity of exactly 1. If it does not,
the column is not behaving as a vector — the failure `CLAUDE.md` § 5 describes,
which otherwise produces no error at all, just quietly meaningless results.

## The schema

`sql/schema.sql` then `sql/schema-hybrid.sql`, pasted into the Supabase SQL
editor, in that order. Both are idempotent enough to re-read but are not
migrations — this project has no migration tool, and the files are the record of
what ran.

Two things in there that are not obvious and are expensive to get wrong:

- **HNSW, not ivfflat.** HNSW builds on an empty table; ivfflat needs rows to
  train on first.
- **`order by embedding <=> query_embedding`** — ascending *distance*, which is
  what lets Postgres use that index. `similarity` in the returned rows is
  `1 - distance`, so higher is closer. The two run in opposite directions, and
  confusing them yields a search that confidently returns the least relevant
  chunks.

## Types

`src/database.types.ts` is **hand-written from the two `.sql` files**, not
generated — the generator needs credentials this repo does not carry, and the
direct database host no longer resolves. The header of that file records the
command to regenerate and says to diff rather than trust.

The part worth reading before writing anything that touches embeddings: a
`vector(1536)` column comes back from PostgREST **as a string**, and it is typed
that way on purpose. `parseStoredVector()` is the one correct way to read one
back into numbers.
