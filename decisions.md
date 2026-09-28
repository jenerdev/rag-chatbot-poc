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

## D-006 · `service_role` key, no RLS · **Superseded 2026-09-26 by D-038 and D-039**

> **Superseded.** Requests no longer use `service_role`: they reach Postgres
> on a tenant token under RLS policies (D-039), with the code filters kept as
> a second wall (D-038). `service_role` remains, at `@rag/db/service`, for
> tools only. The original decision is kept below as the record of why it
> was right for a one-user local POC.

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

**Amended 2026-09-23, tenancy.** The reasoning above was "the server is the only
client of the database, and it is trusted". That is still true. What changed is
who the server serves: several tenants who do not trust each other (D-025). The
`service_role` key bypasses RLS for every one of their reads, so the thing that
keeps tenant A out of tenant B's rows is no longer the network. It is a
`tenant_id` filter in application code and inside two SQL functions. The weak
point of this posture has moved from "is the database reachable" to "did every
query remember its filter". The composite foreign keys cover writes; reads are
covered only by the leak cases and `tools/isolation.mjs`. See `risks.md` § R-11.
Writing real policies is still the fix, and it is now more urgent, not less.

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

**Amended 2026-09-24 by D-035 (bookings Phase 6).** For a tenant with **no
tools**, nothing changed: zero chunks still means the refusal, with no OpenAI
call. `tool-leak` measured 0 answer calls for Northwind. For a tenant **with
tools**, the short circuit would have made the tool unreachable, because "is
the 12th free?" can match no document. So the model IS called with zero
chunks, and its reply is accepted only if it called a tool on that turn.
Otherwise the reply is replaced with the refusal. The guarantee D-008 exists
for (never an answer from training data when nothing was retrieved) still
holds. What is lost, for tool tenants only, is "free": a zero-match question
cost 485 in + 11 out, measured on "What is the capital of France?" asked of
villa.

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

## D-024 · Greetings answered in code, not from a document · **Added 2026-09-22**

**Decision:** a pure matcher in `packages/rag/src/greeting.ts` recognises a
message that is *entirely* a greeting and returns a canned reply, before any
rewrite, embedding or search happens. Everything else goes down the normal
pipeline untouched.

**Why not a greetings document**, which is the obvious fix and the one that gets
suggested first: it works, and it taxes every other question. That document
competes for the `MATCH_COUNT` slots on every single search, so a chunk of
small talk occupying one of five slots is a chunk of the real answer that did
not reach the prompt. Retrieval is also the wrong instrument — a greeting has no
facts to look up, so the search returns whatever happens to be nearest in a
corpus with nothing to say about it, which is the exact case `MIN_SIMILARITY`
exists to reject (D-008).

**Why before retrieval rather than after zero matches:** there is nothing to
retrieve. Doing it first makes a greeting free — no embedding call, no chat
call, no database round trip beyond the conversation row — and instant.

**The failure mode that shaped the design.** Two things can go wrong, and they
are not equally bad:

| | |
|---|---|
| A greeting is missed | The user gets the refusal. Mildly rude. |
| **A question is taken for a greeting** | The user asked something real and got a canned hello, with no sources and nothing to explain why. |

So the match is anchored at both ends, rejects anything containing `?`, and
rejects anything longer than 24 characters after normalisation. *"hi, what is
the Wi-Fi password?"* is a question that opens politely, and it is answered as
one — verified live, with its three sources intact.

**Verified:** 40 unit cases on the matcher, most of them things it must NOT
claim, plus a live six-case check: greetings greeted, real questions answered,
absent and off-topic facts still refused. 6/6.

**Reverse if:** you want the model to handle small talk conversationally rather
than with one fixed line. That means removing the short circuit for these
messages and paying a chat call for every "hi" — and re-running `pnpm eval`,
because it would mean editing the grounding prompt.

---

## D-025 · Shared tables with `tenant_id`, the filter inside both SQL functions · **Added 2026-09-23 (tenancy Phases 1–2)**

**Decision:** every tenant lives in the same five tables. `tenants` is new, and
`documents`, `chunks`, `conversations` and `messages` each carry a NOT NULL
`tenant_id`. The tenant filter is written **inside** `match_chunks` and
`match_chunks_fts`, as a required `p_tenant_id` argument, not applied to their
results afterwards. One HNSW graph serves every tenant.

**Why not a schema or a database per tenant:** that is N migrations and N index
builds for a product whose point is "add a business in a minute". It also puts
every schema change on a loop. One schema, one migration file
(`packages/db/sql/schema-tenancy.sql`), one index.

**Why the filter goes inside the functions:** filtering after the `limit` is too
late. Ten candidate slots full of another tenant's chunks would fuse into zero
results. Inside the function, another tenant's chunk never takes a slot.

**Why `chunks` carries `tenant_id` when it could join to `documents`:** both
searches scan `chunks` alone, which is why they are fast. The duplicate is
guarded, not trusted. The composite foreign keys `(document_id, tenant_id)` and
`(conversation_id, tenant_id)` make a chunk or message whose tenant disagrees
with its parent's impossible to insert. Observed in `verify.mjs`: the
cross-tenant insert fails with `23503 ... violates foreign key constraint
"chunks_document_tenant_fk"`.

**What Phase 2 measured about the shared index** (pgvector **0.8.2**,
northwind 4 chunks, villa 30):

- At this size the planner does not use HNSW for a tenant-scoped search. It
  reads the tenant's rows through `chunks_tenant_idx` and sorts them exactly,
  which gives perfect recall. The ids matched the Phase 0 baseline exactly.
- With HNSW forced (`tenant_id + 0`) and `hnsw.ef_search = 2`, villa got
  **0 rows**. The walk visited two chunks, both northwind's, and stopped. That
  is the silent false refusal of `plan.md` § 2.1.
- With `hnsw.iterative_scan = 'strict_order'`, the same query returned **5**.
  `relaxed_order` also fixed it, but can return rows slightly out of distance
  order, and the pipeline assumes most-similar-first.

So `match_chunks` carries `set hnsw.iterative_scan = 'strict_order'` (confirmed
in `pg_proc.proconfig`). It costs nothing today, and is insurance for the day a
tenant is large enough for HNSW to win. No composite GIN index was built:
full-text search also goes through `chunks_tenant_idx`.

**What it costs:** isolation is enforced by code, not by the database, for every
read (R-11). And recall under a shared graph has to be re-measured as tenants
grow (R-10).

**Reverse if:** one tenant grows large enough to deserve its own index, or a
customer requires physical separation. A partial HNSW index per tenant is the
next step before a separate database.

---

## D-026 · A tenant is a path segment, `/t/<slug>`, not a subdomain · **Added 2026-09-23 (tenancy Phases 5, 7)**

**Decision:** screens live at `/t/<slug>` and `/t/<slug>/admin`, and every API
route lives at `/api/t/<slug>/…`. The old un-prefixed paths are gone, with no
redirect: `POST /api/chat` and `GET /api/documents` return **404**, as observed.

**Why a path and not a subdomain:** it is identical on localhost and hosted. It
needs no wildcard DNS and no wildcard certificate, and the slug is visible in
every URL and every log line.

**The one resolution point:** `withTenantRoute()` in `apps/web/lib/tenant.ts`
turns the `[tenant]` segment into a `TenantContext` or answers
`404 {"error":"No workspace named \"<slug>\""}`. It never falls back and never
lists real slugs. The pages do the same through the cached `getTenant()`, and
`/t/nope` renders "No such workspace". Moving to subdomains later means
changing that one lookup.

**What it costs:** a slug is part of every URL, so renaming a tenant breaks its
links. Slugs are therefore constrained in SQL (`tenants_slug_shape`,
`tenants_slug_reserved`) and should be treated as permanent.

**Reverse if:** tenants want their own domains. The resolution function then
reads the `Host` header instead of the path. Nothing downstream changes,
because everything downstream takes a `TenantContext`.

---

## D-027 · `tenant` is a required argument everywhere, with no default and no ambient context · **Added 2026-09-23 (tenancy Phase 3)**

**Decision:** every pipeline function that touches the database takes a
`TenantContext { id, slug, businessName, assistantName }` as a required
argument: `ingestDocument`, `listDocuments`, `countDocuments`, `deleteDocument`,
`getChunks`, `retrieve`, `answerQuestion`, `answerQuestionStream` and
`getMessages`. There is no `AsyncLocalStorage`, no module-level "current tenant"
and no `tenantId = 1` default. `p_tenant_id` has no default in SQL either.

**Why:** a default tenant is a silent cross-tenant read. It looks like working
code and answers from the wrong documents. Required means a forgotten call site
is a compile error, and a forgotten database argument is a database error. It
is the same move `server-only` made for the service-role key. Observed after the
change: the old unscoped `match_chunks` call returns `PGRST202 Could not find
the function`, and an insert without `tenant_id` fails with `23502`.

**`TenantContext` is a value object, not a row.** `loadTenant()` selects four
named columns. It never uses `select('*')`, so `admin_key_hash` cannot end up in
an object that gets passed around and, eventually, serialised. The plan's grep
of every `from(...)` and `rpc(...)` line in `packages/rag/src` showed a tenant
filter on **15 of 15**.

**The one exception was temporary and is gone.** D-031's bridge was a default
tenant in the database plus the old unscoped functions, and later a
northwind-only route pin. It existed between Phases 1 and 5 so the app kept
working, and it has been removed in full.

**What it costs:** every signature is one argument longer, and every test has to
construct a tenant.

**Reverse if:** never, while the service-role key is on the read path. If RLS
policies ever carry the tenant instead (R-2), the argument becomes redundant
rather than wrong.

---

## D-028 · Per-tenant admin key, scrypt-hashed, behind a path-scoped signed cookie, hand-rolled · **Added 2026-09-23 (tenancy Phase 6). Key superseded 2026-09-26 by D-040; the cookie kept**

> **The key is gone; the cookie stays.** Staff log in with Supabase Auth and
> a membership (D-040). The HMAC cookie, its `/api/t/<slug>` path and its
> slug check are kept, now carrying the user id:
> `<slug>.<userId>.<expiry>.<mac>`. `admin-key.ts`, `tenant:key` and
> `tenants.admin_key_hash` were deleted in auth-rls Phases 5–6.

**Decision:** each tenant has one admin key.
- `tools/tenant.mjs` generates 32 random bytes, prints the key **once**, and
  stores only an scrypt hash, as `scrypt$N$salt$hash` (N = 2^15, a 16-byte
  salt). Measured at **50 ms** per hash.
- Logging in (`POST /api/t/<slug>/admin/session`) sets an httpOnly,
  SameSite=lax cookie `<slug>.<expiry>.<hmac-sha256>` signed with
  `ADMIN_COOKIE_SECRET`. It is `Secure` everywhere except `next dev`.
- `requireAdmin()` guards the list, add and delete document routes and the
  chunks route with a 401. Chat stays open, because it is the product.

**Why hand-rolled:** D-001/D-002 still hold. It is `node:crypto` in two short
files (`packages/db/src/admin-key.ts`, `apps/web/lib/admin-auth.ts`), against an
auth framework's worth of concepts.

**Three deviations from `plan.md`, each for a reason found while building it:**

1. **The cookie path is `/api/t/<slug>`, not `/t/<slug>`.** A browser sends a
   cookie only to URLs under its path. The routes this cookie guards live under
   `/api/t/<slug>/…`, so with `/t/<slug>` the cookie would be set and then
   never sent: logging in would do nothing. `/api/t/villa` does not path-match
   `/api/t/villa2`, so the isolation the plan wanted is kept. `readSession()`
   also checks that the slug in the cookie is the tenant in the URL, because
   curl sends whatever it is given.
2. **The hashing lives in `@rag/db` (`admin-key.ts`), not `apps/web/lib`.**
   Two callers need it: the login route verifies, and `tools/tenant.mjs`
   hashes. `@rag/db` is beside the column it protects, and both can import it.
3. **`tenant:key` was added next to `tenant:add`.** northwind and villa were
   created in Phases 1 and 2 without a key, and a key-less tenant can never be
   administered, since NULL means deny. Rotating a key is the same command.

**Verified (16 curl cases, against throwaway tenants since deleted):**
- **401:** no cookie; a wrong key; another tenant's cookie sent by hand; a
  swapped slug; a tampered signature; a correctly signed but expired cookie;
  after logout; and a tenant with no key.
- **200:** the right key, with `Path=/api/t/authprobe; HttpOnly; SameSite=lax`;
  and chat with no cookie.
- **400:** an empty login body.
- **Leaks:** the key appeared 0 times in the server log. 0 static files contain
  `admin_key`, `ADMIN_COOKIE_SECRET`, `rag_admin` or `scrypt`.

**What it is not:** a replacement for RLS. It decides who may edit a knowledge
base through this app. It does nothing about the service-role key reading
every tenant's rows (R-2, R-11). There is no rate limit on login attempts
(R-13).

**Reverse when:** real users arrive. The cookie is the thing to delete, replaced
by a users table, tenant membership, and RLS policies that carry the tenant.

---

## D-029 · Persona above the grounding block, which stays byte-identical, gated on the battery · **Added 2026-09-23 (tenancy Phase 4)**

**Decision:** `buildPrompt(tenant, …)` opens with one line, *"You are
{assistantName}, the assistant for {businessName}."* Everything below it is
D-017's block, byte for byte. `greetingReply(message, tenant)` names the
tenant's assistant and business.

**Why so little:** a persona is an invitation to be helpful, and being helpful
is how refusals erode (`plan.md` § 2.6). The line says who is speaking and
nothing about tone, eagerness or expertise. The plan offered a second sentence
("answer only from the context below, even when a more helpful answer seems
obvious"). It was **measured as unnecessary** and left out, because every extra
line in that prompt is something the next edit has to re-measure.

**The gate, observed:** the six original Northwind verdicts matched
`plan/baseline/eval-pre-tenancy.txt` exactly, **on two runs**. That is 5 PASS
and the same `antecedent` FAIL, with the same wrong "auditor 1:1" answer. With
the four new cases the battery reads **9/10**: leak-1, leak-2 (plus a villa
control), leak-3 and persona all pass.

**A test that could not fail, fixed.** villa's assistant was first named
"Amihan", which is also in "Villa Amihan Private Resort". So "the greeting
mentions Amihan" was true however the greeting was written. It was renamed to
**"Lia"**, and the persona case asserts this tenant's assistant name AND
business name, and neither of the other tenant's.

**What it costs:** every future prompt edit re-opens the question (R-12).

**Reverse if:** a tenant needs more than a name, such as a tone or a language.
Add it as another line above the block, and do not keep it until the six
verdicts match.

---

## D-030 · Branding as CSS custom properties through React's `style` prop, from an allowlist · **Added 2026-09-23 (tenancy Phase 7)**

**Decision:** a tenant's `theme` jsonb becomes CSS custom properties on a
wrapper `<div>` through React's ordinary `style` prop. `themeVars()` in
`apps/web/lib/branding.ts` reads an **allowlist of five keys**: `accent`,
`accentSoft`, `bg`, `panel` and `ink`. It keeps a value only if it matches
`^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$`, and silently drops everything else.
`logo_url` and `banner_url` are kept only if they parse as absolute `https:`
URLs.

**Why:** the obvious implementation, `<style dangerouslySetInnerHTML=…>`, is
CSS injection from a database column, and exactly what CLAUDE.md § Conventions
forbids. The `style` prop needs no exception to that rule, React escapes it,
and the regex means a string that is not a colour never reaches the page.
`globals.css` already reads every colour from a custom property, which is why
five keys are enough.

**Verified with a hostile theme:** `ink: "red;}body{display:none"`,
`panel: "url(javascript:alert(1))"`, an unknown key `evil`, a `javascript:`
banner and an `http:` logo. The rendered HTML contained **0** occurrences of
any of them. The wrapper carried exactly
`--accent:#0f766e;--accent-soft:#e7f5f2;--bg:#faf7f2`.

**What it costs:** a tenant cannot have a gradient, a font, or any colour
format other than hex. That is the point.

**Reverse if:** tenants need richer branding. Add keys to the allowlist, each
with its own strict validator. Never pass the jsonb through.

---

## D-031 · A temporary tenancy bridge between Phase 1 and Phase 3 · **Fully removed 2026-09-23: the database half in Phase 3, the route pin in Phase 5**

**Context:** `plan.md` says Phases 0–2 touch no application code. Phase 1 as
written contradicts that. With `tenant_id` NOT NULL and no default, today's
un-threaded inserts all fail, which breaks ingest, conversations and messages.
Replacing `match_chunks` with a version that requires `p_tenant_id` breaks
retrieval and `pnpm eval`. The app would stay broken until Phase 3.

**Decision:** `packages/db/sql/schema-tenancy.sql` adds a bridge that is
explicitly temporary:

1. The `tenant_id` columns default to `tenancy_bridge_default_tenant()`, which
   returns northwind's id.
2. The old, unfiltered `match_chunks(vector, int, float)` and
   `match_chunks_fts(text, vector, int)` stay as overloads next to the new
   tenant-scoped signatures. PostgREST picks by argument name: a call with
   `p_tenant_id` reaches the new function, and a call without it reaches the old
   one.

**Why:** it keeps every phase runnable and measurable. Phase 1 verified
`pnpm eval` at 5/6 through the bridge, the same result as the Phase 0 baseline.

**What it costs:** both halves are exactly what D-027 forbids, which is a
default tenant and an unscoped search. They are harmless while northwind is the
only tenant. **They become a cross-tenant leak the moment a second tenant
exists**, and tenancy Phase 2 creates `villa`. Until Phase 3 lands, anything the
app ingests goes to northwind, and any question it answers searches every
tenant.

**Reverse:** in Phase 3, once every insert and `.rpc()` sends the tenant. The
drop statements are at the bottom of `schema-tenancy.sql`. Phase 3 is not done
until they have run. Its grep for tenant filters should then also find no call
that reaches the old overloads.

**Removed 2026-09-23.** `schema-tenancy.sql` was rewritten to describe the final
state: its step 9 drops the default, `tenancy_bridge_default_tenant()`, and both
old signatures, so re-running it can never put the bridge back. Observed
afterwards:
- the old `match_chunks` and `match_chunks_fts` calls return `PGRST202 Could not
  find the function`;
- an insert without `tenant_id` fails with `23502 null value in column
  "tenant_id" ... violates not-null constraint`.

**What remains, until Phase 5: a route pin.** Phase 3 made `tenant` a required
argument, but the routes do not move to `/api/t/<slug>/` until Phase 5. So the
existing routes call `bridgeTenant()` in `apps/web/lib/tenant.ts`, which
resolves `northwind` by slug and throws if it is missing. It is a hard pin, not
a default. Nothing falls back to it, and no request can pick another tenant
through those routes, so villa is unreachable over HTTP until Phase 5. That is
strictly safer than the database bridge it replaced. Verified over HTTP: the
document list shows only northwind; villa's document 38 gives `[]` for its
chunks and `404` on delete; the parking question is refused. Phase 5 deletes
`bridgeTenant()` along with the old routes.

**Route pin removed 2026-09-23 (Phase 5).** `bridgeTenant()` is deleted. Every
route now lives under `app/api/t/[tenant]/` behind `withTenantRoute()`. The old
paths return `404`: `POST /api/chat` and `GET /api/documents` were both
observed as 404. Nothing of D-031 remains.

---

## D-032 · Booking logic in `@rag/bookings`, HTTP in `apps/web`, and the tool calls the package directly · **Added 2026-09-24 (bookings Phases 2–3)**

**Decision:** availability and bookings live in a server-only package,
`@rag/bookings` (depends on `@rag/db` only). The admin Route Handlers and the
chatbot's tool executor are its two callers, and both call the same functions
in process. The chatbot never makes an HTTP request to this app's own `/api`.

**Why:** two callers, one function. One place validates a date, one place maps
`23P01` to 409, and one result type (`SlotAvailability`) has no guest fields.
An HTTP hop from the pipeline to the app would add latency, an auth problem
(the chat route has no admin session) and a loss of types, for nothing.

**Consequences:** validation lives in the package, not only at the route,
because the tool executor has no zod schema in front of it. The package takes
`BookingTenant { id, slug }` rather than pipeline's `TenantContext`, because
the dependency points pipeline → bookings → db. `TenantContext` satisfies it
structurally.

**Reverse if:** bookings becomes its own deployed service. Then this package
becomes that service's client, and the rule "one function, two callers" moves
with it.

---

## D-033 · Applications are a registry in code; `tenant_applications` only switches them on · **Added 2026-09-24 (bookings Phases 1, 3)**

**Decision:** `APPLICATIONS` in `packages/rag/src/applications.ts` names each
application and its tools. `tenant_applications (tenant_id, application_key,
config)` says which tenant has which. Having a row means "on". There is no
`enabled` column. A `check` constraint lists the same keys as the registry, and
`enabledApplications()` also drops any key the registry does not know.

**Why:** an application is code (tables, a package, tool definitions, an
executor), and a row cannot create one. A boolean would give three states
(no row, false, true) where two are needed, and one more thing every query
must filter on.

**Where it is enforced, four times:**
- the page: `notFound()`;
- the routes: `requireApplication()`, a 404, after `requireAdmin()` so a
  stranger always gets 401;
- the tool executor: it re-checks enablement at call time, whatever the model
  was offered;
- the database: the `bookings_compute_during` trigger refuses a booking for a
  tenant without the application (`23503 Tenant 21 does not have the bookings
  application`).

**Reverse if:** a tenant needs two instances of one application. The primary
key allows one per tenant, which is enough until a real tenant needs more.

---

## D-034 · A booking is a time range under an exclusion constraint, computed in SQL from the tenant's timezone · **Added 2026-09-24 (bookings Phase 1)**

**Decision:** `bookings.during` is a half-open `tstzrange`, computed by a
`before insert or update` trigger from the slot's `start_time` and `duration`
and the tenant's `config.timezone`. It overwrites anything the insert supplied.
`bookings_no_overlap exclude using gist (unit_id with =, during with &&) where
(status <> 'cancelled')` makes two live bookings of one unit overlap-proof.
`check_availability()` applies the same `&&` test.

**Why:** Villa sells the whole property in three slots, two of which cross
midnight. "Only one slot is sold per day" and "an Overnight blocks the next
morning's Day Tour" follow from range overlap with no rule written in code, and
the same model covers a hotel (one unit per room). The constraint, not timing,
prevents double-booking: a "check, then insert" in code double-books when two
requests race. The trigger rather than the planned `create_booking()` RPC,
because every insert path then gets the same range. The conversion is done in
Postgres, which has the IANA database, not with `Intl` in JavaScript.

**Measured:** Overnight 2026-10-01 in Manila is `["2026-10-01
06:00:00+00","2026-10-02 04:00:00+00")`. A supplied `during` of 2000-01-01 was
overwritten. The overlap fails with `23P01`. Back-to-back slots (17:00 end,
17:00 start) are both accepted. `check_availability` marked Overnight on 2 Oct
taken because it starts inside that day's Day Tour, which is the case my own
expectation had got wrong.

**What it costs:** changing a tenant's timezone does not move existing
bookings. That is deliberate: they keep the instants the guests were told. A
turnover gap between bookings (the owners' open question) is not modelled yet.

**Reverse if:** availability needs capacity rather than exclusivity ("3 of 5
Deluxe rooms left"). Add a `unit_type`, keep one `unit` per room, and the
constraint still holds per unit.

---

## D-035 · Zero chunks: accept the model's reply only if it called a tool this turn · **Added 2026-09-24 (bookings Phase 6). Amends D-008**

**Decision:** for a tenant with tools, the model is called even when retrieval
returns nothing. `acceptReply()` then replaces its text with `NO_ANSWER` unless
a tool was called on that turn. While streaming, that text is **held** by
`chatStream(…, { holdContent })` until the decision is made, because text
already on screen cannot be replaced. For a tenant without tools, D-008 is
unchanged.

**Why:** D-008's short circuit would have made the tool unreachable. It also
could not simply be removed, because that brings back the model answering from
training data with nothing retrieved. With this rule, the only possible
outputs at zero chunks are the refusal and an answer built from a tool result.

**Measured:** `tool-leak`, Northwind with no tools, made 0 answer calls.
"What is the capital of France?" asked of villa made one call, and the reply
was held, replaced, and sent as 1 delta, at 485 in + 11 out.

**Reverse if:** a cheap pre-classifier ("is this an availability question?")
proves more reliable than letting the main model decide. Then zero chunks and
"not availability" can short-circuit for free again.

---

## D-036 · The tools block goes after the context, only when there are tools, and every sentence in it is measured · **Added 2026-09-24 (bookings Phase 6)**

**Decision:** `buildPrompt(…, tools)` appends one block after `--- END CONTEXT
---`: "A tool result is context too, and every rule above applies to it", the
availability rules from `tools.ts`, and "Today is <date> (<weekday>),
<timezone>". The grounding block (D-017) and the persona line (D-029) are
untouched. With no tools, the output is byte-identical to before.
`prompt-snapshot` diffed against `plan/baseline/northwind-prompt-pre-bookings.txt`
is the check.

**Why after, and why "context too":** D-017's rules (connect, never add, say
what is missing) then apply to a tool result without being restated. Today's
date is there because the model has no clock. "8 October", with no year,
resolved to `2026-10-08` because of it.

**Every sentence answers a measured failure. The wording history, all on
gpt-4o-mini:**

| Wording | Tool cases | What it showed |
|---|---|---|
| First block | 9/9 | the checks were too loose to fail |
| Checks tightened | 6/9 | three wording faults caught |
| Prohibitions ("never…", "do not…") | 7/9 | only the tool-error sentence worked |
| What to write instead | 9/9 | the Open/Taken lines and one date question |

After that, the "name the date" check made it 6/9 again. An unscoped "start
with a sentence that names the date" was 9/9 on the tool cases, and cost
`leak-2`'s villa control, 1 run in 3. Scoped to "when you answer about
availability" it was 3 in 3, and the full battery is **18/19**, with the
original ten identical to the pre-bookings baseline.

**The lesson that generalises D-017:** this model follows a concrete
instruction about what to write, and loses a prohibition to a familiar
phrase. And an instruction written for one kind of answer must say so, or it
lands on every answer.

**What it costs:** 422 input tokens per answer call on a tool tenant (the same
villa question with the same 5 chunks: 1,260 → 1,682). Every edit re-opens
R-14 and R-18.

---

## D-037 · Chatbot tools are read-only, results carry no PII, and every call is shown · **Added 2026-09-24 (bookings Phases 1, 6, 7). Still holds after D-069: booking is the page's, not the chat's**

**Decision:** the only tool is `check_availability`. Its result is
`SlotAvailability { date, unit, slot, status }`, a type with no guest field.
The SQL function selects none, and the package maps rows field by field
rather than spreading them. The tool's schema has no tenant, unit or booking
id; the executor takes `tenant` from the server. Every call is sent to the
browser as a `tool` SSE event and shown, open, as "Checked availability"
above the sources (D-012 extended).

**Why:** the chat route is open, so a write tool would be an unauthenticated
write through the model. Anything a tool returns goes into a prompt, and a
prompt-injected model can recite it. So PII is kept out of the result, not
out of the model's behaviour. Showing the call makes a wrong date, or an
answer that disagrees with its tool result, visible on screen.

**Measured:** `tool-pii` ("Who booked … What is their phone number?"):
neither the fixture's name nor its phone appeared in the reply or the tool
results. `check_availability` keys are `booked_date,slot,status,unit`. The
wire payload of the `tool` event has no guest field. The browser bundle grep
for `guest_phone` returns 0.

**Reverse if:** guests are allowed to request a booking in chat. That is a
`request_booking` tool creating `pending` rows only, after an explicit
confirmation turn, with rate limiting and a guest identity step, and it
belongs in its own plan (`plan/bookings.md` § 7). It needs R-2 taken
seriously first.

---

## D-038 · Two walls between tenants, code filters and RLS, and each is tested alone · **Added 2026-09-26 (auth-rls Phases 1, 3, 5)**

**Decision:** every `tenant_id` filter in application code stays, and RLS
policies keyed on the token's `tenant_id` claim sit behind them. Neither is
accepted as proof of the other.

**Why:** a wall that is only ever tested alongside another one might not be
there. The filters were the only wall for three days (R-11). The policies are
new, and a refactor that trusts one wall tends to delete the other.

**Measured:**
- **RLS alone.** Villa's chat token with NO filter reads 8/8 documents,
  30/30 chunks, 141/141 conversations and 368/368 messages, with 0 foreign
  rows. `match_chunks` naming another tenant's id returns 0 rows (verify
  checks 28–46).
- **Filters alone.** `isolation --filters-only` runs every context on the
  service client: 11/11, and bookings 12/12.
- **Both.** On tokens: 11/11 and 12/12. The eval gives 18/19, with verdicts
  identical to the pre-auth baseline.

**Reverse if:** never, as a principle. The day a filter looks redundant is
the day to run `--filters-only`, not to delete it.

---

## D-039 · Server-minted, 5-minute tenant tokens, signed ES256 with our own key imported as a Supabase standby key · **Added 2026-09-26 (auth-rls Phase 0)**

**Decision:** every request will reach Postgres with a short-lived token
that the server signs itself, including anonymous chat:
`{role: authenticated, tenant_id, iat, exp: +5min}`, with no `sub` (§ 2.4).
The signature is ES256 over an EC P-256 key that we generated. That key is
imported into the project's JWT signing keys as a **standby** key, and the
signing is hand-rolled on `node:crypto` (D-002's spirit). The signer
refuses any `role` other than `authenticated`. This is option **A** of
`plan/auth-rls.md` § 2.1. B (the legacy HS256 secret) and C (a direct
Postgres connection) were not tried, because the plan tries them only if A
fails.

**Why:** the project uses asymmetric signing keys, so Supabase holds the
key its own tokens are signed with. PostgREST trusts every key published in
the project's JWKS. Importing a key as standby publishes it without making
Supabase Auth sign with it. The result is one trust path for staff tokens
(signed by Supabase) and chat tokens (signed by us). It also depends on
nothing that Supabase is retiring, which B does.

**Measured** (`plan/baseline/auth-spike-phase0.txt`):
- The same claims and code, signed by the same key, before and after the
  import:
  - **before:** `401 PGRST301 "No suitable key was found to decode the JWT"`;
  - **after:** `200` with `{"role": "authenticated", "tenant_id": 3, …}`
    from `select auth.jwt()`.
- After the import, the JWKS lists `ea5ce335…` next to Supabase's `cb77f580…`.
- A Supabase Auth sign-in after the import was still signed with
  `kid=cb77f580…`. Standby did not take over Auth's signing.

**Reverse if:** Supabase stops publishing standby keys in the JWKS. The
same signal: chat tokens start failing with PGRST301. Or: a key rotation in
the dashboard revokes the imported key. If so, fall back to C, not B.

**Caveat, resolved in Phase 3 (2026-09-26):** the spike's key
(`ea5ce335…`) had its private half shown in the session transcript. Phase 3
replaced it with `45345cbc…`:
- generated straight into `scratch/`, with only its kid printed;
- copied to the dashboard with `clip`, never displayed;
- stored in `.env` as `TENANT_SIGNING_JWK`.

`ea5ce335…` was then revoked. A token it signs now gets `401 PGRST301`, and
the JWKS lists only `45345cbc…` and Supabase's `cb77f580…`.

**Found while swapping:** the dashboard allows **one standby key at a
time**. Replacing ours means removing the old standby first, which is a
short window in which no tenant token verifies. At a real deployment, that
is a rotation to schedule, not a click.

---

## D-040 · Supabase Auth authenticates staff; our HMAC cookie carries the session; the membership is re-checked on every request · **Added 2026-09-26 (auth-rls Phase 5). Supersedes D-028's key**

**Decision:**
- **Login:** `POST /api/t/<slug>/admin/session {email, password}` runs:
  1. `signInWithPassword` (the Supabase session is revoked at once);
  2. then the membership, read through a staff token;
  3. then our cookie, `<slug>.<userId>.<expiry>.<mac>`.
- **Every admin request:** `requireAdmin()` re-checks the membership and
  returns a STAFF context, which the handler swaps in for its chat context.
- **Password resets and invites:** Supabase emails them. The link lands on
  `/t/<slug>/admin/reset`, which reads the token from the #fragment, wipes
  it, and posts it once to `…/admin/password`, a raw
  `PUT /auth/v1/user`.

**Why:** password storage, reset tokens and email verification are the parts
where a readable hand-rolled version is also the dangerous one. That is the
one deliberate exception to D-001/D-028's "hand-roll it". Who administers
which tenant stays ours: `memberships`, which Postgres checks again on every
write (`app_is_admin()`). Re-checking on every request makes a removal take
effect at the member's next click.

**Measured** (`staff-cases.mjs`, with the web process holding no service key):
- a right password gives 200;
- a wrong password, an unknown email and a non-member each give 401, with
  byte-identical messages;
- another tenant's cookie gives 401;
- a member removed mid-session gets 401 on the same cookie.

A member books a slot and reads it back with its guest name. In the browser,
the invite link, setting a password, logging in and logging out all work.

**Reverse if:** SSO or MFA is needed. Both sit in Supabase Auth, and the
cookie and membership check stay.

---

## D-041 · One role: a membership row is admin · **Added 2026-09-26 (auth-rls Phase 1)**

**Decision:** `memberships (user_id, tenant_id)` with no role column. A
member can manage the tenant's documents and bookings. Rows are written only
by `member:add|remove`, on `service_role`, in a tool.

**Why:** it is the smallest policy set that works. `app_is_admin()` is one
`exists`. A `role` column added later gives every existing row the meaning
"admin", which is what they already mean, so it needs no data migration.

**Reverse if:** a tenant needs staff who can see bookings but not edit
documents, or the reverse. Add `role`, and make `app_is_admin()` role-aware.

---

## D-042 · `security definer` for exactly two functions, `tenant_public` and `check_availability`, both with `search_path = ''` · **Added 2026-09-26 (auth-rls Phase 1). Amended by D-054 (three) and D-071 (four)**

**Decision:**
- **`tenant_public(slug)`** returns the seven public tenant columns, and anon
  may call it: the server needs it before it knows which tenant to mint for.
- **`check_availability`** runs as its owner, so a chat token can ask about
  availability without SELECT on `bookings`. It raises `42501` unless
  `p_tenant_id` is the token's tenant (or the caller is `service_role`).
- **Everything else is security invoker, so RLS applies inside it.** That
  includes `app_is_admin()`, a deliberate deviation from the plan's sketch.

**Why:** each of the two needs to see a table the caller must not: the tenants
row, and guest-holding bookings rows. A definer function bypasses RLS, so it
must enforce the tenant itself, and `search_path = ''` stops a caller putting
their own `bookings` in front of ours.

**Measured:**
- a chat token reads 0 of 5 bookings, yet gets 6 availability rows;
- `check_availability` with another tenant's id gives `42501`;
- `tenant_public('villa')` returns exactly
  `assistant_name,banner_url,business_name,id,logo_url,slug,theme`.

**Reverse if:** a third function seems to need definer. Try a policy first,
because every definer function is another place the tenant check can be
forgotten.

**Amended 2026-09-27 by D-054:** a third, `check_room_availability`, for the
same reason `check_availability` is definer (it must see `bookings`, which a
chat token cannot read), with the same five properties.

---

## D-043 · Tagalog in, Taglish out: the reply language is decided in code, and the prompt carries one directive · **Added 2026-09-26**

**Decision:**
- **`packages/rag/src/language.ts` decides the reply language**, from the
  user's own messages, newest first, the current one included:
  1. an explicit request ("Tagalog lang po", "Please respond in English",
     "Taglish po") wins and holds until another request;
  2. otherwise, the latest message that has a language: any Tagalog function
     word (po, ang, ng, ba, mga…) → **Taglish**; two English function words
     and no Tagalog → English; a bare date, number, "yes" or "okay" → no
     language, so the scan carries on to the message before it.
- **`buildPrompt()` appends that language's lines LAST**, after the tools
  block. An unrequested English reply appends **nothing**, so every English
  prompt is byte-identical to the one before (the northwind snapshot still
  matches `northwind-prompt-pre-bookings.txt`).
- **A bare request is answered in code**, like a greeting: "Please respond
  in English" has nothing to retrieve and used to end in the refusal.
- **The refusal stays the exact English `NO_ANSWER`**, in every language.
- The scan reads up to `LANGUAGE_SCAN_MESSAGES` (50) stored user messages in
  one extra query, tenant-filtered, that never reaches the model. So a
  request outlives `MAX_HISTORY`.

**Why:** there was no language rule at all, so the model mirrored the user.
Measured before (`plan/baseline/eval-lang-before.txt`, 5/10):
- a Tagalog question got pure, formal Tagalog ("Oo, puwedeng magdala ng
  maliit at katamtamang laki ng aso…", 0% English);
- a Taglish question got plain English;
- every availability answer was English, word for word the tools block's
  example sentence, even when asked in Tagalog.

The first fix was prompt only ("English in, English out; Tagalog in, Taglish
out", plus an example). It measured 5/10, then 7/10, then 9/10, then 7/10.
The Taglish example pulled ENGLISH questions into Taglish ("Ang Overnight
rate po natin is ₱20,000 on weekends"), and a bare "10 October" was read as
English. Asking gpt-4o-mini to classify and to write in the same instruction
failed both ways, so the classifying moved to code. Code does it the same way
every time, and the model only writes.

**Measured after:**
- lang cases 9/10 on two runs in a row;
- the full battery 26/29: `original 9/10 · tool 9/9 · lang 8/10`, with
  `lang-tagalog-2` failing once at 0.90 English, and then passing 4 of 4
  repeats (English share 0.50–0.65);
- isolation 11/11 both ways, bookings isolation 12/12, verify 47/47, tests
  103 in the pipeline.

The one steady failure is `lang-followup`. After a bare date, the reply stays
in Taglish (before the change it switched to English), but it leans Tagalog:
"Yes po, lahat ng slots ay open sa 10 October 2026", 0.13 English against the
0.20 floor.

**Reverse if:** a model follows "reply in the user's language, but Taglish
for Tagalog" reliably by itself. Then the classifying can go back into the
prompt, and the lang-english case is the one to watch. Or if a tenant's users
write a third language: the word lists are Tagalog and English only.

---

## D-044 · Editing a document is ingest-then-delete, and the edit gets a new id · **Added 2026-09-27**

**Decision:** `updateDocument()` checks that the document is this tenant's,
ingests the new text as a new document, and then deletes the old one. There
is no UPDATE.

**Why:**
- An edit changes every chunk, so every chunk needs a new embedding anyway.
  Nothing from the old row is worth keeping except its text, which the form
  replaces.
- Updating in place would need two new policies: UPDATE on `documents` and
  DELETE on `chunks`. `schema-auth.sql` deliberately has neither (chunks go
  only by cascade). A new policy is a new surface to test (R-22). Ingest and
  delete already exist and are already tested.
- **The order:** if embedding fails, `ingestDocument()` removes its own new
  row and the old version is untouched, so the bot keeps answering.
  Delete-first would leave a gap during the embed call, and a permanent one
  if it failed. While both versions exist, a question can retrieve both, and
  the model sees the same fact twice.
- The ownership check comes first, so another tenant's id is refused before
  anything is written.

**Cost:** the id changes, and the document moves to the top of the
newest-first list. Nothing stores a document id beyond the request (sources
are rebuilt per answer), so nothing dangles.

**Measured:** isolation checks 13 (`getDocument cross-tenant is null`) and
14 (`updateDocument replaces in its own tenant only`), 14/14 on chat and staff
tokens and 14/14 filters-only.

**Reverse if:** something starts to hold document ids long-term, such as
citations stored with messages or links shared to a document. Then an edit
must keep its id: an UPDATE on `documents`, a chunk-replace function, and
policies for both.

---

## D-045 · "Resolved" is a staff-only row in its own table, never a delete · **Added 2026-09-27**

**Decision:** marking an unanswered question resolved inserts a row into
`unanswered_resolutions (message_id, tenant_id, resolved_at)`, keyed by the
refusal's message id. Reopening deletes that row. The S-4 list has two tabs:
Open (no row, an anti-join) and Resolved (an inner join).

**Why not delete the question:** the list isn't stored anywhere. It's read
out of `messages`, so deleting an entry means deleting a visitor's
transcript, and no token may delete messages.

**Why not a `resolved_at` column on `messages`:** it would need an UPDATE
policy on a table the open chat token already reads and inserts into. A
separate table keeps `messages` append-only, and its policies can demand
`app_is_admin()` on every verb.

**How the tenant is held:**
- Wall 1: every query filters `tenant_id`. `resolveUnanswered()` first checks
  that the id is this tenant's refusal.
- Wall 2: the policies. A composite FK `(message_id, tenant_id)` →
  `messages (id, tenant_id)` makes Postgres refuse a resolution whose tenant
  disagrees with its message's.

**Measured:**
- verify 48 `auth: resolutions are staff-only`: chat insert 42501, staff
  insert ok, chat reads 0, staff reads 1, staff deletes 1;
- isolation 15 and 16, 16/16 both ways.

**Trap found on the first run:** PostgREST embeds the resolution as an
ARRAY, because `message_id` alone is the unique key, not
`(message_id, tenant_id)`. The hand-written type said one-to-one, so
`resolvedAt` read `undefined` and the resolved tab would have shown no
dates. Check 16 caught it (`in resolved false`).

**Reverse if:** resolutions need more than a flag, such as who resolved it,
a note, or the document that answered it. Then extend this table. It is
still not a reason to touch `messages`.

---

## D-046 · Relative dates are resolved in code, and an availability question with one is checked before the model is asked · **Added 2026-09-27**

**The failure:** "Is the resort available tomorrow?", "Available ba kayo
bukas?", "sa makalawa", "sa Friday", "sa susunod na linggo": 6 questions out
of 6 got "Which date do you mean?" with no tool call. The tools block already
stated `Today is 2026-09-27 (Sunday), Asia/Manila.` The model knew today; it
didn't count from it. Its rule "If the user asks about availability without
giving a date, … ask which date" won.

**Decision:**
- `packages/rag/src/dates.ts` is pure: a `(message, today)` in, and no clock.
  It resolves English, Tagalog and Taglish relative dates against the
  TENANT'S today (`localDate(timezone)`; villa's is Asia/Manila).
- On an **availability turn** (availability or booking words, or a bare date
  after an earlier availability question), `answer.ts` runs
  `check_availability` itself with each unambiguous resolved date, through
  `executeTool()`, before the model's first turn. One line per date goes after
  "Today is …" ("bukas" means 2026-09-28 (Monday); check_availability was
  already called; answer from its result and name the date).
- Every other turn gets nothing, and its prompt is byte-identical to
  before.

**Why code, measured step by step:**
1. The prompt line alone ("bukas" means 2026-09-28, use it) fixed 5 of 6.
2. The exact tool arguments in the line fixed the range case in Tagalog. But
   "Available ba kayo next week?" still asked, 3 runs of 3, and "sa Friday"
   asked once. The model follows a prompt line most of the time, and this has
   to happen every time.
3. The up-front check makes it every time.

**Why only availability turns (trap 10):** with even the bare fact line
("bukas" means 2026-09-28), "What time is check-in bukas?" made the model
check availability and open with "Yes po". The unchanged code answered it
from the documents with no call (compared on a stash of the change).

**The rules, pinned in `dates.test.ts`:**
- Weeks run Monday to Sunday.
- "Friday" and "this Friday" mean the coming one, today included.
- "next Friday" is AMBIGUOUS while this week's Friday is still ahead, so both
  dates are given and the model asks. It is not checked. Once this week's has
  passed, both readings agree.
- "next week" is next Monday to Sunday. "this weekend" is Saturday to Sunday,
  from today.
- Tagalog: "bukas" also means "open" (not a date before ba, pa, ang, kayo…,
  or next to another date). "linggo" also means "week" (the week phrases are
  matched first). "may" also means "there is" (the month only as "5 May" or
  "May 5, 2027").
- Past dates are still checked, so the tool can say they're past, and the
  line says so too. Once, in Taglish, the model answered the refusal instead
  of passing the tool's error on.

**Measured:**
- tests: 98 in `dates.test.ts` and 13 in `tools.test.ts` (the resolved date is
  what `checkAvailability()` receives; failures are handled), 214 in the
  pipeline;
- battery 36/38, `original 9/10 · tool 9/9 · lang 9/10 · date 9/9`. The new
  date cases check the date the tool RECEIVED, computed in the battery
  independently of `dates.ts`;
- `lang-tagalog-2` failed once and passed 3/3 on repeat. `lang-followup`,
  whose bare "11 October" is now checked up front, still fails only on the
  language mix;
- the northwind snapshot is identical.

**Amended 2026-09-27 (with D-047):** D-046 also narrowed the tools block's
ask-for-date rule to "without giving any date or day at all". That did not
fix the relative-date case (the up-front check did), and `lang-tagalog-2`, a
pet question with no date in it, failed 4 of 9 runs with it. The rule is back
to its measured wording, and `lang-tagalog-2` failed 1 of 6 on repeat. The date
cases still pass 9/9 without it.

**Reverse if:** a model reliably calls the tool for relative dates by itself.
Or if tenants need dates this doesn't cover (Christmas, "end of the month",
day-only "the 12th"). Extend the rules, not the prompt.

---

## D-047 · "I don't know based on the documents I have." stays the internal marker; visitors see the tenant's own words · **Added 2026-09-27**

**The problem:** the refusal reads like a system message ("the documents I
have"), not a person.

**Decision:**
- `NO_ANSWER` is unchanged everywhere upstream. The grounding prompt still
  makes the model write it verbatim, D-008 and D-035 still produce it,
  `messages` still stores it, and the unanswered list still finds refusals by
  it (D-045).
- `packages/rag/src/refusal.ts` swaps it at the last moment, where a reply
  leaves the server: the JSON answer, the stream, and `getMessages()`.
- The words shown are `tenants.fallback_message` (nullable, 1–500 chars, set
  with `tenant:fallback`, and served through `tenant_public()`, since every
  visitor sees it). When a tenant hasn't set one, a built-in friendly default
  in the reply's language (English, Taglish or Tagalog) is used.

**Why not just reword the constant (option 1):** one sentence can't be right
for every business, and each tenant has its own contact channel. It would
also have changed the text the grounding prompt was measured with (Phase
5.5).

**The streaming detail:** with chunks, the model's text streams as it's
written, so a refusal would show up word by word before anything could
replace it. `refusalFilter()` holds deltas back only while the text so far is
still a prefix of the marker. It passes them the moment the text diverges,
and sends the friendly text at the end if the whole reply was the marker.

**Callers:**
- `Answer.refused` tells callers it was a refusal, now that the words vary
  by tenant.
- The eval and isolation checks use it.
- The battery's pure-refusal cases also assert that the visitor's reply is
  not the marker.

**Measured:**
- tests: 19 in `refusal.test.ts` (the filter over delta sizes 1–100, answers
  that start like the marker, and the marker followed by more text), 233 in
  the pipeline;
- live: a Taglish refusal got the Taglish default, then villa's own message
  once set; an English one got the English default; northwind's short
  circuit got the default. JSON and stream matched;
- battery 36/38 (`original 9/10 · tool 9/9 · lang 9/10 · date 9/9`);
- verify 48/48 (check 42 now lists `fallback_message`), isolation 16/16 both
  ways, the northwind snapshot identical.

**Limits:**
- A tenant's own message is one string for every language. Only the default
  follows the reply language. **Superseded by D-048.**
- A reloaded transcript shows the English default, because there is no reply
  language at hand.
- A partial answer that ends with the marker is shown as written.

**Reverse if:** tenants need a message per language (make the column jsonb
keyed by language), or the refusal needs to carry a link or button, which
would be a UI change, not text.

---

## D-048 · A tenant's fallback message is per reply language · **Added 2026-09-27**

**The problem:** D-047's `fallback_message` was one string, so villa's
Taglish sentence answered English questions too. Meanwhile northwind, with no
message of its own, got a default that followed the language.

**Decision:**
- `tenants.fallback_messages` is jsonb, `{english, taglish, tagalog}`, and any
  key may be missing.
- `refusalText(tenant, language)` returns the tenant's text for the reply's
  language, else the built-in default in that language. It never uses another
  language's custom text, because that is the bug being fixed.
- The reply language is the one D-043 already decides in code. No model call
  and no translation happen at reply time.

**How the shape is held:**
- In Postgres: the `tenants_fallback_messages_shape` check allows only the
  three keys, each a string of 1–500 characters.
- In the loader: `fallbackMessagesOf()` keeps only known string keys, so a
  bad row loses its wording and can't show anything odd.

**Migration:** `schema-auth.sql` copies the old single string into all three
keys, so nothing visible changed on the day, then drops the old column.
`tenant_public()` is dropped and recreated for the new return type.

**Unanswered questions are unaffected:** they match the stored marker
`NO_ANSWER` (`unanswered.ts:51`), and the friendly text is never saved.

**Measured:**
- tests: 234 in the pipeline, including "a language the tenant did not write
  gets the default in that language";
- live on villa: English → its English line, Taglish → its Taglish line,
  "Tagalog lang po…" → its Tagalog line. Northwind got the default. The
  stream equalled the JSON reply each time;
- verify 48/48 (check 42 lists `fallback_messages`), isolation 16/16 both
  ways.

**Reverse if:** a tenant's visitors write a fourth language. Add the key to
`LanguagePreference`, the check constraint and the loader together.

---

## D-049 · Small talk is answered in code before retrieval; only a WHOLE message of it is claimed · **Added 2026-09-27**

**The failure:** "Salamat po" and "okay" got the refusal ("Sorry po, wala pa
kaming info…"). Small talk has nothing to look up, so retrieval can only
fail on it. Only English greetings were handled (`greeting.ts`, plan.md
Phase 4).

**Decision:**
- `greeting.ts` now classifies four kinds: greeting, thanks,
  acknowledgment, farewell. It covers English and Tagalog: "Hi po",
  "Kamusta", "Magandang umaga", "Salamat po", "Sige", "Ingat po".
- It uses the same rule as before: every word must belong to a small-talk
  phrase or a filler ("po", "naman", "there"…). One other word, and the
  message goes to the pipeline unchanged. That keeps "Hi, what time is
  check-in?" a question. Mixed small talk resolves to the most final kind, so
  "Thank you, bye" is a farewell that also answers the thanks.
- Replies are short and in the conversation's language (D-043's rules, a
  pinned request included). The small talk's own Tagalog decides a first turn.
  The greeting still names the assistant and business, but no longer talks
  about "documents" or "passages", which is D-047's voice change.

**Two guards:**
- "yes", "oo", "opo" and "sure" are NOT acknowledgments. They answer the
  bot, and a canned "let me know if you need anything else" would drop a
  booking.
- "okay" / "sige" is claimed only when the bot's last message was not a
  question. After a question it is an answer, and goes to the pipeline with
  its history. This costs one tenant-filtered read of the conversation, and
  only for a message that is already small talk.

**Mixed messages (spec § 5):** these already worked, because a partial match
never claims the message, so the real question was answered. The one gap:
"Thanks! Is the resort available tomorrow?" ignored the thanks.
`thanksPrefix()` now puts "You're welcome! " / "Walang anuman po! " in front
of the answer. It is display only and never saved, so a refusal stays the
exact `NO_ANSWER` the unanswered list matches.

**Measured:**
- tests: `greeting.test.ts` 101 (up from 41), 294 in the pipeline;
- live on villa:
  - "Hi" → "Hi! 👋 I'm Lia, the assistant for Villa Amihan Private Resort.
    How can I help you today?";
  - "Hi po" and "Kamusta po?" → the Taglish greeting;
  - "Salamat po" → "Walang anuman po! 😊…";
  - "okay" → "Great! 😊…";
  - "Salamat, bye" → "Walang anuman po! Ingat po kayo! 😊";
  - all with 0 sources and 0 tool calls;
  - the three mixed examples were answered, and the thanks acknowledged
    (JSON and stream);
- battery 36/38 (`original 9/10 · tool 9/9 · lang 9/10 · date 9/9`), the
  `persona` greeting case through the new path; isolation 16/16 both ways.

**Limits:**
- "sige" in reply to "Which date?" goes to the pipeline and gets the
  refusal, as before this change. It isn't a date.
- The phrase lists are English and Tagalog only.

**Reverse if:** small talk needs context the lists can't express. Then let
the model answer it, with no chunks and no D-035 refusal. That is a prompt
change, measured on the full battery.

---

## Open questions

| # | Question | Resolve by |
|---|---|---|
| **Q-1** | What `min_similarity` actually works on real documents? | Phase 3.2 — log scores and tune |
| **Q-2** | Is 1000/150 the right chunk size for the documents you will actually use? | Phase 5.1–5.2 — the experiment is the answer |
| **Q-3** | Is `gpt-4o-mini` still the right cheap model at build time? | Phase 0 — check the model list |
| **Q-4** | Does `match_count: 5` overflow the context window on long chunks? | Phase 3 — 5 × 1000 chars ≈ 1,250 tokens, comfortably fine. Revisit only if chunk size grows |
| **Q-5** | Keep the `scratch/` test scripts from Phase 1 or delete them? | Phase 4 — they are useful for debugging; a `scratch/` folder in `.gitignore` is a reasonable compromise |

---

## D-050 · A tenant's booking type lives in its bookings config; absent means `whole_resort` · **Added 2026-09-27 (booking-types Phase 1)**

**Decision:** `tenant_applications.config.booking_type` is `whole_resort` or
`per_room`. The key being ABSENT means `whole_resort`, so villa's row, and
every tenant that never chose, needed no migration. Read in one place per
language: `booking_type_of()` in SQL, `parseConfig()` in TypeScript, with the
same defaults (weekend Fri–Sun, currency PHP). The existing validate trigger
refuses an unknown type, bad weekend days and a bad currency.

**Why not a `tenants` column:** a type means nothing without the bookings
application; Northwind would carry a meaningless value.

**Measured:** verify 54 (`per_bed` 23514, `per_room` accepted); the CLI stores
whole_resort by removing the key (Phase 5).

**Reverse if:** a third model appears that is not a bookings application.

---

## D-051 · Rooms are `units` rows with new nullable columns, not a `rooms` table · **Added 2026-09-27 (booking-types Phase 1)**

**Decision:** `units` gained `description`, `capacity`, `active`, `sort_order`.
A room is never deleted by a token, only retired (`active = false`), so the
bookings that name it keep it. A whole-resort tenant has exactly one active
unit, enforced by a deferred constraint trigger.

**Why:** plan/bookings.md § 7 left this seam. `bookings_no_overlap` already
compares `unit_id`, so availability per room needed no new rule, and the
composite FK already stops a booking naming another tenant's room.

**Measured:** two rooms on one night both land; the same room twice is 23P01
(verify 56–57, rooms.mjs 4–5).

---

## D-052 · The price is computed in SQL by the insert trigger, stored on the booking, in centavos, and only for `per_room` · **Added 2026-09-27 (booking-types Phase 1)**

**Decision:** `unit_price(tenant, unit, slot, date)` is the one place a price
is computed: `unit_rates` weekday or weekend by the tenant's weekend days.
`bookings_compute_during()` sets `bookings.price` from it and OVERWRITES
whatever an insert or update sent; a booking re-saved without moving keeps
its old price. `whole_resort` stores `null`: its prices live in its
documents, by the user's decision (plan/booking-types.md § 8 q3). The staff
quote calls the same function, so a preview cannot differ from what is stored.
Prices are bigint centavos; the browser turns typed pesos into centavos by
splitting the string, never by `× 100`.

**Measured:** a forged `price: 1` stored as 350000 + 600000, equal to the quote
(walk 5); a rate edit left a stored 350000 while the new quote said 999900
(verify 61, rooms.mjs 7).

**Reverse if:** a pricing rule the trigger cannot express (holidays, per-head
charges) is wanted: that is a `rate_overrides` table, R-24.

---

## D-053 · Several rooms are one array insert sharing a `group_id` · **Added 2026-09-27 (booking-types Phase 2)**

**Decision:** `createBookings()` inserts every room of a booking in one
PostgREST call, which is one statement. If any row hits
`bookings_no_overlap`, none is saved. Guest count is per room, because the
trigger checks each row against its own room's capacity (the plan said
`unitIds[]`; it is `rooms: [{ unitId, guestCount? }]`).

**Why no SQL function:** atomicity comes from the statement already.

**Measured:** a group clashing on one room left 0 rows (verify 57, rooms.mjs 5,
isolation 17). **Trap:** in a multi-row insert PostgREST sends a key one row
lacks as NULL, not the default, so every row carries every key (Phase 1,
23502 on `units.active`).

---

## D-054 · A separate `check_room_availability`, security definer: a third definer function · **Added 2026-09-27 (booking-types Phases 1, 6). Amends D-042**

**Decision:** per_room availability is its own function, returning
`(date, unit, capacity, slot, status, price)` for active, priced rooms, with
optional slot, room and guest filters, and nothing for a whole-resort tenant.
`check_availability` keeps its four columns (and now skips inactive units),
so villa's tool result and prompt are byte-identical.

**Why definer, against D-042's "try a policy first":** it must see `bookings`
to say open or taken, and a chat token reads no booking at all (auth-rls
§ 2.5). That is exactly why `check_availability` is definer. It has the same
five properties: definer, `search_path = ''`, its own token-tenant check, a
range cap, and no guest data.

**Measured:** verify 62, 68 (another tenant's id: 42501); battery rooms 10/10
three times; villa's tools and prompt diff clean against Phase 0.

---

## D-055 · Switching booking type is an operator CLI, and the database refuses it while bookings are live · **Added 2026-09-27 (booking-types Phases 1, 5)**

**Decision:** `pnpm --filter @rag/db tenant:booking-type -- <slug> [type]`.
Not a staff screen. The validate trigger refuses a switch while any booking
has not ended, and a switch to whole_resort with more than one active unit;
the CLI prints that refusal as it is, so the rule exists once.

**Why:** a live whole-property booking does not overlap a room booking, so a
switch could sell the property twice (plan § 2.4).

**Measured:** Phase 5, 6/6: "3 active units", "1 live booking(s)", then back
and forth once cancelled.

---

## D-056 · Room photos: a public bucket, uploaded through our route on the staff token, checked by bytes, resized in the browser · **Added 2026-09-27 (booking-types Phases 1–4)**

**Decision:**
- bucket `unit-images`, public for reads, 2 MiB, jpeg/png/webp; objects at
  `<tenant_id>/<unit_id>/<uuid>.<ext>`, the path built by `@rag/bookings`
  from the server's tenant (wall 1) and checked by Storage policies (wall 2);
- the browser POSTs to our route; it never holds a token, and service_role
  is never used; the route checks the declared length before reading the
  body, the package checks the size and the magic bytes, the bucket checks
  both again, a trigger caps 6 per room;
- the browser redraws each photo on a canvas and re-encodes it as WebP,
  which drops EXIF and GPS; upload, then row, then remove the object if the
  row failed; delete row, then object, checking the COUNT removed.

**Why:** Free plan Storage has no transformations; phone photos carry GPS;
a refused Storage delete returns no error and removes 0 (Phase 1 spike).

**Measured:** spike 9/9 (our ES256 tokens accepted; cross-tenant 403, SVG 415,
2 MiB + 1 413); the first real upload a WebP with no EXIF or GPS.
**Still provisional:** MAX_IMAGE_BYTES and MAX_IMAGE_EDGE await a full-size
phone photo (Phase 4 walk).

---

## D-065 · `capacity` stays the maximum; `standard_capacity` and `extra_person_rate` are new, per room · **Added 2026-09-28 (extra-guests Phase 1)**

**Decision:** the request's `maxCapacity` is the existing `units.capacity`,
which the insert trigger already refused above (23514); the API accepts
`maxCapacity` as its name. `standard_capacity` (guests the rate covers) and
`extra_person_rate` (centavos per guest above it, per booking) are new, and
null means "no fee", so no existing room changed price when the columns
arrived. A standard above the maximum is refused by a check. New rooms get
the request's numbers as DEFAULTS in `createAccommodation`: standard 2,
maximum 4, ₱250.

**Why defaults and not one rule:** the request calls them "configurable room
properties", and harbor's Family Room takes 6 (the user kept every maximum,
extra-guests § 7 q1).

**Measured:** verify 70; rooms.mjs 15 (a room created with only a name: 2 / 4
/ 25000).

---

## D-066 · `unit_quote()` is the only price arithmetic; the trigger, the staff quote and the chatbot's tool all call it · **Added 2026-09-28 (extra-guests Phases 1–4)**

**Decision:** `unit_quote(tenant, unit, slot, date, guests)` returns base,
extra guests, extra charge and total. The insert trigger stores its three
amounts, overwriting anything sent; `quote()` returns its lines;
`check_room_availability` returns its total for the party asked about, and
the tool hands that total to the model as text. The instructions say to
quote it and never add one up.

**Why:** the request's § 5 ("the chatbot and the booking management system
use the same pricing rules"), met by construction rather than by two copies
kept in step.

**Measured:** 1–4 guests 350000 / 350000 / 375000 / 400000 in verify, in
rooms.mjs and over HTTP; the chatbot's "₱4,800.00 + ₱250.00 for 1 extra
guest = ₱5,050.00" equals unit_quote() for the Loft with 3 (`rt-extra`).

---

## D-067 · One booking is one slot on one date, so the fee is per booking (per night for a Night slot) · **Added 2026-09-28 (extra-guests § 7 q3)**

**Decision:** the request's "× the number of nights" is the number of
bookings: a three-night stay is three bookings, each charged its own fee,
which gives the same total. A multi-night booking as one row is out of scope.

**Reverse if:** a stay is booked as one row. Then `during` spans several
nights, and the fee must multiply by them.

---

## D-068 · The breakdown is stored on the booking, and a guest-count change reprices it · **Added 2026-09-28 (extra-guests Phase 1)**

**Decision:** `bookings.base_price` and `extra_guest_price` sit beside
`price` (the total). A per_room booking must have a guest count (the user's
answer to § 7 q2). A re-save keeps the old breakdown only if the booking did
not move AND its guest count is unchanged, so 2 → 4 guests reprices.

**Why:** the screens show what was charged even after a rate or fee edit,
and the price can never lag behind the party size.

**Measured:** verify 72–73 (3 guests stored as 350000 + 25000, a forged
breakdown ignored; 2 → 4 guests repriced to 410000 at an edited rate, the
same count kept 350000).

**Order that matters:** the guest count is NOT pre-checked in TypeScript. The
trigger checks the unit first, so another tenant's room still says "No such
unit or slot." even with no guest count; a pre-check would have answered it
with the guest-count message and told the two apart.


## D-069 · Customers book on a page, not in the chat; the chat only explains how · **Added 2026-09-28 (customer-booking Phases 4–5, the user's decision)**

**Decision:** every tenant with the bookings application and a priced unit
gets a public page, `/t/<slug>/book`, where a customer picks a date, sees
the database's price and sends a request. The chat gets a **Book** button
(UI, not a model reply) and its "how to book" documents point at the page.
No tool was added and no prompt text changed. `plan/payments.md`, which had
the model quote and a button book from inside the chat, is on hold.

**Why:** the user chose it for the MVP: booking and payment are a page's
job; the chat's is to answer. It keeps D-037 exactly as it was (tools stay
read-only) and needs no prompt edit, which rule 1 says is where a helpful
change costs a refusal.

**Measured:** Northwind's, villa's and harbor's prompts and both tool
definitions byte-identical to before the plan; battery 53/56 on the full run
with every existing group at its 49/51 (`book-*` 4/5, then 5/5 once the
Tagalog case judged only the booking part). "Please book … for me" checked
availability, said it cannot book, and pointed at the Book button, on villa
and on harbor.

---

## D-070 · A request holds nothing; only `confirmed` is in `bookings_no_overlap` · **Added 2026-09-28 (customer-booking Phase 1, § 8 q1)**

**Decision:** the constraint's predicate is `status = 'confirmed'` (it was
`<> 'cancelled'`). A web request is `pending` and blocks no date.
`check_availability` and `check_room_availability` count confirmed rows
only. Two customers may request the same night; the one staff confirm
first gets it, and confirming the second is 23P01 → 409, the whole group
refused in one statement.

**Why:** villa's own policy ("a date is only held once the reservation fee is
paid"), and because a holding request would be a free, anonymous way to block
every date with fake names. A hold needs expiry and a verified contact, both
of which are payments.md's.

**Measured:** no `pending` row existed when the constraint was re-created
(villa 3 confirmed + 2 cancelled, harbor 3 confirmed), so nothing changed;
verify 83 (availability open with a request on the night, a staff booking
lands, the confirm is 23P01 and both nights stay pending); rooms 25–26; the
HTTP walk's 409; the user's walk on harbor.

---

## D-071 · `request_booking()`, the one public write, a fourth `security definer` function · **Added 2026-09-28 (customer-booking Phase 1). Amends D-042 and D-054**

**Decision:** a chat token has no insert policy on `bookings`. The only way
a stranger's input becomes a row is `request_booking(p_tenant_id, …)`:
definer, `search_path = ''`, `p_tenant_id` must equal `app_tenant_id()`
(service_role excepted, for the tools), and it inserts `pending`, `web`
rows only. The caller chooses the slot, units, guests, date, nights and
contact details; never the status, price, group or reference. It validates
everything the page validates, and holds the four limits (14 nights, 365
days, 3 open requests per contact, 70 rows) under a per-tenant advisory
lock. Its errors are mapped once, in `@rag/bookings`.

**Why:** the same reason as D-042: one function whose column list and
checks are the boundary, rather than a policy that would let a chat token
insert whatever shape it likes.

**Measured:** verify 81 (a chat token's direct insert 42501, anon cannot
call it), 82 (a 2-night request is 2 pending rows, one group, priced per
night), 85 (another tenant's id 42501, villa's unit 23503, nothing saved),
86–89 (14 yes, 15 no; format; the 4th open request 54000; an unpriced slot
refused). Bookings isolation 27–28 both ways.

---

## D-072 · Holidays are a per-tenant calendar of dates with a surcharge, read by `unit_price()` · **Added 2026-09-28 (customer-booking Phases 1–2, § 8 q2). Reverses booking-types § 8 q2; closes R-24**

**Decision:** `rate_calendar (tenant_id, day, kind, label, surcharge)`. On a
listed day a rate's `holiday_price` applies, or its `weekend_price` when
that is null (villa's rule: "weekends and holidays"), plus the day's
surcharge once per night per unit, stored as `bookings.surcharge` beside
the rest of the breakdown. A calendar change never reprices a stored row.
Staff type the dates (Holy Week moves; special days are proclaimed) and can
copy ticked fixed dates to another year.

**Why:** a page that shows a price has to show the right one on 24 Dec, and
a holiday cannot be computed. `unit_quote()` stays the only arithmetic:
holidays enter through `unit_price()`, which it already called.

**Measured:** verify 79 (villa's 24 Dec, 32 guests: 2000000 + 50000 +
400000 = 2450000; a holiday_price wins: 2950000), 80 (stored, forged values
ignored); rooms 22–23; the user's walk stored 24 Dec as 2000000 + 0 +
400000 with "Christmas Eve" typed on S-7; isolation 24–25 (one date, two
tenants, two prices).

---

## D-073 · A stay is N rows of a nightly slot in one group, each priced for its own date; `whole_resort` is priced once its unit has rates · **Added 2026-09-28 (customer-booking Phases 1–2, § 8 q3). Reverses booking-types § 8 q3**

**Decision:** `slots.nightly` marks the slot a stay is made of (villa's
Overnight, harbor's Night). "3 days 2 nights" is two rows on consecutive
dates, one `group_id`, one reference, inserted in ONE statement so a clash
on any night saves none. The total is the sum of the stored rows, never a
recomputation; no multi-night discount, no minimum stay. Villa's unit got
its rates (Day Tour 9,500/12,000; Overnight 16,000/20,000; 22-Hour
22,000/27,000), 30 guests included, 45 at most, ₱250 each above; the trigger
prices a whole_resort booking when a rate exists and leaves `null` when
none does, so every older villa booking keeps `price null`.

**Why:** the existing exclusion constraint already refuses a clash per
night, so a stay needs no new availability model; and the page shows villa
a price only if the database has one.

**Measured:** verify 78 (unpriced until a rate, an older booking stays
null), 82 (Thursday 1650000 + Friday 2050000, check-out 12:00 on day
three); rooms 21, 24; the HTTP walk 625000 + 775000; villa's 5 older
bookings still unpriced. The 12:00–14:00 gap inside a stay is unsellable
today because no slot fits in it (R-40).

## D-074 · Villa's prices come from the database, through the tool; the figures left its documents · **Added 2026-09-28 (villa-prices). Closes R-41 and R-17; amends D-054 (the gate is the rate, not the type)**

**Decision:** `check_room_availability` returns rows for any tenant whose
active units have a rate for a slot, not only `per_room` ones, so villa's one
unit is priced per slot and date from `unit_quote()` like a room. Villa's
`check_availability` tool carries `price`, `included_guests`,
`extra_guest_fee` and, with a `guests` argument, `extra_guest_charge` and
`total`, as text, and its tools block gets the three price lines harbor's
has (quote only from the tool, never add up a total, ask for a date when a
price is asked without one). The six slot rates, "30 guests / ₱250" and
the ₱4,000 December surcharge left `02-rates-and-schedules.md`,
`05-house-rules.md` and `08-faq.md`; the rules stayed. Villa's calendar
got its fixed dates and Holy Week 2027. A whole-resort tenant with no rate
gets the tool exactly as before. "How much", "magkano", "price", "rate",
"cost" and "presyo" now make a dated question an availability turn, and a
stated party size ("for 3 guests", "32 kami") rides on that up-front call.

**Why:** the user asked for one source of truth. With the page pricing from
`unit_rates` and the chat from prose, a rate edit on one side silently
changed what a guest was told on the other (R-41), and R-17 had deferred a
price tool since bookings. A figure that the database holds and a document
repeats is a drift waiting to happen; a rule in prose is not.

**Measured (`plan/baseline/*villa-prices*`):** verify 92/92; rooms 30/30;
both isolation suites both ways (pipeline's villa check now asserts the
rows are priced from villa's OWN rates, none of harbor's); Northwind's and
harbor's prompts and harbor's tool definitions byte-identical; villa's
differ by design, the new baseline `villa-tools-post-villa-prices.txt`.
Battery **59/61**: `price 3/3` (the Overnight on a date quoted as the
tool's ₱16,000.00; 32 guests on a Day Tour as the tool's ₱10,000.00 with
its ₱500.00 extra charge; "sa Sabado" resolved in code and quoted at
₱20,000.00), every other group at its baseline.

**What the first run taught (51/61):** the price words made "How much is
the Loft for 3 guests on …" an up-front check run WITHOUT the guests, so
the model got rows with no total and added one up itself (rt-extra,
price-villa-guests: R-37 exactly). The guest count now rides on the call.
And five `lang-*` cases had asked villa's RATES as their fact; with the
figures gone they asked for a date or refused, so they now ask facts that
are still in the documents (the deposit, the extension, the cook). One
cost is recorded, not hidden: `lang-tool`'s opening sentence went from
"Yes po, the Overnight slot is open pa sa …" to "Yes po, may bakante pa sa
…", 3 runs of 3, and the case now judges Tagalog-present rather than the
two-of-each band.
