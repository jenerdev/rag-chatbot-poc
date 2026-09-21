# Decisions — RAG Chatbot POC

A running log. Each entry: what was decided, why, and what would change it.
Referenced from the other docs as `D-00n`.

**The decision behind all the others:** this is a **learning project**. The
stated goal is *"I want to fully understand how it works."* Where two options
compete, the one that makes the mechanism visible wins — even if it means more
code. Convenience that hides a step is a cost here, not a benefit.

---

## D-001 · No RAG framework · **Settled**

**Decision:** No LangChain, LlamaIndex, Vercel AI SDK, or Supabase AI helpers.
Chunking, embedding, retrieval and prompt assembly are all written by hand.

**Why:** These libraries exist to hide exactly the four steps the project is
built to expose. `RetrievalQAChain.fromLLM(...)` is one line and teaches nothing.
The hand-written version is roughly 60 lines and teaches the whole subject.

**Reverse if:** the project graduates into a real product where velocity matters
more than comprehension. By then the tradeoff will be an informed one.

---

## D-002 · Raw `fetch` instead of the `openai` SDK · **Settled**

**Decision:** Call `https://api.openai.com/v1/embeddings` and
`/v1/chat/completions` directly with Node's built-in `fetch`.

**Why:** Requires Node 18+, which is a given. The two calls are ~10 lines each,
and writing them means seeing the actual request body — the `model`, `input`,
`messages` array, the shape of the response. The SDK would turn the two most
instructive HTTP requests in the project into opaque method calls.

Side benefit: one fewer dependency, and no SDK version churn to track.

**Reverse if:** you need streaming with retries and backoff, where the SDK's
handling is genuinely better than hand-rolled. That is post-MVP.

---

## D-003 · pgvector in Supabase, not a dedicated vector database · **Settled**

**Decision:** Embeddings live in a `vector(1536)` column in the same Postgres
database as the text.

**Why:** Supabase was a given. It ships pgvector on the free tier. A separate
vector DB (Pinecone, Chroma, Qdrant, Weaviate) would mean a second service to
run, a second set of credentials, and chunk text and chunk embedding split
across two systems that can drift out of sync. At this corpus size there is no
performance argument for it whatsoever.

**Reverse if:** millions of vectors, which this will never have.

---

## D-004 · `text-embedding-3-small`, 1536 dimensions · **Settled**

**Decision:** `text-embedding-3-small` for both ingestion and queries.

**Why:** OpenAI's cheapest current embedding model, and far more accurate than
needed for a handful of documents. 1536 dimensions is under pgvector's 2000-dim
limit for indexed columns, so the HNSW index works with no dimension-reduction
tricks.

**The two hard consequences — both are traps:**

1. **The same model must embed both the documents and the questions.** Different
   models produce vectors in unrelated coordinate spaces. Comparing across them
   yields plausible-looking similarity scores that are meaningless, and *nothing
   errors*. This is the most common silent RAG bug.
2. **Changing the model means changing `vector(1536)` and re-embedding every
   existing chunk.** Old vectors cannot be converted. Budget for a full
   re-ingest if you ever switch.

Verify current model names and pricing at
<https://platform.openai.com/docs/models> before building — this was written
2026-09-20 and model lineups move.

---

## D-005 · `gpt-4o-mini` for chat, set via env var · **Settled (the env var), soft (the model)**

**Decision:** Default `OPENAI_CHAT_MODEL=gpt-4o-mini`, read from `.env`.

**Why:** Cheap, fast, and entirely capable of "answer using only this context" —
that task is comprehension, not reasoning, so a frontier model buys nothing
here. Putting it in an env var means swapping models is a config change and a
restart, which makes comparing models a 30-second experiment instead of a code
edit.

**Soft part:** the specific model. Check the current OpenAI model list before
Phase 0 — if there is a newer small model, use it. Nothing in the code depends
on which model it is.

**Before production, decide this from measurement, not from instinct.** Run
`npm run eval` (the battery in `tools/prompt-eval.js`, with its cases rewritten
to use your own documents' facts) against each candidate model. Measured on this
build: `gpt-4o-mini` **5/6**, `gpt-4o` **6/6** on an identical prompt at roughly
**16× the input cost**, and the single case that separated them was applying a
general rule where the document also stated an exception. If your documents
contain carve-outs — pricing tiers, policy exceptions, eligibility bands — test
both. If they do not, the cheap model is very likely enough. See D-017 and the
production checklist in `README.md`.

---

## D-006 · `service_role` key, no RLS · **Settled for the POC**

**Decision:** The Express server uses Supabase's `service_role` key. No Row
Level Security policies are written.

**Why:** There is one user, no auth, and everything is localhost. The server is
the only client of the database, and it is trusted. Writing RLS policies for a
single-user local POC is ceremony that protects nothing.

**This is a deliberate, scoped shortcut, and it has an expiry date.** The
`service_role` key bypasses RLS entirely and must never reach the browser. See
`risks.md` § R-2.

**Reverse the moment** this is deployed anywhere public or gains a second user.
At that point RLS is mandatory, not optional.

**Amended 2026-09-20 during Phase 0.5.** Supabase's SQL editor warns when
`create table` runs without RLS, so `schema.sql` now enables RLS on all four
tables explicitly. The decision above is unchanged in substance: **no policies
are written.** RLS on with zero policies means `anon` and `authenticated` can do
nothing, while `service_role` — the only key the server holds — bypasses RLS and
is unaffected. This costs the POC nothing and retires the "the shortcut travels"
half of R-2 immediately rather than at first deploy. Writing actual policies is
still out of scope and still arrives with auth.

---

## D-007 · Fixed-size chunking with overlap · **Settled for the MVP**

**Decision:** ~1000 characters per chunk, ~150 characters of overlap. Split on
character count, not tokens, sentences or semantics.

**Why:** It is the simplest thing that works, it is ~15 lines you can read in
one go, and it performs perfectly well on a small corpus. Smarter chunkers
(recursive, semantic, token-aware) are a meaningful improvement at scale — but
starting with them means never developing intuition for *why* they are better.

Phase 5 of the roadmap is specifically about changing these two numbers and
feeling the effect. That experiment only works if the baseline is naive.

**Superseded in part by D-018 (2026-09-20).** Phase 5 was run, the effect was
felt, and chunking moved retrieval quality more than any other knob — so the
splitter is now paragraph-aware. The sizes (1000 / 150) are unchanged and the
fixed-size sliding window survives as the fallback for oversized paragraphs and
for text with no blank lines. The "start naive" reasoning above still stands as
the reason it was done in this order.

**Characters, not tokens:** counting tokens requires a tokenizer dependency
(`tiktoken`/`gpt-tokenizer`) and buys precision the POC does not need. Roughly
4 characters ≈ 1 token for English is close enough for sizing.

---

## D-008 · Similarity threshold, with a short circuit · **Settled, value provisional**

**Decision:** `match_chunks` takes `min_similarity`, default `0.3`. When nothing
clears it, the server returns "I don't know based on the documents I have."
**without calling OpenAI at all.**

**Why:** Without a floor, vector search always returns its `match_count` nearest
chunks — including for a question completely unrelated to your corpus. Those
chunks then get pasted into the prompt as if they were relevant, and the model
does its best with irrelevant context. The threshold is what turns "always
answers" into "answers when it knows."

Skipping the OpenAI call is faster, free, and eliminates any chance of the model
ignoring the refusal instruction.

**Provisional:** `0.3` is a starting guess. Phase 3.2 of the roadmap is to log
real similarity scores on real questions and tune it. Too high and it refuses
things it knows; too low and it hallucinates from noise.

---

## D-009 · Express 4, not Express 5 · **SUPERSEDED 2026-09-22 by D-021**

**Decision:** `"express": "^4"`.

**Why:** Express 5 has shipped, but essentially every tutorial, Stack Overflow
answer and blog post you will hit while building matches version 4. For a
learning project, matching the documentation you will actually read is worth
more than being current. The API surface used here (`app.get`, `app.post`,
`express.json`, `express.static`) is the same in both.

**Superseded:** there is no Express in the repo any more. The routes are Next.js
Route Handlers (D-021). The one place where the choice of 4 over 5 actually
showed — Express 4 not catching async errors, hence the `route()` wrapper — has
an exact counterpart in the new stack: `withRoute()` in `apps/web/lib/route.ts`,
for the same reason and with the same failure mode if forgotten.

---

## D-010 · No streaming in the MVP · **Settled**

**Decision:** The chat endpoint returns a complete JSON response. No SSE, no
token-by-token rendering.

**Why:** Streaming means Server-Sent Events, chunked parsing, and incremental
DOM updates — three unrelated concerns bolted onto the one route you most want
to read clearly. It is a UX improvement, not a RAG lesson.

It is #1 on the post-MVP list precisely because it *is* worth doing — just not
while you are still learning what the route does.

**Superseded by D-019 (2026-09-20).** Streaming is now implemented, after the
route had been read, understood and documented without it. The JSON path
remains the default and is what `curl` still gets; the stream is opt-in via
`Accept: text/event-stream`. The reasoning above is why it was done in this
order rather than up front.

---

## D-011 · Conversation history capped at ~6 messages · **Settled**

**Decision:** Send at most the last 6 messages with each request.

**Why:** Every prior message is re-sent and re-billed on every turn, so an
uncapped history grows cost quadratically over a conversation. Six turns is
plenty for "what about the second one?" to resolve.

**Worth understanding:** the model has no memory. Each request is stateless and
the entire conversation is re-uploaded every single time. That surprises most
people, and seeing the cap in your own code is how it stops surprising you.

---

## D-012 · Sources shown in the UI as a product feature · **Settled**

**Decision:** Every answer displays the chunks that were retrieved, with their
similarity scores. Not behind a debug flag.

**Why:** It is the only way to distinguish "the bot read my document" from "the
model happens to know this." Without it you cannot tell whether retrieval is
working, and the project's success criterion becomes unverifiable. It also
happens to be good product design — grounded answers should show their grounds.

---

## D-013 · Local only, no deployment · **Still true; Phase 8 of the migration will change it**

**Decision:** Runs on `localhost:3000`. No hosting, no Docker, no CI.

**Why:** Deployment teaches deployment, not RAG. It adds an environment to debug
and a place for secrets to leak. The success criterion is fully testable locally.

**Reverse if:** you want to show it to someone. At that point read `risks.md`
§ R-1 and § R-2 first — both become real the second it has a public URL.

---

## D-014 · Plain JavaScript, no TypeScript · **REVERSED 2026-09-22 by D-020**

**Decision:** ES modules, no TypeScript, no build step.

**Why:** A compile step between the code you read and the code that runs is
exactly the wrong thing for a project about understanding what runs. The project
is ~600 lines with four modules; types would catch little.

**Note the inconsistency, deliberately:** `../shared-auth-layer` mandates strict
TypeScript. That is a library other code depends on; this is a throwaway
learning POC. Different jobs, different answers.

**Reversed, and the original reasoning is the reason why.** The argument was
that a compile step between the code you read and the code that runs is wrong
for a project about understanding what runs. That argument was correct, and it
has been served: `notes.md` exists, the pipeline was read and measured, and the
knowledge it produced is what made the port verifiable.

What changed is the sentence *"this is a throwaway learning POC"*. It is not
throwaway any more — it has two clients (a browser and a set of tools), a
streaming contract, and a security boundary that did not exist when the server
was the only thing that could reach the database. Those are the conditions the
original note said would justify the other answer.

The port cost about 700 lines of retyping and caught nothing that was broken —
which is the honest result, and worth recording rather than overselling. What it
buys is future edits: `Source`, `MatchRow` and `StreamMeta` are now contracts
rather than shapes an object literal happened to have.

---

## D-015 · Hybrid search (vector + Postgres full-text), fused with RRF · **Post-MVP, added 2026-09-20**

**Decision:** Retrieval runs `match_chunks` (cosine) and `match_chunks_fts`
(Postgres full-text) in parallel and merges them with **Reciprocal Rank
Fusion**. Keyword hits are **not** subject to `MIN_SIMILARITY`.

**Why:** Phase 5 measured the weakness directly. `"extension 4417"` scored
**0.284** — worse than a vague paraphrase at 0.401 — because embeddings encode
meaning and an identifier has almost none. The originally planned threshold of
0.30 sat *above* that score, so the as-designed system would have refused a
question the documents answer.

**Why fuse by rank, not by score.** Cosine similarity and `ts_rank` are not
comparable: different scales, different distributions, and a "good" `ts_rank`
depends on the document. Averaging them or weighting them 70/30 means inventing
an exchange rate between two currencies that have none. RRF discards the scores
and keeps only each search's ordering:
`score = Σ 1 / (60 + rank_in_that_list)`. A chunk both searches found collects
two contributions and rises, with nothing to tune.

**Why keyword hits bypass the threshold.** `MIN_SIMILARITY` gates *semantic*
evidence. An exact keyword match is a different kind of evidence; holding it to
the wrong standard is what made "extension 4417" unanswerable.

**Why `to_or_tsquery` rather than `plainto_tsquery`.** The built-ins AND the
terms. "Who do I contact on extension 4417?" becomes `contact & extens & 4417`,
and the chunk reading "reachable at extension 4417" has no "contact" — so the
AND finds nothing and the one case keyword search exists for is missed. ORing
the lexemes and ranking fixes it.

**Measured effect — honestly, it is small at this corpus size.** On 19 chunks,
across four natural-language questions containing identifiers, hybrid changed
**nothing**: vector search already ranked the right chunk #1 or #2 every time.
The one clear win was a **bare identifier typed alone**:

| Query | Vector-only top 5 | Hybrid top 5 |
|---|---|---|
| `NL-220` | **missed entirely** — 5 chunks passed, none contained it | **rank #2**, correct answer |
| `4417` | rank #1 | rank #1 |
| `NL-114` | rank #1 | rank #1 |

**Cost:** zero extra prompt tokens — `CANDIDATE_COUNT` is 10 per search but the
fused list is trimmed to `MATCH_COUNT` (5). One extra Postgres round trip, run
in parallel with the first.

**Reverse if:** never really — it is cheap and additive. But be clear that on a
small corpus it earns its keep only for bare identifiers. Its value grows with
corpus size, as the chunk holding an identifier gets pushed out of the vector
top-N by semantically closer neighbours.

**Requires:** `schema-hybrid.sql`, run once in the Supabase SQL editor.

---

## D-016 · Query rewriting before retrieval · **Post-MVP, added 2026-09-20**

**Decision:** When a conversation has history, one cheap model call rewrites the
user's question into a standalone search query before it is embedded. The
**search** uses the rewritten query; the **answer** is generated from the
user's original words.

**Why:** conversation history reaches the generator but never the retriever:

```
history  ------------------------------> buildPrompt -> model
question -> embed -> search -----------> buildPrompt
```

Measured before this change: after a turn about the Operations Director,
*"When did they join?"* retrieved **zero chunks** and returned the refusal,
although the answer is in the document. The question embedded on its own is a
vector pointing nowhere.

**Measured after:**

```
Q: When did they join?
   searched for: "When did the floor supervisor and the Operations Director join?"
   3 chunks -> "The current Operations Director, Marisol Venn, joined Northwind
                Labs in the spring of the third fiscal cycle."
```

**Why the answer still uses the original question.** An answer addressing a
silently reworded question reads wrong. The user asked "when did they join?"
and should not get a reply about "when did Marisol Venn join Northwind Labs?".

**Why the only guard is `history.length === 0`.** A pronoun-spotting heuristic
would skip more calls and would sometimes be wrong; this one is always right,
and the rewriter is instructed to echo the question back unchanged when it is
already standalone. Measured: 2 of 4 turns came back unchanged, so the guard
is doing real work without guessing.

**Cost, measured over a 4-turn conversation:** 3 rewrite calls, 409 input +
30 output tokens, **$0.000079** — about **21%** on top of the answers, or
**$0.00002 per message**. Far less than doubling, because the rewrite prompt
carries only the short transcript while the answer prompt carries ~670 tokens
of retrieved chunks. The real cost is **latency**: one extra round trip before
every follow-up.

**Guarded against a misbehaving rewriter:** an empty result, or one much longer
than the question, is discarded in favour of the original. `temperature: 0`,
because this is a mechanical transformation and identical conversations should
rewrite identically.

**What it does NOT fix.** The Phase 3 wrong-antecedent case survives it. Asked
*"And what is the escort ratio for that group?"*, the rewriter resolved the
reference correctly — *"What is the escort ratio for prospective staff badge
holders?"* — and the model **still** answered about auditors. Retrieval was
fixed; generation was not. Exactly the same split seen with D-015.

**Reverse if:** latency matters more than follow-up questions working, which
would be unusual.

---

## D-017 · Reworded the grounding instruction · **Post-MVP, added 2026-09-20**

**Decision:** The system prompt in `buildPrompt()` now separates three things
that *"Do not use outside knowledge. Do not guess."* had collapsed into one:

| | |
|---|---|
| **Connecting** facts the context states | **allowed** |
| **Adding** facts the context does not state | **never** |
| **Partial** answers | give the part that is there, say what is missing |

**Why:** Phase 5 caught this instruction failing in *both* directions.

- **Too loose** (5.5, instruction deleted): the bot answered "the capital of
  France is Paris" and wrote a 400-word sourdough recipe while citing
  lab-handbook chunks.
- **Too strict** (as originally written): it refused *"Who do I contact on
  extension 4417?"* with the chunk reading *"...liaison, currently reachable at
  extension 4417"* in front of it, because answering means joining two stated
  facts. "Do not guess" reads, to a model, as "do not reason."

**Measured with a fixed six-case battery** (`scratch/prompt-eval.js`), run
before and after, covering both directions at once:

| Case | Before | After |
|---|---|---|
| direct fact | PASS | PASS |
| **one-step inference** (extension 4417) | **FAIL** | **PASS** |
| wrong-antecedent follow-up | FAIL | FAIL *(see below)* |
| absent fact, same domain (goggles) | PASS | PASS |
| off-topic (France) | PASS | PASS |
| absent fact, plausible (parking spaces) | PASS | PASS |
| | **4/6** | **5/6** |

**The refusals all held.** That was the thing at risk, and it is why the battery
includes three different kinds of absent question rather than one.

### What it did not fix, and what that tells you

**1. The wrong-antecedent case is a model limit, not a prompt limit.** Asked
*"what is the escort ratio for that group?"*, retrieval and query rewriting both
worked perfectly — the rewrite resolved to "prospective staff on site tours" and
the top chunk contained the exact sentence. `gpt-4o-mini` still answered with the
*auditor* exception instead of the general rule.

Swapping one env var to `gpt-4o` and changing nothing else: **6/6**, with
*"The escort ratio for prospective staff on site tours (violet badge holders) is
one staff member per three visitors."*

A second attempt at fixing this in the prompt (an explicit
general-rule-versus-exception instruction) produced **no improvement** and was
removed rather than left in as tokens that buy nothing.

**2. The partial-answer clause does not hold up under a starved retriever.**
Re-running the Phase 5.4 setup (`CHUNK_SIZE` 300, `MATCH_COUNT` 1), where only
the Quiet Hour's *hours* are retrieved and not its *reason*:

- `gpt-4o-mini`: still invents — *"because the building requires a period of
  reduced noise and activity."*
- `gpt-4o`: degrades to circular rather than false — *"because the building has
  a Quiet Hour policy."*

Neither says "the documents do not say why", which is what the instruction asks
for. **An instruction to admit a gap is much weaker than the pull to complete a
sentence.** Worth knowing: this is the failure mode you cannot prompt your way
out of, and the real fix is retrieving enough context in the first place.

**Model kept as `gpt-4o-mini`** (D-005 unchanged). `gpt-4o` scores better on
reasoning over the retrieved text but costs roughly 16× per input token, and
the difference showed up on one contrived case out of six. It is one env var if
that trade ever becomes worth making.

**Reverse if:** the refusals start leaking. `scratch/prompt-eval.js` exists to
catch that — re-run it after any edit to `buildPrompt()`.

---

## D-018 · Paragraph-aware chunking · **Post-MVP, added 2026-09-20**

**Decision:** `chunkText()` now packs whole paragraphs into a chunk until the
next one would not fit, instead of cutting at a fixed character offset.
`CHUNK_SIZE` becomes a **ceiling** rather than a target. A paragraph larger
than the ceiling is the only thing still cut mid-flow, and it falls back to the
original sliding window — which is also what handles text pasted with no blank
lines in it at all.

**This reverses the MVP half of D-007**, which chose fixed-size chunking so the
naive version could be felt first. Phase 5 did that; this is the informed
version. `CHUNK_SIZE` and `CHUNK_OVERLAP` are unchanged at 1000 and 150.

**Why:** a chunk is represented by exactly one embedding. A chunk holding one
complete idea embeds cleanly; a chunk holding the end of one idea plus the
start of another embeds as a blur of both — and a fixed offset guarantees the
second kind at every boundary.

It also stops a fact being orphaned from its subject. On a test document where
"Presidential Suite" and its nightly rate fell into different fixed-size
chunks:

| Chunk | Contains | Score vs *"what is the nightly rate for the Presidential Suite?"* |
|---|---|---|
| A | the suite's name, no price | **0.498** |
| B | the price, no mention of the suite | **0.384** |

**The chunk holding the answer ranked below the chunk that did not**, because
the cut had separated it from the words that made it findable. With paragraph
breaks present, both land in the same chunk.

**Measured on the Northwind handbook** (2,607 chars, 6 sections):

| | Before | After |
|---|---|---|
| Chunks | 3 (1000 / 1000 / 907) | 4 (584 / 804 / 720 / 937) |
| Boundaries | mid-sentence | every chunk ends on a full stop |

**Similarity scores improved, and the separation improved more:**

| Question | Before | After |
|---|---|---|
| "What time is the Quiet Hour?" | 0.536 | **0.588** |
| "What temperature does the Bay 3 freezer run at?" | 0.462 | **0.530** |
| "Who approves equipment requests over 2000 credits?" | 0.462 | **0.548** |
| "How long are chemical samples retained?" | 0.457 | **0.577** |
| *absent* — safety goggles | 0.427 | 0.427 |
| *off-topic* — capital of France | 0.039 | 0.068 |

True positives rose by 0.05–0.12 while the absent and off-topic questions stayed
flat, so the gap the threshold sits in got **wider**, not just higher.
`MIN_SIMILARITY` stays at **0.25** — still comfortably between the highest
off-topic score (0.092) and the lowest true positive (0.286).

**Prompt battery: 5/6, unchanged.** No regression; the one failure is the
`gpt-4o-mini` limit from D-017.

**Cost:** no extra model calls, and prompts are the same size or slightly
smaller. The one-off cost is that **every document must be re-ingested** —
changing the chunker does not touch chunks already in the database.

**Known limit, honestly:** this can only help where the source *has* paragraph
breaks. The same test text pasted as one unbroken wall still split the suite
from its price, because the sliding-window fallback is all that is left to use.

**Reverse if:** never likely — but the fallback path means nothing breaks on
input without blank lines, it simply behaves as it did before.

---

## D-019 · Streaming responses over SSE · **Post-MVP, added 2026-09-20**

**Decision:** `POST /api/chat` streams the answer as Server-Sent Events when
the client sends `Accept: text/event-stream`, and returns the original single
JSON body otherwise. **This reverses D-010**, which kept streaming out of the
MVP so the one route you most want to read stayed readable. It was, and this is
the informed version.

**Three events:**

```
event: meta     conversationId, searchQuery, sources   (once, before any answer)
event: delta    one fragment of text                   (many)
event: done     end of a successful answer
event: error    a failure that happened mid-stream
```

**The genuinely useful part is `meta`, not the typing effect.** It fires the
moment retrieval finishes and **before the model has written anything**, so the
sources panel is on screen while the answer is still being generated. You can
read what the model was given at the same time as what it makes of it, which is
the sources panel (D-012) doing its job earlier.

**Measured on one question:**

| | |
|---|---|
| Streamed: sources on screen | **1,381 ms** |
| Streamed: first word | 2,013 ms |
| Streamed: complete | 2,651 ms |
| Blocking: nothing at all until | 2,353 ms |

Something useful appears at 1.4s instead of 2.4s — **1.7× sooner** — while the
answer actually finishes slightly later. That is the whole trade: identical
tokens, identical cost, better perceived speed.

### Three things that make streaming harder than it looks

**1. Buffering. A network chunk does not respect event boundaries.** TCP splits
where it likes, so an SSE event can arrive in two pieces. Both the server
(reading OpenAI) and the browser (reading the server) accumulate into a buffer
and only process up to the last blank line. Assuming one chunk equals one event
works right up until it doesn't, and then fails intermittently under load — the
worst possible failure shape.

**2. Errors after the headers are sent cannot use a status code.** Once
streaming starts the response is committed to `200`, so `server.js`'s normal
error-to-status mapping cannot help. The failure has to travel down the stream
as an `error` event, and the client has to treat it as seriously as a bad
status. Validation errors are unaffected — they happen before streaming starts
and still return `400`.

**3. `req.accepts()` is the wrong tool for this.** It honours wildcards, and
curl sends `Accept: */*` — which matches `text/event-stream`, so every curl in
the docs was handed a stream it never asked for and could not parse. Caught in
testing. The check is now an explicit `Accept` header substring: only a client
that names the type gets one.

### Structure

`answerQuestion()` and `answerQuestionStream()` share `prepareAnswer()`, which
is steps 1–7 of the pipeline. Two near-identical copies would have drifted, and
a retrieval fix applied to only one of them is a bug nobody finds. The refusal
short-circuit is emitted as a single `delta`, so the client needs no special
case for it.

`EventSource` cannot be used in the browser: it only issues GET requests, and
the question goes up in a POST body. So the client parses the wire format by
hand — about fifteen lines, and the same parsing the server does to OpenAI.

**Cost:** unchanged. Same tokens in, same tokens out. Prompt battery still 5/6.

**Reverse if:** never needed — the JSON path is still there and still the
default.

---

## D-020 · TypeScript in a Turborepo monorepo · **Migration, added 2026-09-22**

**Decision:** pnpm workspace + Turborepo. Five packages (`@rag/chunker`,
`@rag/openai`, `@rag/db`, `@rag/pipeline`, `@rag/tsconfig`) and one app
(`apps/web`). Strict TypeScript throughout. Reverses D-014.

**Why packages and not folders.** The split is the one `architecture.md` § 7
already argued for; package boundaries make it enforceable rather than
aspirational:

- `@rag/chunker` declares **no dependencies**. In the POC "this file has no
  imports" was a comment, held up by the fact that `server.js` served the file
  to the browser. That mechanism is gone — the admin page imports the package —
  and the rule survives as an empty `dependencies` block.
- `@rag/db` is the only package that may import `server-only`, which is what
  turns "do not leak the service-role key" into a build error (see D-021).

**Why TypeScript now.** The POC's reason for avoiding it was sound and has been
served; see the amendment on D-014. The condition that changed is that the code
now has more than one consumer.

**What it cost, honestly:** roughly 700 lines of retyping, and it caught nothing
that was already broken. Two real bugs were found during the port, but by
*running* things, not by the compiler: a stale `partial: undefined` on every
error, and an env check that made the real message unreachable (D-022).

**The verification that made the port safe was not the type system.** It was
the parity tooling: 87 comparisons on the chunker, 22 on the pipeline, 24 on the
API, all byte-for-byte against the implementation being replaced. Preserved in
`plan/baseline/parity-final.txt`, because the old code is gone and they can
never be re-run.

---

## D-021 · Next.js App Router, replacing Express and the static pages · **Migration, added 2026-09-22**

**Decision:** one Next.js app serves both screens and all six API routes.
Supersedes D-009.

**Why:** the POC's split — an Express server plus two hand-written HTML files —
worked because there were two pages and no shared state. It was already showing
strain: `CHUNK_SIZE` reached the browser only because `server.js` served
`src/chunker.js` as a static file, and `MAX_CONTENT_LENGTH` was duplicated into
`admin.js` under a `// must match server.js` comment. Both are now ordinary
imports.

**What it costs, and the three things that are easy to get wrong:**

1. **`withRoute()` must wrap every handler, by hand.** Express called its error
   middleware for anything that threw. Route Handlers have no equivalent, so one
   unwrapped handler answers with a generic 500 instead of the real reason. Not
   enforceable by types — it is a review item.
2. **The key can now reach the browser.** Express made the boundary physical; a
   bundler does not. `import 'server-only'` in `@rag/db` makes a client import a
   *build* error. Verified both directions: plain Node is refused,
   `--conditions=react-server` is allowed. The cost is that every Node entry
   point needs that flag — including `pnpm eval`, which is the gate on
   `buildPrompt()`, so a gate that silently stopped running was a real risk.
3. **A streaming failure cannot use a status code.** The headers went out with
   the 200, so the error travels as an `error` event. Unchanged from D-019, but
   the mechanism moved from `res.write()` to a `ReadableStream`.

**Reverse if:** never, realistically. But note what was *kept* rather than
adopted: no SDK (D-002), no RAG framework (D-001), the same raw `fetch` calls,
the same SQL, the same prompt.

---

## D-022 · zod at the route boundary · **Migration, added 2026-09-22**

**Decision:** request bodies are validated with zod schemas in
`apps/web/lib/schemas.ts`. This retires the POC's three-dependency rule, which
was a learning constraint rather than an architectural one.

**Why:** the hand-written `typeof` ladders were right for a build whose point
was that nothing was hidden. With two clients, a streaming route and types to
keep honest, a schema that yields the parsed *type* as well as the check earns
its place.

**The error strings are copied character for character**, because they are part
of the contract: both screens render `error` verbatim, and
`"Document is 100001 characters; the limit is 100000"` tells a user how much to
cut where a generic "invalid request" would not.

**One thing it does not do:** validate what comes *back* from OpenAI or
PostgREST. Those are still casts at the boundary (`as EmbeddingsResponse`), and
a cast is a claim about someone else's JSON. Validating them would be a real
improvement and a real dependency on the hot path; not taken during a port.

---

## D-023 · The env check logs at import and throws per request · **Migration, added 2026-09-22**

**Decision:** `apps/web/lib/env.ts` logs missing variables when the module first
loads, and `assertEnv()` throws inside `withRoute()` on every request.

**Why it is not simply a throw at module scope**, which is what it was first and
what most closely mirrors the POC's `process.exit(1)`: **a module that throws
while loading never finishes loading**, so the handler it exports never exists,
so `withRoute()` never runs. The client got Next's generic 500 HTML page and the
real message reached only the server log — which is exactly the outcome
`architecture.md` § 9 rules out.

Found by testing it with an empty `OPENAI_API_KEY` rather than by reasoning
about it. Splitting the two jobs satisfies both § 8 (fail loudly, immediately)
and § 9 (the real message always reaches the client).

---

## Open questions

| # | Question | Resolve by |
|---|---|---|
| **Q-1** | What `min_similarity` actually works on real documents? | Phase 3.2 — log scores and tune |
| **Q-2** | Is 1000/150 the right chunk size for the documents you will actually use? | Phase 5.1–5.2 — the experiment is the answer |
| **Q-3** | Is `gpt-4o-mini` still the right cheap model at build time? | Phase 0 — check the model list |
| **Q-4** | Does `match_count: 5` overflow the context window on long chunks? | Phase 3 — 5 × 1000 chars ≈ 1,250 tokens, comfortably fine. Revisit only if chunk size grows |
| **Q-5** | Keep the `scratch/` test scripts from Phase 1 or delete them? | Phase 4 — they are useful for debugging; a `scratch/` folder in `.gitignore` is a reasonable compromise |
