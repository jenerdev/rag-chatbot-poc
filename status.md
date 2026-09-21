# Status — RAG Chatbot POC

> **What this file is:** the live "where am I / what's next" log for the **build
> phase**. Unlike `mvp.md` (the whole plan), this file answers one question:
> **when I sit down to work, what do I do next?**
>
> **Keep it current.** Update it after **every completed step** (not just at the
> end of a session): mark what got done, bump the progress %, and set "Next up"
> so the next session (you or a fresh Claude) starts immediately without
> re-reading everything.
>
> Last updated: 2026-09-22

---

## Snapshot

- **Overall progress:** **100% — all five phases complete**, plus five post-MVP
  changes: hybrid search (D-015), query rewriting (D-016), reworded grounding
  instruction (D-017), paragraph-aware chunking (D-018), streaming (D-019).
  **The entire original post-MVP list is now done.**
- **Current phase:** **migration** to Next.js + TypeScript on Turborepo
  ([`plan/steps.md`](./plan/steps.md), 8 phases). **Phases 0–3 done, Phase 4
  code complete but NOT closed**, as of 2026-09-22, on branch
  `feat/nextjs-migration`
- **Status:** the whole pipeline is ported — `@rag/chunker` (87/0 byte-identical),
  `@rag/openai`, `@rag/db` (10/10), `@rag/pipeline` (22/0 on everything
  reachable without an API key). **Tenancy decided: single tenant.**
  ⚠ **The OpenAI API key is invalid**, so the four functions that call OpenAI
  are unverified and `pnpm eval` cannot run
- **Working on right now:** nothing

---

## ▶ Next up (do this next)

**1. Replace `OPENAI_API_KEY` in `.env`.** OpenAI returned *"Your API key has
expired"* on 2026-09-21 and *"Your API key has been invalidated."* on
2026-09-22 — same 401 either way. Nothing that calls OpenAI runs until this is
done: not the app, not `pnpm eval`, not `pnpm scores`, not the deferred
baseline, not the `embed() -> 1536` check carried over from Phase 2. New key at
<https://platform.openai.com/api-keys>; check billing is still live while there
(`costs.md`).

**2. Close Phase 4.** The code is written and 22/0 on everything provable
offline, but four functions that call OpenAI — `ingestDocument`,
`rewriteQuestion`, `answerQuestion`, `answerQuestionStream` — are unverified.
Once the key works: capture the Phase 0 baseline, then confirm `pnpm eval` gives
the same six verdicts and `pnpm scores` the same numbers to three decimals.
Commands in [`plan/baseline/db-state.md`](./plan/baseline/db-state.md).

**3. Then Phase 5 — API routes in `apps/web`** (`plan/steps.md` § Phase 5). The
six endpoints as Route Handlers, the SSE one being the hard part, with the error
map in a single `withRoute()` wrapper.

ℹ `pnpm eval` and `pnpm scores` now carry `--conditions=react-server`, because
the pipeline imports `@rag/db`, which is `server-only`. Without the flag they
cannot run at all. See `packages/db/README.md`.

~~Decide tenancy~~ — **decided 2026-09-22: single tenant.** No `tenant_id`.
Multi-tenancy is its own plan after Phase 7, and now carries a backfill.

What is left on the POC itself is optional:

1. **Read [`notes.md`](./notes.md).** It is the deliverable — what each of the
   five knobs actually does, measured on this build.
3. **Verify both post-MVP features in the browser:**
   - Ask `NL-220` → the sources panel should show `KEYWORD` or `BOTH` badges.
   - Ask "Who is the Operations Director?" then "When did they join?" → the
     second answer should work, with an italic *searched for:* line in the
     sources panel showing the rewritten query.
4. **Nothing left on the post-MVP list.** Everything in `mvp.md` § Post-MVP
   has been built except auth and deployment, both of which are deliberate
   non-goals for a learning POC (D-006, D-013).

⚠ **After D-018, any document already in the database was chunked by the OLD
splitter.** Changing the chunker does not touch stored chunks. Delete and
re-add anything ingested before 2026-09-20 or it keeps its mid-sentence cuts.

### ⚠️ If this ever goes to production — the checklist is in `README.md`

**“Before you put this in production”**, at the top of [`README.md`](./README.md).
The two that are easiest to forget:

- **`npm run scores`** — re-measure `MIN_SIMILARITY` on YOUR documents. The
  shipped 0.25 came from a three-chunk corpus of invented facts.
- **`npm run eval`** — run the prompt battery on YOUR documents, **and use its
  result to decide the chat model.** `gpt-4o-mini` scored 5/6 here and `gpt-4o`
  scored 6/6 at ~16× the input cost; the case that separated them was applying
  a general rule where the document also stated an exception. If your content
  has carve-outs — pricing tiers, policy exceptions, eligibility bands — test
  both before choosing. Do not guess (D-005, D-017).

Also on that checklist: R-1 (the API key) and R-2 (RLS has no policies), both of
which stop being notes and become blockers the moment there is a public URL.

**Re-run `node scratch/prompt-eval.js` after ANY edit to `buildPrompt()`.** It
checks both directions at once: that real questions get answered and that absent
facts still get refused. Losing the second is how the sourdough recipe happened.

**If you deploy this, two things stop being notes and become blockers:**
R-1 (the API key) and R-2 (RLS has no policies — `service_role` bypasses it).

**Server:** may still be running on port 3000. On Windows:
`Get-NetTCPConnection -LocalPort 3000 -State Listen` then `Stop-Process`.

## ✅ Done

- [x] Idea captured and intake filled — 2026-09-20 — `idea-intake.md`
- [x] Tech stack settled (3 dependencies, no framework) — 2026-09-20 — `techstack.md`
- [x] Architecture, data model, `match_chunks` SQL, prompt design — 2026-09-20 — `architecture.md`
- [x] MVP scope, out-of-scope list, 6-phase roadmap — 2026-09-20 — `mvp.md`
- [x] Both screens specified with all states — 2026-09-20 — `screens.md`
- [x] 14 decisions logged, 5 open questions — 2026-09-20 — `decisions.md`
- [x] Risks and cost model — 2026-09-20 — `risks.md`, `costs.md`
- [x] Build brief for the target repo — 2026-09-20 — `BUILD.md`
- [x] **`whats-done.md` written** — 2026-09-20 — a per-step explanation of
      Phases 0 and 1: what was done, why it mattered, and what each verified
      number proves. Companion to this file (`status.md` = what's next;
      `whats-done.md` = what happened and why).
- [x] **Q-3 resolved** — checked OpenAI's deprecations page 2026-09-20:
      `text-embedding-3-small` is **not** deprecated (community reports of an
      Oct 2026 shutdown are contradicted by the official page), and
      `gpt-4o-mini` is not scheduled for shutdown. `vector(1536)` stands.
- [x] **Phase 0.1–0.2** — OpenAI credits added and API key created — 2026-09-20
- [x] **Phase 0.3 + 0.5** — Supabase project created; `schema.sql` ran
      successfully — 2026-09-20. RLS enabled on all four tables (no policies),
      a deliberate amendment to D-006 — see `decisions.md` D-006 and `risks.md`
      R-2. `schema.sql` carries the `alter table ... enable row level security`
      lines so the file stays the source of truth.
      ⚠️ **The first run did not apply them** — the SQL editor still held the
      pre-amendment copy of the file, so the tables were created with RLS off
      and `pg_tables.rowsecurity` read false. Fixed by running the four
      `alter table` statements on their own. **Verified:** all four tables now
      report `rowsecurity = true`. Lesson for any future schema change: re-copy
      the file, and verify the effect rather than trusting "run succeeded".
- [x] **Code review fixes** — 2026-09-20. A review of the D-018/D-019 commits
      found 8 issues; all 8 verified by reproducing them, all 8 fixed.
      **Two were real silent-truncation bugs:** `chatStream()` treated *any*
      end of stream as success, so a dropped connection returned a half answer
      that was saved to the database and reported as complete; and an OpenAI
      error delivered inside a 200 response was skipped in silence. Both now
      throw. The client likewise required nothing of the stream — it now
      requires the `done` event.
      **One real chunker bug:** a short heading before an oversized paragraph
      became its own stub chunk (`"# Refund Policy"`, 15 chars), burning an
      embedding and a retrieval slot while severing the heading from its
      content — the exact failure D-018 exists to prevent. `current` is now
      folded into the text being split instead of flushed.
      The rest: a stream failure no longer loses the turn from history; the
      SSE error-send is guarded against a dead socket; Retry no longer
      duplicates the question; and two UI texts that D-018 had made false
      (the "estimate is exact" comment and the overlap hint) now say what is
      actually true. Regressions, prompt battery (5/6) and score probe all
      unchanged.
- [x] **`flow.md` written** — 2026-09-20. Mermaid diagrams of the implemented
      flow: system overview, ingest sequence, query sequence (including
      rewriting, hybrid search, the threshold gate and streaming), a
      where-it-goes-wrong map, the route table and the seven knobs. Every box
      names the file and function. `architecture.md` § 3 now carries a note
      saying its diagrams are the original design.
- [x] **Streaming responses (D-019)** — post-MVP, 2026-09-20. `chatStream()`
      in `src/openai.js` parsing OpenAI's SSE, `answerQuestionStream()` sharing
      `prepareAnswer()` with the blocking path, an SSE branch on
      `POST /api/chat`, and hand-rolled SSE parsing in `public/app.js`
      (EventSource cannot POST).
      **Measured:** sources on screen at **1,381 ms** versus **2,353 ms**
      before anything appeared at all — 1.7× sooner. Same tokens, same cost.
      **`meta` fires before the answer exists**, so the sources panel is
      readable while the model is still writing.
      Caught a real bug in testing: `req.accepts('text/event-stream')` matches
      `Accept: */*`, so every curl was being handed a stream it could not
      parse. Now an explicit header check; plain curl still gets JSON.
      Prompt battery **5/6, unchanged**.
- [x] **Paragraph-aware chunking (D-018)** — post-MVP, 2026-09-20.
      `chunkText()` packs whole paragraphs up to a `CHUNK_SIZE` ceiling; the
      old sliding window survives as the fallback for oversized paragraphs and
      for text with no blank lines. Sizes unchanged at 1000/150.
      **Northwind handbook: 3 chunks (1000/1000/907, cut mid-sentence) → 4
      chunks (584/804/720/937, every one ending on a full stop).**
      **Scores rose and separation widened:** direct hits 0.462→0.530,
      0.457→0.577, 0.536→0.588, while the absent question stayed at 0.427 and
      off-topic stayed under 0.10. `MIN_SIMILARITY` re-checked and left at 0.25.
      Prompt battery **5/6, unchanged** — no regression.
      Caught a bug in my own first version: the carried overlap tail was being
      emitted as a spurious extra chunk (1001 chars gave 3 chunks instead of 2).
      Fixed with a `carriedOnly` flag and covered by a regression check.
      ⚠ Only helps where the source has paragraph breaks; one unbroken wall of
      text still falls back to fixed-size cuts.
- [x] **Grounding instruction reworded (D-017)** — post-MVP, 2026-09-20.
      Separates connecting stated facts (allowed) from adding absent ones
      (never) from partial answers (say what is missing). Judged with a fixed
      six-case battery, `scratch/prompt-eval.js`, run before and after.
      **4/6 → 5/6**, and **all three refusal cases held** — which was the thing
      at risk. The one-step inference case now passes: "Who do I contact on
      extension 4417?" → *"You can contact the Kessler Seismograph Annex
      liaison at extension 4417."*
      ⚠ **Two things the prompt could not fix**, both worth knowing:
      the wrong-antecedent case is a **model** limit — identical prompt on
      `gpt-4o` scores **6/6**; and the partial-answer clause fails under a
      starved retriever (`MATCH_COUNT=1`), where **both** models still invent a
      reason rather than admit the gap. A second prompt attempt at the
      antecedent case gave no improvement and was removed.
- [x] **Query rewriting (D-016)** — post-MVP, 2026-09-20. `rewriteQuestion()`
      in `src/rag.js`, `chat()` extended with `maxTokens`/`temperature`/`label`,
      and an italic "searched for:" line in the sources panel.
      **The Phase 4 failure is fixed:** "When did they join?" went from
      **0 chunks + refusal** to a rewritten query of "When did the floor
      supervisor and the Operations Director join?", 3 chunks, and the correct
      answer naming Marisol Venn.
      **Measured cost:** 3 rewrite calls over a 4-turn conversation, 409 in +
      30 out, $0.000079 — **21%** on top of the answers, $0.00002/message.
      2 of 4 turns were left unchanged, so no over-rewriting.
      ⚠ **Does not fix generation.** The Phase 3 wrong-antecedent case still
      fails: the rewriter correctly resolved "that group" to "prospective staff
      badge holders" and the model still answered about auditors.
- [x] **Hybrid search (D-015)** — post-MVP, 2026-09-20. `schema-hybrid.sql`
      (GIN index, `to_or_tsquery`, `match_chunks_fts`), `retrieve()` in
      `src/rag.js` fusing both searches with Reciprocal Rank Fusion, and a
      `vector`/`keyword`/`both` badge in the sources panel.
      **Measured honestly:** on a 19-chunk corpus it changed **nothing** for
      four natural-language questions containing identifiers — vector search
      already ranked the right chunk #1 or #2 every time. The one clear win
      was a bare identifier typed alone: `NL-220` was **missed entirely** by
      vector-only (5 chunks passed the threshold, none contained it) and
      rescued at rank #2 by hybrid, producing the correct answer.
      Zero extra prompt tokens. Filler test documents removed afterwards.
      ⚠ **Hybrid fixes retrieval, not generation.** "Who do I contact on
      extension 4417?" now retrieves the correct chunk at rank #1 (confirmed by
      keyword) and the model **still refuses**, because answering needs a
      one-step inference from "reachable at" to "contact on". Logged in
      `notes.md`; the fix would be prompt work, not retrieval work.
- [x] **Phase 5 complete** — 2026-09-20. All six experiments run in fresh Node
      processes; `src/chunker.js` and `src/rag.js` backed up first and verified
      **byte-identical** after restoration. Findings written to `notes.md`
      (337 lines). Build instructions added to `README.md`.
      **Headline finding:** the threshold and the grounding instruction do
      different jobs — `MIN_SIMILARITY` protects **cost**, the "use ONLY the
      context" line protects **correctness**. Removing the threshold produced
      zero wrong answers (just 671 wasted tokens per off-topic question);
      removing the prompt line produced a full sourdough recipe cited to three
      lab-handbook chunks.
      **Caught a real hallucination:** at `MATCH_COUNT = 1` the model answered
      the Quiet Hour's hours correctly and *invented* its reason.
- [x] **Phase 4 complete** — 2026-09-20. **Verified working in a real browser by the user.** Five files in
      `public/` (~870 lines incl. CSS), plus `GET /api/documents/:id/chunks` and
      `getChunks()` — the route `screens.md` § S-2 implied but
      `architecture.md` § 5 never listed.
      **Verified server-side:** all six static assets serve with correct content
      types; every endpoint the UI calls returns correctly; no `console.log` and
      no `innerHTML` anywhere in `public/`; both frontend modules parse.
      **`src/chunker.js` is now served to the browser at `/chunker.js`** and
      imported by `admin.js`, so the live chunk estimate uses the server's own
      constants instead of duplicating them.
- [x] **Phase 3 complete** — 2026-09-20. `MIN_SIMILARITY` tuned from measured
      scores, `buildPrompt`, `answerQuestion`, message/conversation persistence,
      the no-results short circuit, `POST /api/chat` and
      `GET /api/conversations/:id/messages`.
      **The success criterion passed:** asked for the Bay 3 freezer temperature
      → "minus 68 degrees Celsius" with 3 sources; deleted the document; asked
      again → the refusal, with **zero** chunks and no OpenAI call.
      **Q-1 resolved** — see the decision note below.
- [x] **Phase 2 complete** — 2026-09-20. `src/chunker.js` (pure, overlap
      verified byte-identical), `src/openai.js` (`embed` batched + `chat`),
      `src/supabase.js`, `src/rag.js` (`ingestDocument`, `listDocuments`,
      `deleteDocument`), `server.js` with the three document routes, fail-fast
      env check and one-place error mapping. Verified by curl: a 2,607-char
      document became **3 chunks** (1000 / 1000 / 907) each with a 1536-dim
      embedding; overlap between chunks 0 and 1 byte-identical; all five
      validation paths return the right status; **R-7 rollback confirmed** —
      a forced embedding failure left zero orphan rows; DELETE cascaded 3
      chunks to 0.
- [x] **Phase 0.4 + 0.6** — `.env` filled; `pgvector` verified **functionally**
      from Node — a `vector(1536)` value inserted, read back and searched with
      the `<=>` operator, which cannot work unless the extension is live. The
      literal `select * from pg_extension` check was not run from Node because
      PostgREST cannot reach system catalogs; the functional proof is stronger.
- [x] **Phase 1.1** — `scratch/embed-test.js` prints **1536** — 2026-09-20.
      Model reported back as `text-embedding-3-small`, 2 prompt tokens.
- [x] **Phase 1.2** — `scratch/roundtrip-test.js` — vector round-trips intact:
      1536 numbers, max drift 3.6e-9 (pgvector stores float4, so single-
      precision rounding is expected and harmless). `match_chunks` returned the
      probe chunk at similarity **1.0000** against its own embedding, proving
      the column is a real vector and the search path works end to end. Delete
      cascaded: 0 chunks left. Probe rows cleaned up.
- [x] **Phase 1.3** — `scratch/chat-test.js` returns a completion — 2026-09-20.
      Served by `gpt-4o-mini-2024-07-18`, 23 in + 31 out tokens.
- [x] **Phase 0.7** — `npm init`, `"type": "module"`, 3 deps installed,
      `schema.sql`, `.gitignore`, `.env.example` written — 2026-09-20.
      Versions recorded in `techstack.md`: node 24.19.0, express 4.22.3,
      @supabase/supabase-js 2.116.0, dotenv 16.6.1. `typeof fetch === 'function'` ✓

## 🔨 In progress

- Nothing. The project is complete.

## ⏭️ Not started (MVP backlog)

Build order — pull from the top. Full detail in `mvp.md` § Roadmap.

**Phase 0 — Setup** ✅ complete
- [x] OpenAI account, credits, spending limit, API key
- [x] Supabase project created
- [x] Copy `URL` + `service_role` key into `.env`
- [x] Run `schema.sql` (incl. RLS on all four tables)
- [x] Verify `pgvector` enabled
- [x] `npm init`, `"type": "module"`, 3 deps, `.gitignore`, `.env.example`
- [x] `.env` filled with real values

**Phase 1 — Prove the API calls** ✅ complete
- [x] `scratch/embed-test.js` — embedding prints length 1536
- [x] Vector round-trips through Supabase as numbers, not a string
- [x] `scratch/chat-test.js` — a chat completion returns

**Phase 2 — Ingest** ✅ complete
- [x] `src/chunker.js` (pure, overlap visibly correct)
- [x] `src/openai.js` — `embed()` batched in one call
- [x] `src/supabase.js`
- [x] `rag.ingestDocument()`
- [x] `server.js` + `POST/GET/DELETE /api/documents`
- [x] Verified by curl

**Phase 3 — Query** ✅ complete
- [x] `match_chunks` via `.rpc()`, log real similarity scores
- [x] Tune `MIN_SIMILARITY` from those scores (Q-1) — **0.30 → 0.25**
- [x] `buildPrompt()` per `architecture.md` § 6
- [x] `rag.answerQuestion()` + `POST /api/chat`
- [x] Message + conversation persistence
- [x] No-results short circuit (skip OpenAI entirely)

**Phase 4 — UI** ✅ complete
- [x] `admin.html` + `admin.js` — add / list / delete / expand chunks
- [x] `index.html` + `app.js` — messages, input, send
- [x] Sources panel with similarity scores
- [x] Loading + error states from `screens.md`
- [x] `style.css`
- [x] `GET /api/documents/:id/chunks` (gap in `architecture.md` § 5)
- [x] **Walked through in an actual browser** — confirmed working

**Phase 5 — Understand it (the actual deliverable)** ✅ complete
- [x] Chunk size 300, then 4000 — note what breaks and why
- [x] `MIN_SIMILARITY = 0` on an unrelated question — watch it retrieve nonsense
- [x] `MATCH_COUNT` 1 vs 20 — cost/quality tradeoff
- [x] Remove the "use ONLY the context" line — watch it hallucinate; put it back
- [x] Check real OpenAI usage against `costs.md`
- [x] Write `notes.md`

**Post-MVP backlog** (optional, ordered by what the experiments justify)
- [x] Hybrid search (vector + Postgres full-text) — D-015
- [x] Query rewriting so retrieval sees conversation history — D-016
- [x] Prompt work on the generator — D-017 (4/6 → 5/6; the last one is a model limit)
- [ ] Decide whether `gpt-4o` is worth ~16× the input cost (6/6 vs 5/6)
- [x] `git init` + first commit — 2026-09-20, 32 files, `.env` verified excluded
- [x] Paragraph-aware chunking — D-018
- [x] Streaming responses — D-019

---

## 🚧 Blockers & open questions

**Blocker 1 — the OpenAI API key is invalid.** Found 2026-09-21 during the
Phase 1 end-to-end check (`HTTP 401 — "Your API key has expired. Create a new
API key to continue."`) and still failing 2026-09-22, now with a different
upstream sentence: `"Your API key has been invalidated."` The key is read and
sent correctly; OpenAI is rejecting it. Blocks the app, `pnpm eval`,
`pnpm scores`, the baseline capture, and the `embed() -> 1536` check carried
over from Phase 2. Supabase is unaffected. Replace `OPENAI_API_KEY` in `.env`.

**Blocker 2 — the eval/score baseline has not been captured**
(`plan/steps.md`). Phase 4's definition of done is "`pnpm eval`
gives the same six verdicts as the baseline", and there is no baseline yet,
because capturing one means clearing the Villa Amihan corpus out of the
database — deferred by decision on 2026-09-21. Not urgent for Phases 1–3, which
touch no pipeline behaviour. Blocking from Phase 4 on. Commands in
[`plan/baseline/db-state.md`](./plan/baseline/db-state.md).

**Open questions** (full list in `decisions.md` § Open questions):

- ~~**Q-1** — What `MIN_SIMILARITY` actually works?~~ **Resolved 2026-09-20: 0.25.**
  Measured with `scratch/score-probe.js` on the Northwind corpus — direct hits
  0.46–0.54, paraphrases 0.40–0.45, an exact identifier 0.28, off-topic
  0.04–0.10. 0.25 sits in the empty gap. The planned 0.30 would have falsely
  refused the "extension 4417" question.
- ~~**Q-2** — Is 1000/150 the right chunk size for real documents?~~
  **Partly resolved 2026-09-20.** On this corpus 300 retrieved *better* than
  1000 (0.726 vs 0.462 top score) and cost 40% less — but at `MATCH_COUNT = 1`
  a 300-char chunk was too small to hold a complete answer and the model
  invented the missing half. 4000 collapsed the document to one chunk and
  inverted the ranking. Kept at 1000/150; paragraph-aware chunking is the
  real answer.
- ~~**Q-3** — Is `gpt-4o-mini` still the right cheap model?~~ **Resolved 2026-09-20:** both named models are current and not deprecated. Chat model stays swappable by env var (D-005); revisit in Phase 5 if desired.
- ~~**Q-5** — Keep or delete the `scratch/` scripts?~~ **Resolved: kept**,
  with `scratch/` in `.gitignore`. `score-probe.js` and `experiment.js` both
  earned their place in Phase 5 and are how you re-measure on a new corpus.

---

## 🗒️ Session log

### 2026-09-21 — session 3 (migration planning + Phase 0)
- **Did:** Wrote [`plan/steps.md`](./plan/steps.md) — the full migration from
  the Express + vanilla-JS POC to a Turborepo monorepo running Next.js and
  TypeScript. 8 phases, each with an observable "done when".
- **Then:** implemented migration Phase 0.
- **The finding that made Phase 0 worth doing first:** the eval battery's corpus
  was not in version control. `tools/prompt-eval.js` asserts on Bay 3, extension
  4417 and the violet badge ratio — facts that existed only in
  `scratch/testdoc.json`, and `scratch/` is gitignored. The battery `CLAUDE.md`
  names as the gate on every `buildPrompt()` change was one `git clean -fdx`
  from being unrunnable, and no fresh clone ever had it. Now committed at
  `fixtures/northwind.json` (2,607 chars — matches the figure in `notes.md`).
- **Also:** moved `todo.txt` out of `sample-documents/` to `todo.md` at the
  root. It sat among eight files whose instructions are "paste each of these
  into the admin page"; it is not corpus.
- **Observed, recorded in `plan/baseline/db-state.md`:** 8 documents / 30 chunks
  / 150 conversations / 428 messages. The loaded corpus is Villa Amihan, not
  Northwind. Also: `embedding` comes back from PostgREST as a **string** that
  parses to 1,536 numbers — not the trap from `CLAUDE.md` § 5 (the column is a
  real `vector`; `<=>` works), but it is what the type generator will see in
  migration Phase 3.
- **Decided:** do **not** capture the eval/score baseline yet, because it means
  deleting the Villa Amihan documents. The two corpora cannot share a database
  for this: `03-amenities` documents parking, so the eval case `absent-2` would
  get a real answer and be scored a failure.
- **Stopped at:** Phase 0 complete except the measurement.
- **Next:** migration Phase 1 — the workspace skeleton.

### 2026-09-22 — session 4, continued (migration Phase 4)
- **Did:** Ported all 645 lines of `rag.js` into `@rag/pipeline`, split five
  ways — `constants`, `types`, `ingest`, `prompt`, `retrieve`, `answer`. Ported
  both tools by changing **only their import lines**; the six eval cases and the
  scoring loop are byte-identical, because a gate rewritten alongside the thing
  it guards is not a gate.
- **Proved, with no API key — 22 comparisons, 0 differences:** all seven
  constants, `buildPrompt` on four inputs, `retrieve` on seven live queries, and
  `listDocuments` / `getChunks` / `getMessages`. The query vector is an
  embedding already stored in a chunk row, so the whole run is free.
- **Why that retrieve coverage matters:** the seven queries produce different
  shapes — `keyword:0` (pure vector), `keyword:4` with a chunk rescued by
  keyword alone, and `keyword:10` with heavy overlap. That exercises RRF fusion
  in every mode, which is where a porting mistake would have stayed invisible
  until someone asked about an identifier.
- **NOT proved, and why Phase 4 stays open:** `ingestDocument`,
  `rewriteQuestion`, `answerQuestion`, `answerQuestionStream` all call OpenAI.
  `pnpm eval` resolves every module, loads `server-only`, runs the pipeline and
  dies at the first `embed()` — which proves the wiring and nothing about the
  behaviour.
- **The key failed a third way today:** *"Incorrect API key provided"*, after
  *"expired"* and *"has been invalidated"*.
- **One fidelity slip, caught by reading an error dump:** every `OpenAIError`
  carried `partial: undefined`, because TS compiles a declared class field to a
  `defineProperty` under `target: ES2022`, where the JS left the property
  absent. Fixed with `declare`; verified the own properties are now `status,
  name` only.
- **Stopped at:** Phase 4 code complete, verification partial.
- **Next:** new key → baseline → close Phase 4 → Phase 5 (API routes).

### 2026-09-22 — session 4, continued (migration Phase 3)
- **Decided:** **single tenant.** The plan called Phase 3 the last cheap moment
  to add `tenant_id`; the answer was no, so the port stays a port and the
  Phase 4 eval comparison stays meaningful.
- **Did:** `@rag/db` — both `.sql` files moved in with `git mv`, the POC's
  `supabase.js` ported verbatim plus `createClient<Database>`, hand-written
  `database.types.ts`, `MatchRow` / `FtsRow` / `parseStoredVector`, a 10-check
  verification script, and a README.
- **Verified, 10/10, with no API key:** all four tables readable (8 / 30 / 153 /
  428 rows), embedding parses to 1536 finite numbers, `match_chunks` rows match
  `MatchRow`, and **a chunk searched against its own embedding returns itself at
  similarity 1.000000** — the cheapest possible proof that the column is a real
  vector rather than text that merely round-trips.
- **The guard, proven both ways:** plain `node` importing `@rag/db` throws
  *"This module cannot be imported from a Client Component module"*;
  `node --conditions=react-server` imports fine. So a Client Component leaking
  the service-role key is a build error, not a code review.
- **The cost of that, found by testing:** plain Node has no `react-server`
  condition either. **From Phase 4, `pnpm eval` and `pnpm scores` need
  `--conditions=react-server`** or they cannot run at all.
- **Deviation:** types are hand-written from the committed `.sql` files. The
  generator needs credentials this repo does not carry, and the direct database
  host no longer resolves (`getaddrinfo ENOTFOUND db.<ref>.supabase.co` —
  Supabase is IPv6-only for direct connections now). Writing them by hand forced
  two decisions a generator would have made silently: the vector column is typed
  `string` (what PostgREST actually returns), and `id` is `never` in Insert on
  the `generated always as identity` tables.
- **Stopped at:** Phase 3 complete.
- **Next:** replace the API key, capture the baseline, then Phase 4.

### 2026-09-22 — session 4 (migration Phase 2)
- **Did:** Ported `src/chunker.js` and `src/openai.js` to TypeScript as
  `@rag/chunker` and `@rag/openai`. Built `tools/parity.mjs`, 13 vitest cases,
  and wired `build` / `typecheck` / `test` / `parity` through turbo.
- **The number that matters:** parity is **87 comparisons, 0 differences** — 17
  documents (8 sample docs, the Northwind fixture, 8 synthetic shapes) across 4
  chunk configurations, plus `estimateChunkCount` and both constants. The
  synthetic shapes exist because no real document exercises the branches most
  likely to break: whitespace-only input, a 3,500-char wall with no blank lines,
  heading-plus-oversized-paragraph, CRLF, multi-byte characters.
- **One real change, deliberate:** `OpenAIError extends Error` with
  `readonly status: number`, replacing a property bolted onto a plain Error.
  Same behaviour; the route layer's whole error map is built on that property.
- **Still blocked:** `embed(['hello'])` → 1536. The key now reports *"Your API
  key has been invalidated."* rather than *"expired"* — same 401, different
  upstream sentence, both recorded. The failure did verify the error contract:
  `OpenAIError`, `status` the number 401, message formatted as before.
- **Build lesson worth keeping:** `rootDir`/`outDir` in a shared tsconfig
  resolve against **that file's** directory, not the package extending it
  (TS6059). The shared config now holds only path-independent options.
- **Stopped at:** Phase 2 complete.
- **Next:** Phase 3 (`@rag/db`) — needs no API key, but does need a tenancy
  decision before Phase 4 writes the queries.

### 2026-09-21 — session 3, continued (migration Phase 1)
- **Did:** Branched `feat/nextjs-migration`. Built the workspace — pnpm 12.5.1
  via corepack, turbo 2.11.2, `pnpm-workspace.yaml`, `turbo.json`,
  `packages/tsconfig`. `git mv`'d the POC into `apps/legacy-poc/`; all 15 files
  recorded as 100% renames, so `git log --follow` still works.
- **Verified:** every route and static asset serves from the new home;
  `/api/documents` returns real rows; all nine frozen constants read back
  correct; both tools pass `node --check`; express/supabase-js/dotenv resolve to
  **the same versions as the Phase 0 baseline**, so changing package manager did
  not move the dependency graph.
- **Found — the blocker:** the **OpenAI API key has expired**. The end-to-end
  question returned a 401 carrying OpenAI's own sentence. This is not fallout
  from the move; it is evidence the move worked, since the key was read from
  `.env` at the new path and rejected as *expired* rather than missing. It also
  proved the error map end to end: upstream 401 → client 401, real message
  intact.
- **Deviations, all recorded in `whats-done.md` with reasoning:** pnpm 12 not 9;
  the fixture stays at `fixtures/` until a package actually reads it;
  `--env-file=../../.env` in the launcher rather than moving `.env`, which keeps
  every source file byte-identical.
- **Also:** banners on `README.md`, `CLAUDE.md` and `BUILD.md` — they described
  root-level paths and forbade TypeScript. Rewritten properly at Phase 7.
- **Stopped at:** Phase 1 complete.
- **Next:** replace the API key; then Phase 2 (`@rag/chunker` first — its parity
  check needs no key).

### 2026-09-20 — session 2 (build start)
- **Also did (later in session):** Supabase project created and `schema.sql` ran
  clean. Hit the SQL editor's "creates tables without RLS" warning — anticipated
  by R-2. Enabled RLS on all four tables with no policies and wrote the
  `alter table` statements into `schema.sql`; amended D-006 and R-2 to record
  that the POC now ships with RLS on. Nothing about the server changes:
  `service_role` bypasses RLS.
  The first run missed the RLS statements (stale paste in the editor) — caught
  it by checking `pg_tables.rowsecurity`, re-ran the four alters, confirmed all
  four now true.
- **Did:** Read the full doc set. Verified the OpenAI model lineup against the
  official deprecations page (Q-3, R-8) — `text-embedding-3-small` is not
  deprecated, so `vector(1536)` and the schema stand unchanged. Wrote
  `schema.sql` (architecture.md § 4 verbatim, incl. `match_chunks`),
  `package.json`, `.gitignore`, `.env.example`. Installed the three
  dependencies and recorded actual versions in `techstack.md`.
- **Decided:** Keep `gpt-4o-mini` and `text-embedding-3-small` as specified —
  no reason found to deviate. Did not `git init` yet (not asked).
- **Stopped at:** Phase 0.7 complete. Everything local is ready.
- **Then:** `.env` filled. Ran all of Phase 1 — embedding returns 1536,
  a vector round-trips through Supabase with only float4 rounding drift,
  `match_chunks` scores a chunk against its own embedding at 1.0000, delete
  cascades, and a chat completion returns. All three items on `risks.md`
  § "What to validate before committing real time" are now green.
- **Then:** built all of Phase 2. Four modules plus `server.js`, ~330 lines.
  Ingest verified end to end by curl, including the two failure paths that are
  easy to get wrong and invisible when you do: the R-7 orphan rollback and the
  delete cascade. Left a 3-chunk test document (id 4) loaded for Phase 3.
- **Decided:** `listDocuments` uses PostgREST's `chunks(count)` aggregate so the
  admin list never fetches embeddings (~6 KB each). `chat()` sends
  `temperature: 0.2` — the task is faithful reporting of context, not invention.
  `embed()` sorts the response by its `index` field rather than trusting array
  order, so a reordered response can never silently pair chunks with the wrong
  vectors.
- **Then:** built all of Phase 3. Measured similarity scores before tuning
  anything, which changed the threshold from the planned 0.30 to 0.25.
  Verified grounded answers, the short circuit, multi-turn pronoun resolution,
  and the full delete-and-ask-again success criterion.
- **Decided:** refusals are persisted to `messages` too, which the flowchart in
  `architecture.md` § 3.2 does not show. A transcript with gaps would make a
  later "what about the second one?" resolve against the wrong turn.
  Also added `MAX_MESSAGE_LENGTH = 2000` at the chat route boundary — not in
  the plan, but a question is embedded as one unit and anything longer is a
  document pasted into the wrong box.
- **Observed limitation (not a bug):** a third-turn follow-up, "and what is the
  escort ratio for that group?", resolved "that group" to auditors rather than
  the violet-badge holders established in turn 2. Retrieval was correct; the
  model picked the wrong antecedent. Worth revisiting in Phase 5.
- **Then:** built all of Phase 4 — both pages, the sources panel, all states,
  hand-written CSS. Added the missing chunks route. Served `src/chunker.js` to
  the browser so the live estimate shares the server's constants rather than
  copying them.
- **Found (structural, not a bug):** a follow-up question with no nouns of its
  own — "When did they join?" after a turn about the Operations Director —
  retrieves **0 chunks** and gets the refusal, even though the answer is in the
  document. **Retrieval embeds only the raw question; conversation history goes
  to the generator, never to the retriever.** Query rewriting is the standard
  fix and is post-MVP. Worth a paragraph in `notes.md`.
- **Then:** user walked the UI in a real browser and confirmed it works. Phase 4
  closed; the whole MVP (F-1 through F-10) is now built and working end to end.
- **Then:** ran all of Phase 5 and wrote `notes.md`. Added setup and run
  instructions to `README.md` (the planning pitch was kept below them).
- **Learned, in short:** the threshold is a cost gate, not a correctness gate;
  the grounding instruction is the correctness gate and it is weaker than it
  looks when *part* of an answer is retrieved; retrieval quality is decided by
  chunk size more than by anything else; the entire project cost under a cent.
- **Then:** implemented hybrid search on request (D-015) — the first post-MVP
  feature. Wrote `schema-hybrid.sql`, added RRF fusion in `retrieve()`, and put
  a which-search-found-it badge in the sources panel.
- **Measured, and it is a smaller win than expected:** on 19 chunks, vector
  search already found the identifier chunk at rank #1 or #2 for every phrased
  question. Hybrid only changed the outcome for a **bare identifier typed
  alone** (`NL-220`), which vector-only missed completely. Its value scales
  with corpus size; on three chunks it is nearly invisible.
- **Then:** implemented query rewriting (D-016), the second post-MVP feature.
  It fixed the Phase 4 follow-up failure outright and costs 21% more per
  conversation, not the ~100% first estimated — the rewrite prompt carries only
  the transcript, while the answer prompt carries the retrieved chunks.
- **The pattern across both post-MVP features:** each one fixed *retrieval* and
  neither touched *generation*. The remaining wrong answers are all the model
  declining a one-step inference or choosing the wrong antecedent while holding
  the correct chunk. Prompt work, not retrieval work.
- **Then:** reworded the grounding instruction (D-017) against a fixed
  before/after battery rather than by eye. 4/6 → 5/6 with every refusal intact.
- **The most useful thing learned:** "Do not guess" reads to a model as "do not
  reason", and that one phrase was causing it to refuse questions whose answer
  was sitting in the retrieved chunk. Separating *connect* from *add* fixed it
  without loosening the refusals at all.
- **And the limit of prompting:** an instruction to admit a gap loses to the
  pull to finish a sentence. Under a starved retriever both `gpt-4o-mini` and
  `gpt-4o` still invented a reason. That one is fixed by retrieving enough
  context, not by wording.
- **Then:** implemented paragraph-aware chunking (D-018), the last retrieval
  improvement on the list. Re-ingested and re-measured rather than assuming:
  true-positive scores rose by 0.05–0.12 while absent and off-topic questions
  stayed flat, so the threshold's gap widened and 0.25 still holds.
- **Worth noting:** my first version of the new chunker had a real bug — the
  carried overlap tail was emitted as an extra chunk on input with no paragraph
  breaks. Caught only because I checked the new code against the old chunker's
  output on the same input. A regression check now covers it.
- **Then:** implemented streaming (D-019), the last item on the original
  post-MVP list. Content negotiation rather than a second route, so every curl
  example in the docs still works unchanged.
- **The bug worth remembering:** `req.accepts()` honours wildcards, and curl
  sends `*/*`. The "polite" negotiation helper silently did the opposite of
  what it looked like it did. An explicit header check is both more obvious and
  correct.
- **Next:** nothing. Every post-MVP item except auth and deployment is done,
  and those two are deliberate non-goals (D-006, D-013).

### 2026-09-20 — session 1 (planning)
- **Did:** Created the idea folder from a short Q&A. Wrote the full planning set:
  intake, README, architecture (incl. complete schema + `match_chunks`), mvp,
  screens, techstack, decisions, risks, costs, BUILD.
- **Decided:** No RAG framework and no `openai` SDK — raw `fetch`, hand-written
  chunking and retrieval (D-001, D-002), because the project's goal is
  comprehension, not velocity. pgvector in Supabase rather than a separate
  vector DB (D-003). Plain JS, no TypeScript, no build step (D-014). Local only,
  no auth, no deployment (D-006, D-013).
- **Stopped at:** planning complete; folder is a self-contained handoff package.
- **Next:** copy the folder into a new repo, then Phase 0 — OpenAI credits first.
