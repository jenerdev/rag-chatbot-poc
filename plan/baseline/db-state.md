# Database state at Phase 0

Observed 2026-09-21, read-only, against Supabase project `jkpdxolpydnenxeljmln`.
Commit at the time of capture: `dead56e`.

## Row counts

| Table | Rows |
|---|---|
| `documents` | 8 |
| `chunks` | 30 |
| `conversations` | 150 |
| `messages` | 428 |

## Documents loaded

All eight are the Villa Amihan corpus, ingested 2026-09-19 between 19:34 and
19:35 UTC. None has a `source` value.

| id | Title |
|---|---|
| 27 | Villa Amihan Private Resort — Overview |
| 28 | Villa Amihan — Rates and Booking Schedules |
| 29 | Villa Amihan — Amenities and Facilities |
| 30 | Villa Amihan — Booking, Payment and Cancellation |
| 31 | Villa Amihan — House Rules |
| 32 | Villa Amihan — Directions and Getting There |
| 33 | Villa Amihan — Events and Add-Ons |
| 34 | Frequently Asked Questions |

8 documents → 30 chunks, an average of 3.75 chunks per document at
`CHUNK_SIZE = 1000` / `CHUNK_OVERLAP = 150`.

## The embedding comes back from PostgREST as a string

Selecting `embedding` from `chunks` returns:

```
typeof = string    dims after JSON.parse = 1536    first value = 0.00051546097
```

**This is not the trap from `CLAUDE.md` § 5, and nothing is broken.** The
column is a real `vector(1536)` — it parses cleanly to 1,536 numbers and
`match_chunks` orders by `<=>` against it correctly, which a text column could
not do. What is a string is only PostgREST's *JSON serialisation* of the vector
type on the way out.

It is recorded here because it matters twice during the migration:

- **Phase 3.** `supabase gen types typescript` will type this column as
  `string`. Typing it `number[]` to "fix" that would be a lie the compiler
  accepts and the runtime does not. The plan's runtime guard stays.
- **Nothing in the pipeline reads it back.** `rag.js` selects `embedding` only
  on insert; every comparison happens inside Postgres. If a future change does
  start reading vectors into JS, the parse is the step that must not be
  forgotten.

## Baseline eval and scores: NOT captured

`plan/baseline/eval-before.txt` and `scores-before.txt` do **not** exist yet, by
decision on 2026-09-21: capturing them requires clearing the Villa Amihan corpus
from the database, and the database was left alone.

The two corpora cannot be loaded at once for this purpose.
`sample-documents/03-amenities-and-facilities.md` documents the resort's
parking, so with both loaded the eval case `absent-2` — *"How many parking
spaces does the building have?"*, which exists to prove a plausible-but-absent
fact is still refused — receives a genuine answer and is scored a failure. The
battery would report a regression that is not one.

### What this costs later

Phase 4's "done when" is *`pnpm eval` gives the same six verdicts as the
baseline*. Without the baseline there is nothing to compare against, and the
TypeScript port of `rag.js` would be verified by reading it rather than by
measuring it.

### To capture it when ready

```sh
# 1. clear the corpus (chat history is untouched — no cascade from documents)
#    admin page at http://localhost:3000/admin.html, or:
for id in 27 28 29 30 31 32 33 34; do curl -X DELETE http://localhost:3000/api/documents/$id; done

# 2. load the one corpus the battery asserts against
curl -X POST http://localhost:3000/api/documents \
  -H 'Content-Type: application/json' -d @fixtures/northwind.json

# 3. capture
npm run eval   > plan/baseline/eval-before.txt
npm run scores > plan/baseline/scores-before.txt

# 4. restore the manual-test corpus, if wanted — the source is in the repo
#    (sample-documents/01-*.md … 08-*.md, via the admin page)
```

Expected shape from `notes.md`, for recognising a wrong result: six cases, three
wanting an answer and three wanting the refusal; direct hits scoring around
0.46–0.53, off-topic questions well under `MIN_SIMILARITY = 0.25`.
