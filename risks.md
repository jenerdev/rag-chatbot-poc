# Risks — RAG Chatbot POC

Ordered by how likely they are to actually bite you.

The honest framing: this is a local learning POC with no users and no data worth
stealing, so most "risks" here are not business risks — they are **the specific
ways this build goes wrong**. That is what makes them worth writing down.

---

## R-1 · Leaking the OpenAI API key · **High impact, easy to avoid**

**The risk:** an API key in client-side code is a key anyone can read. Key
scrapers crawl GitHub continuously, and a leaked key gets used within minutes —
against *your* prepaid credits.

**Why it can happen here:** it is genuinely tempting to call OpenAI directly
from `public/app.js`. It works instantly on localhost and skips writing a route.
Every "quick test" that does this is one commit away from a public repo.

**Mitigation — all three, non-negotiable:**

1. **All OpenAI calls happen in Express.** The browser calls your server; your
   server calls OpenAI. This is the reason the architecture has a backend at all
   (`architecture.md` § 2).
2. **`.env` is in `.gitignore` before the first commit,** not after. Commit
   `.env.example` with empty values instead.
3. **Set a spending limit** in OpenAI Billing (`costs.md` § Cost safety). It
   caps the damage of any leak to an amount you chose.

**If a key does leak:** revoke it at platform.openai.com immediately and create a
new one. Deleting the commit does not help — it is already indexed.

---

## R-2 · `service_role` key + no RLS becomes a real hole the moment this is deployed · **Low now, high later**

**The risk:** D-006 uses Supabase's `service_role` key, which **bypasses Row
Level Security entirely**, and the POC writes no RLS policies. Locally that is
fine — one user, one trusted server. The risk is that the shortcut travels.

**Why it can happen:** "let me just put this on Render to show someone" is a
five-minute action, and nothing in the code will complain.

**Mitigation:**

- The `service_role` key lives only in `.env`, only in Express, and is **never**
  sent to the browser — same rule as R-1.
- **Done 2026-09-20:** RLS is enabled on all four tables (no policies), so the
  tables are not readable or writable with the `anon` key even if it leaks. See
  the amendment to D-006.
- Treat deployment as a hard trigger: the first deploy means enabling RLS,
  writing policies, and switching the browser-facing path to the anon key. It is
  flagged in `decisions.md` D-006 and `mvp.md` Out of scope.
- If you deploy without doing that, the tables are readable and writable by
  anyone who finds the URL.

**Amended 2026-09-23, tenancy: this risk is now larger, not smaller.** The server
serves several tenants that do not trust each other, through a key that
bypasses RLS for all of them. A missing policy used to mean "a stranger could
read the one knowledge base". Now it also means "one tenant's reads are held
apart from another's only by application code". See R-11 and the D-006
amendment.

---

## R-3 · Silent retrieval failure — the answer looks right and isn't · **Most likely to actually happen**

**The risk:** RAG fails quietly. Every failure mode below produces a confident,
fluent, wrong answer with no error anywhere:

| Failure | Cause |
|---|---|
| Mismatched embedding models | Question embedded with a different model than the documents. Similarity scores are computed, look reasonable, and mean nothing (D-004). |
| Threshold too low | Irrelevant chunks retrieved for an unrelated question, then answered from (D-008). |
| Threshold too high | Refuses questions it actually has the answer to. |
| Bad chunk boundaries | The answer is split across two chunks and neither one alone contains it. |
| Embedding stored as a string | `supabase-js` sends the array as JSON; if the column type or the insert is wrong you can end up with text where a vector should be. Search then behaves bizarrely. |

**Mitigation:**

- **The sources panel (D-012) is the primary defence.** Every answer shows the
  chunks it used and their scores. A wrong answer with visible sources is
  immediately diagnosable; without them it is a mystery.
- **Phase 1.2 of the roadmap** verifies a stored embedding round-trips as 1536
  numbers, not a string — before any pipeline exists to confuse the issue.
- **Phase 3.1** requires reading real similarity scores before tuning the
  threshold, so the number is chosen from evidence.
- **Phase 5.3 and 5.5** deliberately break retrieval to see what the failure
  looks like, so you recognise it later.

**This is the risk with the highest expected cost, because it is the one you
cannot see.** Everything else at least throws.

---

## R-4 · Scope creep turning a POC into a product · **The most likely way this doesn't finish**

**The risk:** it works, it's satisfying, and then it needs auth, and streaming,
and PDF upload, and deployment. Six weeks later there is a half-built product
and the learning goal was met in week one but never marked done.

**Why it can happen:** every addition is individually reasonable.

**Mitigation:**

- `mvp.md` § "Explicitly OUT of the MVP" is a long, specific list for exactly
  this reason. Read it when tempted.
- **The test:** does this feature teach me something about retrieval-augmented
  generation? If no, it is post-MVP.
- **Phase 5 is the finish line, not Phase 4.** The project is done when you
  understand it, not when the UI is pretty.
- If it genuinely deserves to become a product, that is a **new folder in
  `ideas/`** with a fresh intake — not a mutation of this one.

---

## R-5 · Blocked in Phase 0 on OpenAI billing · **Low, but it stops everything**

**The risk:** an API key with no credits behind it returns a quota error on
every call. If you assumed a ChatGPT subscription covers it (see `costs.md`),
this is confusing rather than obvious — the key exists, it is valid, and it
still fails.

**Mitigation:** Phase 0.1 adds credits *before* the key is created. Phase 1.1's
throwaway embed script proves billing works before any real code exists.

---

## R-6 · pgvector setup problems · **Low**

**The risk:** `create extension vector` not run, dimension mismatch between
column and model, or the HNSW index failing to build.

**Mitigation:**

- `schema.sql` is a single runnable file (`architecture.md` § 4) — run it once,
  in order, rather than assembling statements ad hoc.
- Phase 0.6 verifies the extension is enabled with an explicit query.
- HNSW (not ivfflat) is specified precisely because it builds on an empty table;
  ivfflat needs existing rows to train on and errors or degrades if created
  first.
- A dimension mismatch fails loudly at insert time, which is the good kind of
  failure.

---

## R-7 · Partial ingest leaves an unsearchable document · **Low impact, easy to miss**

**The risk:** the `documents` row inserts, the embedding call then fails, and
you are left with a document that appears in the list but has zero chunks. It
can never be retrieved, and nothing indicates why.

**Mitigation:** delete the `documents` row in a `catch` before rethrowing, and
show a "⚠ 0 chunks" badge in the admin list (`screens.md` § S-2). Not a
transaction — just cleanup and a visible symptom.

---

## R-8 · Model or API changes before you build · **Low, and cheap to check**

**The risk:** `gpt-4o-mini`, `text-embedding-3-small` and the prices in
`costs.md` were current on 2026-09-20. Model lineups move; a deprecated model id
returns a 404 that reads like a routing bug.

**Mitigation:** Phase 0 checks the current model list. Both models are env vars
(D-005), so switching the chat model is a config change. Switching the
*embedding* model is not cheap — it means a schema change and a full re-ingest
(D-004) — so confirm that one before ingesting anything real.

---

## R-9 · Shipping this build's tuned numbers to a different corpus · **Certain, if you forget**

**The risk:** every tuned value in this repo was measured against **one invented
2,607-character test document**. `MIN_SIMILARITY = 0.25`, `CHUNK_SIZE = 1000`,
`MATCH_COUNT = 5`, and the choice of `gpt-4o-mini` are all defensible *here* and
none of them transfer. Deploy them unexamined against a real corpus and the
failure is the quiet kind: plausible answers, no errors.

**Why it can happen:** the numbers look considered, because they are — they have
measurements written next to them in the source. It is easy to read a
well-justified constant as a settled one.

**Mitigation — two commands, both kept in `tools/` precisely so they survive:**

- **`npm run scores`** — prints real similarity scores with the threshold
  disabled. Reset `MIN_SIMILARITY` from the gap between your genuine questions
  and your off-topic ones.
- **`npm run eval`** — the prompt battery. Rewrite its cases to use your own
  documents' facts, then run it against each candidate chat model. It checks
  both directions: that real questions get answered, and that absent facts are
  still refused.

**This also decides the model.** `gpt-4o-mini` scored 5/6 and `gpt-4o` 6/6 on an
identical prompt at ~16× the input cost (D-017). The difference was applying a
general rule where the document also stated an exception — so whether it matters
depends entirely on whether your documents have carve-outs.

Full list in `README.md` § "Before you put this in production".

---

## R-10 · HNSW post-filtering loses recall as tenants multiply · **Low now, grows with every tenant**

**The risk:** one HNSW graph holds every tenant's chunks (D-025). When the
planner uses that index for a tenant-scoped search, it walks the graph in
distance order and throws away other tenants' rows *after* the walk. If the
walk ends before enough of this tenant's rows have passed, the search returns
short, or empty.

**Measured in tenancy Phase 2** (northwind 4 chunks, villa 30, pgvector
0.8.2). With HNSW forced and `hnsw.ef_search = 2`, villa got **0 rows**: both
chunks the walk visited were northwind's. The pipeline then logs
`[retrieve] villa vector:0`, the D-008 short circuit fires, and the bot refuses
a question its documents answer. Nothing errors.

**Why it is low today:** at this size the planner does not use HNSW for a
tenant-scoped search at all. It reads `chunks_tenant_idx` and sorts exactly.

**Mitigation:** `match_chunks` sets `hnsw.iterative_scan = 'strict_order'`, and
with that the same forced query returned **5**. The walk keeps going instead of
giving up. It is still bounded by `hnsw.max_scan_tuples` (default 20,000).
**Re-measure at ten tenants and at fifty**, the way `notes.md` § "Tenancy
Phase 2" did. The symptom to watch for in the logs is `[retrieve] <slug>
vector:0` on a question that should hit.

---

## R-11 · Isolation is enforced by application code, not by the database · **The one that would be a breach**

**The risk:** `service_role` bypasses RLS (D-006). The composite foreign keys
protect *writes*: a chunk or message cannot be filed under the wrong tenant.
But every *read* is a `tenant_id` filter that someone remembered to write. One
missed filter is a cross-tenant read that throws no error, logs nothing, and
returns plausible answers.

**Why it can happen:** the next feature adds a query, and the query works,
because it returns rows.

**Mitigation, all observed passing 2026-09-23:**

- The pipeline cannot be called without a tenant (D-027). The grep of every
  `from(...)`/`rpc(...)` line in `packages/rag/src` shows a tenant on 15 of 15.
  Re-run it and read it after any change there.
- **`pnpm --filter @rag/pipeline isolation`: 11/11.** It covers cross-tenant
  list, chunks, delete, answer, conversation reuse, transcript read and ingest.
- **The eval battery's leak cases:**
  - leak-1: northwind refuses villa's parking fact;
  - leak-2: northwind refuses villa's Wi-Fi password, and a control proves it
    is findable from villa;
  - leak-3: a villa transcript read as northwind is `null`.
- `verify.mjs` check 14: a search as another tenant returns 0 rows.

The real fix is RLS policies that carry the tenant (R-2). Until then, those
suites are the only things that will catch a regression.

---

## R-12 · A persona erodes refusals over time · **Re-opened by every prompt edit**

**The risk:** the per-tenant persona (D-029) is a line that invites the model to
be helpful. A later edit that makes it friendlier, more confident or more
"expert" can quietly turn a refusal into an answer from training data.

**Measured so far:** adding the persona changed **none** of the six Northwind
verdicts, on two runs. The battery reads 9/10.

**Mitigation:** tenancy Phase 4's gate is the mechanism. Diff the six verdicts
against `plan/baseline/eval-pre-tenancy.txt`, and treat a single flipped verdict
as the persona being wrong, not the battery being strict. CLAUDE.md rule 1 is
what keeps that gate applied.

---

## R-13 · No rate limit on the admin key · **Low while local; the first thing to add if public**

**The risk:** `POST /api/t/<slug>/admin/session` accepts as many attempts as it
is sent. Nothing throttles them, and failed attempts are not logged anywhere
beyond the normal request log.

**Why it is low:** the key is 32 random bytes (43 characters, base64url), so
guessing it is not a real attack. Each attempt also costs the server an scrypt
hash, about 50 ms measured.

**Why nothing was added:** it was deliberate. A rate limit needs state that
outlives a request, and `architecture.md` § 9 rules out retry loops and hidden
in-memory state. **Add it before a public URL**, together with audit logging of
admin actions.

---

## Explicitly still missing after tenancy

Not risks of the build as it stands, but things a real multi-tenant product
needs and this one does not have: RLS policies, tenant self-signup, per-tenant
OpenAI keys or spend caps, usage metering, audit logging of admin actions, and
any way for a tenant to export or delete everything it owns (`plan.md` § 6).

---

## What to validate before committing real time

Ordered. The first two are Phase 1 and take under an hour combined.

1. **An embedding call works and returns 1536 numbers.** Proves billing, key,
   network and model name in one go.
2. **A vector round-trips through Supabase intact** — inserted as an array, read
   back as 1536 numbers. Proves the schema.
3. **`match_chunks` returns sensible ordering** on three hand-written chunks with
   obviously different topics. Proves the search.

If all three pass, nothing significant is left to derisk — the rest is assembly.
