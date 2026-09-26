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

## D-037 · Chatbot tools are read-only, results carry no PII, and every call is shown · **Added 2026-09-24 (bookings Phases 1, 6, 7)**

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

## D-042 · `security definer` for exactly two functions, `tenant_public` and `check_availability`, both with `search_path = ''` · **Added 2026-09-26 (auth-rls Phase 1)**

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

---

## Open questions

| # | Question | Resolve by |
|---|---|---|
| **Q-1** | What `min_similarity` actually works on real documents? | Phase 3.2 — log scores and tune |
| **Q-2** | Is 1000/150 the right chunk size for the documents you will actually use? | Phase 5.1–5.2 — the experiment is the answer |
| **Q-3** | Is `gpt-4o-mini` still the right cheap model at build time? | Phase 0 — check the model list |
| **Q-4** | Does `match_count: 5` overflow the context window on long chunks? | Phase 3 — 5 × 1000 chars ≈ 1,250 tokens, comfortably fine. Revisit only if chunk size grows |
| **Q-5** | Keep the `scratch/` test scripts from Phase 1 or delete them? | Phase 4 — they are useful for debugging; a `scratch/` folder in `.gitignore` is a reasonable compromise |
