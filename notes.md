# notes.md — Phase 5 findings

> Every number here was measured on this build against the Northwind Labs
> handbook (2,607 characters of invented facts). Each configuration ran in a
> fresh Node process via `scratch/experiment.js`, so the edited constants were
> genuinely re-read. `src/chunker.js` and `src/rag.js` were backed up first and
> verified byte-identical after restoration.
>
> Date: 2026-09-20

**The four questions used throughout:**

| Tag | Question | Why |
|---|---|---|
| `direct` | What temperature does the Bay 3 freezer run at? | A single fact in one sentence |
| `two-part` | What are the hours of the Quiet Hour **and why does it exist**? | Needs two facts from different sentences |
| `absent` | What is the policy on laboratory safety goggles? | Same domain, fact **not** in the document |
| `offtopic` | What is the capital of France? | Nothing to do with the corpus |

---

## The headline

**I expected the threshold to be what stops hallucination. It isn't.**

The two guards do completely different jobs, and the experiments separated them
cleanly:

| Guard | What it actually protects |
|---|---|
| `MIN_SIMILARITY` (the threshold) | **Cost and latency.** Removing it did not produce a single wrong answer |
| The "use ONLY the context" line | **Correctness.** Removing it produced confident, fluent nonsense immediately |

Getting that backwards would mean tuning the wrong knob when the bot starts
making things up.

---

## 5.1 — `CHUNK_SIZE` 1000 → 300

**Result: it got *better*, not worse. That surprised me.**

| | 1000 (baseline) | 300 |
|---|---|---|
| Chunks from the document | 3 | **17** |
| `direct` top score | 0.462 | **0.726** |
| `two-part` top score | 0.555 | **0.664** |
| Input tokens for 3 answers | 2,026 | **1,198** |
| Answers correct | yes | yes |

Smaller chunks scored dramatically higher **and** cost 40% less.

**Why the scores went up.** A chunk's embedding is one vector standing for the
whole chunk. A 300-character chunk that is *only* about the Bay 3 freezer points
almost exactly where a freezer question points. The 1000-character chunk
containing the same sentence also contains sample retention rules and visitor
badges, so its vector is pulled toward the average of all three — and matches
the freezer question less well.

**Why the cost went down.** `MATCH_COUNT` is 5 chunks either way, but 5 × 300
characters is far less text than 3 × 1000.

**The warning the roadmap gave is real, it just did not bite here** — see 5.4,
where a 300-character chunk turned out to be too small to hold a complete
answer, and the model filled the gap by inventing one.

**One side effect worth noticing:** `CHUNK_OVERLAP` stayed at 150 while the size
dropped to 300, so overlap went from 15% of a chunk to **50%**. Half the corpus
is now stored and embedded twice. Changing one knob silently changed the meaning
of another.

---

## 5.2 — `CHUNK_SIZE` → 4000

**The whole document became one chunk**, and the ranking stopped meaning
anything.

| Question | Score at 4000 |
|---|---|
| `direct` (answer IS in the document) | 0.365 |
| `absent` (answer is NOT in the document) | **0.424** |

**The question the corpus cannot answer outranked the question it can.**

That is the dilution effect in one line. With everything in one vector, the
score no longer measures "does this chunk contain the answer" — it measures
"is this question vaguely about laboratories". Retrieval has stopped doing its
job while continuing to return confident-looking numbers.

The answers were still correct, because the single chunk happened to contain
everything. On a real corpus, where that chunk would be one of thousands, an
inverted ranking means retrieving the wrong document entirely.

---

## 5.3 — `MIN_SIMILARITY` → 0

**Expected:** nonsense retrieved and answered with a straight face.
**Observed:** nonsense retrieved, and then *refused anyway*.

```
Q: What is the capital of France?
   chunks: 3   scores: 0.042  0.006  0.006
   671 input tokens spent
   A: I don't know based on the documents I have.
```

Three lab-handbook chunks were pasted into the prompt as "context" for a
question about France, at similarity scores near zero. The model read them,
found nothing about France, and followed its instruction to refuse.

**So what does the threshold actually buy?**

- **671 wasted tokens and a round trip**, on every question the corpus cannot
  answer.
- Latency: ~1 second of nothing.
- Removal of any chance the model ignores its instruction — a real risk, just
  not the one I assumed.

The threshold is a **cost gate**, not a correctness gate. That reframes D-008
for me: the docs call the short circuit "belt and braces", and the braces turn
out to be doing most of the work.

---

## 5.4 — `MATCH_COUNT` 1 vs 20

Run against the 17-chunk corpus from 5.1, so that 20 is meaningful.

| | 1 | 5 (baseline) | 20 |
|---|---|---|---|
| Chunks for `direct` | 1 | 5 | **14** |
| Input tokens, `direct` | **140** | ~420 | **1,003** |
| Total input, 3 answers | **424** | 1,198 | 2,257 |
| `two-part` answered correctly | **NO** | yes | yes |

**7× the tokens between 1 and 20, for answers that were no better.** The extra
chunks at 0.256–0.29 contributed nothing; they are just text the model reads and
discards, billed in full.

### The most important result in Phase 5

At `MATCH_COUNT = 1`, the two-part question broke:

```
Q: What are the hours of the Quiet Hour and why does it exist?

A: The Quiet Hour is observed daily between 13:40 and 14:40 local time.
   It exists because the building requires a period of reduced noise
   and activity.
```

**The first sentence is correct. The second is invented.** The real reason is
the Kessler Seismograph Annex sharing a foundation, and vibration corrupting
its calibration readings. "The building requires a period of reduced noise and
activity" is a plausible, professional-sounding sentence that appears nowhere in
the source and means nothing.

What happened: the single retrieved 300-character chunk contained the *hours*
but not the *reason*. Rather than say so, the model completed the pattern.

**This is the failure mode the whole project is about**, and three things about
it are worth keeping:

1. **The grounding instruction was present and did not prevent it.** "Use ONLY
   the context" stops the model answering a question with *nothing* relevant
   retrieved. It is much weaker when *some* of the answer is present — the
   model treats the gap as something to fill in.
2. **Nothing errored.** Same 200, same confident tone, similar length.
3. **The sources panel is what catches it.** One click shows the chunk, and the
   reason plainly is not in it. Without visible sources this is undetectable
   short of knowing the source document by heart. That is D-012 earning its
   place as a feature rather than a debug flag.

---

## 5.5 — Removing the grounding instruction

Deleted these lines from `buildPrompt()`, leaving only "Here is some context.":

```
'You answer questions using ONLY the context below.',
'If the context does not contain the answer, reply exactly:',
`"${NO_ANSWER}"`,
'Do not use outside knowledge. Do not guess.',
```

**With the threshold still at 0.25:**

```
Q: What is the policy on laboratory safety goggles?
A: The provided context does not include specific information about the
   policy on laboratory safety goggles. You may need to refer to a different
   section of the internal operations handbook or safety guidelines...
```

Already degraded — it has stopped refusing and started giving advice about where
to look. Harmless here, but it is no longer answering *from the documents*.

**With the threshold ALSO at 0** — both guards off, which is what a naive
implementation looks like:

```
Q: What is the capital of France?
   scores: 0.042  0.006  0.006
A: The capital of France is Paris.

Q: How do I bake sourdough bread?
   scores: 0.076  0.067  0.062
A: Baking sourdough bread involves a few key steps... [a complete 400-word
   recipe: ingredients, autolyse, bulk fermentation, shaping, proofing,
   baking at 450°F in a Dutch oven]
```

**A lab-handbook chatbot cheerfully produced a sourdough recipe** while
reporting three chunks of a laboratory operations handbook as its sources.

That juxtaposition is the whole lesson. The retrieval numbers were right there —
0.076 — and they were screaming that nothing matched. The system had all the
information needed to refuse and refused nothing, because **the instruction to
refuse was the only thing that had ever been doing that work.**

Both lines were restored immediately afterwards and verified.

---

## 5.6 — What it actually cost

The authoritative figure is on OpenAI's usage dashboard. From the token counts
logged by `chat()` across every experiment above, plus the Phase 2–4 testing:

| | Approximate |
|---|---|
| Chat input tokens | ~26,000 |
| Chat output tokens | ~2,000 |
| Embedding tokens (≈9 re-ingests + ~60 questions) | ~6,000 |
| **Total** | **well under $0.01** |

At `gpt-4o-mini` rates (~$0.15/1M in, $0.60/1M out) and
`text-embedding-3-small` (~$0.02/1M), the entire build — all five phases,
every experiment, every mistake — cost **less than one cent**. `costs.md`
estimated "well under $1 of the $5 minimum" and was, if anything, pessimistic.

**The cost intuition worth keeping:** output tokens are 4× input, but input
dominates completely here, because every single question re-uploads ~670 tokens
of retrieved context. `MATCH_COUNT` and `CHUNK_SIZE` are therefore the two real
cost levers in a RAG system — not the model, and not the question.

---

## Two findings from earlier phases that belong here

## Post-MVP: query rewriting, built and measured (D-016)

One cheap model call turns a follow-up into a standalone search query before it
is embedded. The **search** uses the rewritten query; the **answer** is still
generated from the user's original words, because a reply addressing a silently
reworded question reads wrong.

**The failure it fixes, before and after:**

```
BEFORE   Q: When did they join?
            [query] -> 0 chunks
            A: I don't know based on the documents I have.

AFTER    Q: When did they join?
            searched for: "When did the floor supervisor and the
                           Operations Director join?"
            [query] -> 3 chunks
            A: The current Operations Director, Marisol Venn, joined
               Northwind Labs in the spring of the third fiscal cycle.
```

**It does not over-rewrite.** Across a 4-turn conversation, 2 turns came back
unchanged — the rewriter is told to echo a question that already stands on its
own, and it does. No call at all on the first message, which is the only guard
that is always correct; a pronoun-spotting heuristic would be cheaper and would
sometimes be wrong.

**Measured cost** over that conversation: 3 rewrite calls, 409 input + 30
output tokens, **$0.000079** — about **21%** on top of the answers, or
$0.00002 per message. Much less than doubling, because the rewrite prompt
carries only the short transcript while the answer prompt carries ~670 tokens
of retrieved chunks. **The real cost is latency**, one extra round trip before
every follow-up.

### What it does NOT fix — and the pattern this confirms

The Phase 3 wrong-antecedent case survives:

```
turn 3  Q: And what is the escort ratio for that group?
        searched for: "What is the escort ratio for prospective staff
                       badge holders?"          <- the rewriter got it RIGHT
        A: The escort ratio for auditor groups is one to one.   <- still wrong
```

The rewriter resolved the reference perfectly. The model still answered about
auditors, because that is the clause in the retrieved sentence that actually
names a ratio.

**Both post-MVP features follow the same pattern: they fix retrieval and leave
generation untouched.** Hybrid search put the right chunk at rank #1 for
"Who do I contact on extension 4417?" and the model refused anyway. Query
rewriting produced the right search query here and the model still picked the
wrong antecedent.

That is worth internalising. Once retrieval is good, **the remaining errors are
prompt problems, not search problems** — and the sources panel is what tells
the two apart, because you can see the correct chunk sitting there unused.

---

## Post-MVP: rewording the grounding instruction (D-017)

Acting on the finding above. The original wording was:

```
You answer questions using ONLY the context below.
If the context does not contain the answer, reply exactly: "<refusal>"
Do not use outside knowledge. Do not guess.
```

**"Do not guess" reads, to a model, as "do not reason."** That single phrase was
making it refuse questions whose answer was sitting in the retrieved chunk. The
new wording separates three things it had collapsed into one:

- **Connecting** facts the context states — allowed.
- **Adding** facts the context does not state — never.
- **Partial** answers — give what is there and say what is missing.

### Judged with a battery, not by eye

`scratch/prompt-eval.js` runs six fixed cases and checks **both directions at
once**, because Phase 5.5 proved this instruction is the only thing preventing
hallucination — a "fix" that loosens it is a regression, not an improvement.

| Case | Before | After |
|---|---|---|
| direct fact | PASS | PASS |
| **one-step inference** ("who do I contact on extension 4417?") | **FAIL** | **PASS** |
| wrong-antecedent follow-up | FAIL | FAIL |
| absent fact, same domain (goggles) | PASS | PASS |
| off-topic (France) | PASS | PASS |
| absent fact, plausible (parking spaces) | PASS | PASS |
| | **4/6** | **5/6** |

All three refusals held. That was the thing at risk.

### Two failures prompting could not touch

**The wrong-antecedent case is a model limit.** Retrieval and query rewriting
both did their jobs — the rewrite resolved to "prospective staff on site tours"
and the top chunk held the exact sentence. `gpt-4o-mini` still quoted the
*auditor* exception. Same prompt, one env var changed to `gpt-4o`: **6/6**, with
the correct one-per-three answer.

A second prompt attempt (an explicit general-rule-versus-exception instruction)
changed nothing and was removed rather than left in as dead tokens.

**The partial-answer clause loses to the pull to finish a sentence.**
Re-running the 5.4 setup (`CHUNK_SIZE` 300, `MATCH_COUNT` 1), where only the
Quiet Hour's hours are retrieved and not its reason:

```
gpt-4o-mini : "...because the building requires a period of reduced noise
               and activity."            <- invented, exactly as before
gpt-4o      : "...because the building has a Quiet Hour policy."
                                         <- circular rather than false
```

Neither says "the documents do not say why", which is exactly what the
instruction asks for. **An instruction to admit a gap is much weaker than the
pull to complete a sentence.** That one is not a prompting problem — it is
fixed by retrieving enough context in the first place.

**Model left as `gpt-4o-mini`.** `gpt-4o` reasons better over retrieved text but
costs roughly 16× per input token, and the gap showed on one contrived case out
of six. It is one env var away if that trade ever becomes worth it.

---

### Retrieval has no memory

```
turn 1  Q: Who signs off on a 5000 credit equipment request?
        A: The floor supervisor and the Operations Director.   [3 sources]

turn 2  Q: When did they join?
        A: I don't know based on the documents I have.     [0 chunks retrieved]
```

The answer *is* in the document. But conversation history is sent to the
**generator** and never to the **retriever**:

```
history -----------------------------> buildPrompt -> model   has context
question -> embed -> match_chunks ----> buildPrompt            no context
```

"When did they join?" embedded on its own is a vector pointing nowhere. Compare
"Which of those may not enter Bay 7?", which worked fine — because "Bay 7" is a
strong anchor by itself. **The difference is not the pronoun; it is whether the
question contains anything worth searching for.**

The standard fix is *query rewriting*: one cheap model call that turns the
question plus history into a standalone query before embedding it. **Built as
D-016 — see above.** It fixed this exact case.

### Vector search is bad at exact identifiers

| Question | Score |
|---|---|
| "extension 4417" (the exact string is in the document) | **0.284** |
| "Can a candidate on a tour walk into Bay 7?" (paraphrase) | 0.401 |

An exact quoted identifier scored *worse than a paraphrase*. Embeddings encode
meaning, and "4417" has almost none. This is the entire argument for **hybrid
search**: run a Postgres full-text query alongside the vector query and merge
the results. Keywords are good at identifiers and bad at meaning; vectors are
the reverse.

It also very nearly caused a bug: the planned `MIN_SIMILARITY` of 0.30 sits
*above* 0.284, so the shipped-as-designed system would have refused a question
it demonstrably has the answer to. Measuring instead of guessing caught it.

---

## The question Phase 5 exists to answer

**Why must the question and the documents be embedded by the same model, and
what happens if they are not?**

An embedding is a position in a space that the model invents during training.
`text-embedding-3-small` produces 1536 numbers whose meaning is defined entirely
by that model's internal geometry — dimension 412 has no independent definition,
it is whatever that model made it. A different model, even one also producing
1536 numbers, builds a completely unrelated space.

Cosine distance between two vectors from **different** spaces is still perfectly
computable. `<=>` will return a number. It will be in the normal range. It will
sort. It will pass the threshold sometimes. **And it will mean absolutely
nothing** — you are measuring the angle between two arrows in two different
rooms.

What happens: no error, no warning, no crash. Retrieval returns chunks that are
effectively random, the model dutifully answers from whatever it is handed, and
the answers are confidently wrong in a way that looks exactly like working
software. The sources panel would be the only signal — the scores would look
plausible but the chunks would have nothing to do with the question.

That is why `embed()` is one function reading one environment variable, used by
both pipelines. Not discipline — structure.

---

## Post-MVP: hybrid search, built and measured (D-015)

Implemented after Phase 5: `match_chunks` (cosine) and `match_chunks_fts`
(Postgres full-text) run in parallel, merged with **Reciprocal Rank Fusion**.

**Why fuse by rank rather than score.** Cosine similarity clusters between 0.28
and 0.55 here; `ts_rank` has a different scale and distribution entirely.
Averaging them means inventing an exchange rate between two currencies that
have none. RRF throws the scores away and keeps only the ordering:
`score = Σ 1/(60 + rank)`. A chunk both searches found collects two
contributions and rises. Nothing to tune.

**Keyword hits deliberately skip `MIN_SIMILARITY`** — that gate is for semantic
evidence, and an exact match is a different kind of evidence.

### What it actually bought — less than I expected

Tested on a **19-chunk** corpus (the handbook plus eight filler documents
sharing lab vocabulary):

| Query | Vector-only, top 5 | Hybrid, top 5 |
|---|---|---|
| "Who do I contact on extension 4417?" | rank #1 | rank #1 |
| "What is form NL-220 for?" | rank #1 | rank #1 |
| "What does form NL-114 cover?" | rank #2 | rank #2 |
| "What are the hours of the Quiet Hour?" | rank #2 | rank #2 |
| **`NL-220` (typed alone)** | **missed entirely** | **rank #2** |
| `4417` (alone) | rank #1 | rank #1 |
| `NL-114` (alone) | rank #1 | rank #1 |

**For every properly phrased question, hybrid changed nothing.** The
surrounding words ("form", "contact", "report") give the embedding plenty to
work with, and vector search was already right.

**The one real win was a bare identifier.** Typing `NL-220` alone, vector-only
returned five chunks above the threshold and **not one of them contained
NL-220** — it answered from the wrong chunks. Hybrid put the right chunk at #2
and produced: *"NL-220 is the form that must be used to report any incident
involving spillage, equipment failure, or injury within four hours."*

### And a failure hybrid search does **not** fix

Back on the 3-chunk corpus, through the running server:

```
Q: Who do I contact on extension 4417?
   sources: 0.372/both  0.307/vector  0.299/vector
   A: I don't know based on the documents I have.
```

The top chunk **is** the right one — rank #1, confirmed by keyword search, and
it reads *"...reported to the Kessler Seismograph Annex liaison, currently
reachable at extension 4417."* The answer is sitting in the context and the
model refused anyway, because answering needs one small inference: the person
*reachable at* that extension is the person you *contact on* it.

**Retrieval was fixed; generation still failed.** That is the distinction worth
keeping. Hybrid search improves *what reaches the prompt*. It has no effect on
whether the model is willing to use it, and the "use ONLY the context"
instruction makes the model conservative enough to decline a one-step
inference. Phase 5.4 showed the same instruction being too weak in the other
direction — it invented a reason when half an answer was present. It is a blunt
instrument in both directions.

**The honest conclusion:** on a small corpus this is close to free insurance
rather than a visible upgrade. Its value grows with corpus size — the more
chunks compete, the more often the one holding an identifier gets pushed out of
the vector top-N by semantically closer neighbours. Worth having; not worth
expecting a transformation.

**Cost:** one extra Postgres round trip, run in parallel. `CANDIDATE_COUNT` is
10 per search but the fused list is trimmed to `MATCH_COUNT` (5), so **zero
extra prompt tokens.**

---

## Post-MVP: paragraph-aware chunking (D-018)

Phase 5.1 and 5.2 showed chunking moves retrieval quality more than any other
knob, so this was the change with the most left in it. `chunkText()` now packs
**whole paragraphs** up to a `CHUNK_SIZE` ceiling instead of cutting at a fixed
offset. Sizes unchanged (1000 / 150). The old sliding window survives as the
fallback for a paragraph bigger than the ceiling, and for text pasted with no
blank lines at all.

**Northwind handbook, before and after:**

```
before : 3 chunks  1000 / 1000 / 907   cut mid-sentence
after  : 4 chunks   584 /  804 / 720 / 937   every one ends on a full stop
```

**The scores, re-measured with `npm run scores`:**

| Question | Before | After |
|---|---|---|
| "What time is the Quiet Hour?" | 0.536 | **0.588** |
| "What temperature does the Bay 3 freezer run at?" | 0.462 | **0.530** |
| "Who approves equipment requests over 2000 credits?" | 0.462 | **0.548** |
| "How long are chemical samples retained?" | 0.457 | **0.577** |
| *absent* — safety goggles | 0.427 | 0.427 |
| *off-topic* — capital of France | 0.039 | 0.068 |

**The separation is the point, not the scores.** True positives rose 0.05–0.12
while the absent and off-topic questions barely moved, so the empty band the
threshold sits in got *wider*. `MIN_SIMILARITY` re-checked and left at 0.25 —
still between the top off-topic score (0.092) and the weakest true positive
(0.286). Prompt battery unchanged at 5/6.

### Why a paragraph boundary beats character 1000

A chunk is represented by **exactly one embedding**. A chunk holding one
complete idea embeds cleanly; a chunk holding the tail of one idea plus the
head of another embeds as a blur of both — and a fixed offset produces the
second kind at every single boundary.

It also stops a fact being orphaned from its subject:

| Chunk | Contains | Score vs "what is the nightly rate for the Presidential Suite?" |
|---|---|---|
| A | the suite's name, no price | **0.498** |
| B | the price, no mention of the suite | **0.384** |

**The chunk with the answer ranked below the chunk without it.** With
paragraph breaks present, both facts land in one chunk and the problem does not
arise.

### Two things worth keeping from building it

**It only helps where the source has paragraph breaks.** The same test text
pasted as one unbroken wall still split the suite from its price — there is
nothing but the fallback left to use.

**My first version had a real bug.** The carried overlap tail was being emitted
as a chunk of its own, so 1001 characters with no breaks produced 3 chunks where
the old splitter produced 2. It was caught only by checking the new output
against the old on identical input, which is the whole argument for keeping a
regression check on a "pure" function you think is obviously correct.

---

## Post-MVP: streaming responses (D-019)

`POST /api/chat` now streams when the client asks for `text/event-stream`, and
returns the original JSON body otherwise. Reverses D-010, which kept it out of
the MVP so the route stayed readable while being learned.

**What it actually bought, measured on one question:**

```
streamed : sources on screen 1,381ms | first word 2,013ms | done 2,651ms
blocking : nothing at all until 2,353ms
```

Something useful appears **1.7× sooner**, while the answer finishes slightly
later. Same tokens, same cost — only the delivery changed.

**The best part is not the typing effect.** The `meta` event fires the instant
retrieval finishes and *before the model has written a word*, so the sources
panel is on screen while the answer is still being generated. You can read what
the model was handed at the same time as what it makes of it.

### Three things that make streaming harder than it looks

**A network chunk does not respect event boundaries.** TCP splits wherever it
likes, so one SSE event can arrive in two pieces. Both the server (reading
OpenAI) and the browser (reading the server) buffer and only process up to the
last blank line. Assuming one chunk equals one event works perfectly until it
doesn't, and then fails intermittently under load — the worst failure shape
there is.

**An error after the headers are sent cannot use a status code.** Once
streaming begins the response is committed to `200`, so the normal
error-to-status mapping in `server.js` is useless. The failure has to travel
down the stream as an `error` event, and the client has to take it as
seriously as a bad status. Validation errors are unaffected — they happen
before streaming starts and still return `400`.

**`req.accepts()` was the wrong tool, and it failed silently.** It honours
wildcards, and curl sends `Accept: */*` — which matches `text/event-stream`.
Every curl example in the docs was being handed a stream it could not parse.
The check is now an explicit `Accept` substring test. A helper that looks more
correct than a string comparison quietly did the opposite of what was intended.

---

## Tenancy Phase 2: the index under a tenant filter (2026-09-23)

**Setup:** two tenants in one `chunks` table. `northwind` (id 1) has 4 chunks
and `villa` (id 3) has 30. pgvector is **0.8.2**. The query vector is chunk
139's stored embedding. Plans come from `explain (analyze, buffers)` through a
temporary `tenancy_explain()` helper, and the full output is in
`plan/baseline/explain-phase2.txt`.

**1. At this size the planner does not use HNSW for a tenant-scoped search.**
The plan says to look for `Index Scan using chunks_embedding_idx` rather than
`Seq Scan`. It found neither:

```
Limit (actual rows=4)
  ->  Sort   Sort Key: (c.embedding <=> ...)
        ->  Index Scan using chunks_tenant_idx on chunks c (actual rows=4)
              Index Cond: (tenant_id = 1)
```

The planner reads the tenant's rows through the B-tree and sorts all of them
exactly. That is an **exact** search with perfect recall, and it costs
O(tenant size), not O(table size). Unfiltered, the same query does use HNSW
(`Index Scan using chunks_embedding_idx`, `Order By: embedding <=> ...`).

**2. The ids did not change.** Tenant-scoped `match_chunks` returns exactly the
Phase 0 ids, before and after the change below:

| Question | Phase 0 | Phase 2, tenant 1, both tenants loaded |
|---|---|---|
| Bay 3 freezer | 139 · 138 · 140 · 137 | 139 · 138 · 140 · 137 |
| extension 4417 (≥ 0.25) | 140 · 137 · 138 | 140 · 137 · 138 |

**3. The § 2.1 failure is real, reproduced by forcing the shape a large tenant
gets.** `tenant_id + 0 = N` is not indexable, so the planner has to walk HNSW
and post-filter. `hnsw.ef_search = 2` stands in for "the walk is short compared
with how many other-tenant chunks surround the query":

| Run | Tenant | ef_search | iterative_scan | Rows (want 4 / 5) |
|---|---|---|---|---|
| J | 1 | 40 | off | 4, with 19 removed by filter |
| K | 1 | 2 | off | **2** |
| N | 3 | 2 | off | **0**, a silent false refusal |
| L | 1 | 2 | strict_order | 4, with 30 removed by filter |
| M | 1 | 2 | relaxed_order | 4 |
| O | 3 | 2 | strict_order | 5 |

In run N the walk visited two chunks, both northwind's, and stopped. In the
pipeline that becomes `[retrieve] vector:0`, then the D-008 short circuit, then
a refusal of a question villa's documents answer. Nothing errors.

**Chosen: `set hnsw.iterative_scan = 'strict_order'` on the tenant-scoped
`match_chunks`.** Both iterative modes fixed the loss. `strict_order` was chosen
because `relaxed_order` may return rows slightly out of distance order, and the
pipeline and `verify.mjs` check 10 both assume most-similar-first. It costs
nothing today, because the planner is not using HNSW for these queries anyway.
It is insurance for the day it does. Confirmed in `pg_proc.proconfig` (a lookup
went from 0 rows to 1). The bound that remains is `hnsw.max_scan_tuples`
(default 20,000).

**4. Full-text search: no composite GIN index.** `match_chunks_fts` with the
tenant filter goes through `chunks_tenant_idx` plus a tsvector recheck (runs H
and I, 1 row found, 3 removed by filter), even with seqscan off. There is no
case for `btree_gin` yet. Revisit when one tenant holds thousands of chunks.

**Re-measure at ten tenants and at fifty (R-10).** Run it the same way, and
watch the logs for `[retrieve] vector:0` on a question that should hit.

---

## Tenancy Phase 4: the persona, before and after (2026-09-23)

**The change:** one line above the grounding block. The block itself is
byte-identical to D-017:

```
You are {assistantName}, the assistant for {businessName}.
```

The optional second sentence the plan offered ("Answer only from the context
below, even when a more helpful answer seems obvious") was **left out**,
because the verdicts were identical without it.

**The gate:** the six original cases against northwind, compared verdict by
verdict with `plan/baseline/eval-pre-tenancy.txt`:

| Case | Phase 0 (no persona) | Phase 4 (persona) | Phase 4, run 2 |
|---|---|---|---|
| direct | PASS | PASS | PASS |
| inference | PASS | PASS | PASS |
| antecedent | FAIL (auditor 1:1) | FAIL (auditor 1:1) | FAIL |
| absent | PASS (refused) | PASS (refused) | PASS |
| offtopic | PASS (short circuit) | PASS (short circuit) | PASS |
| absent-2 | PASS (refused) | PASS (refused) | PASS |

No verdict flipped, and the one FAIL is the same model limit with the same
wrong answer. The persona cost no refusal.

**The four new cases**, with villa (8 documents, 30 chunks) in the same tables:

| Case | What it asserts | Observed |
|---|---|---|
| leak-1 | northwind refuses "parking spaces", a fact villa has | refused |
| leak-2 | northwind refuses `amihanpansol2019`, villa's Wi-Fi password | northwind `vector:0 keyword:0`, refused. Control: villa `keyword:1`, "amihanpansol2019 is the Wi-Fi password for Villa Amihan Private Resort." |
| leak-3 | a villa transcript, read as northwind, does not exist | owner sees 2 messages; northwind gets `null` |
| persona | greeting villa names Lia and Villa Amihan, and never Nora or Northwind | "Hello! I'm Lia, the assistant for Villa Amihan Private Resort. …" |

**leak-2's control is what makes it a real test.** Without it, a northwind
refusal could just mean the identifier is unfindable. The villa run shows
keyword search does find it (`keyword:1`, fused as `both`), so the northwind
refusal is the tenant filter inside `match_chunks_fts` at work.

**10 cases: 9/10, twice.** The full output is `plan/baseline/eval-post-persona.txt`.

---

## Before using any of this on real documents

**Every number in this file was measured on one invented 2,607-character
document. None of them transfer.** Two commands exist for re-deriving them, and
they live in `tools/` rather than gitignored `scratch/` for that reason:

```bash
npm run scores   # real similarity scores, threshold off -> set MIN_SIMILARITY
npm run eval     # the prompt battery -> also how you choose the chat model
```

Rewrite the cases in `tools/prompt-eval.js` to use your own documents' facts
first; the shipped ones are about a fictional laboratory. The full production
list is in `README.md` § "Before you put this in production", and the risk of
skipping it is `risks.md` § R-9.

---

## What I would do next, in order

1. ~~**Hybrid search.**~~ **Done** — see above. Smaller win than the
   "extension 4417" result suggested, because that score was measured on a
   3-chunk corpus where nothing else competed.
2. ~~**Query rewriting.**~~ **Done** — see below.
3. **Re-measure `MIN_SIMILARITY` on a real corpus.** 0.25 was derived from three
   chunks of one invented document; it is not a constant of nature.
4. **Chunk on paragraph boundaries first, then size.** 5.1 showed smaller chunks
   retrieve better; 5.4 showed too-small chunks cut answers in half. Splitting
   on structure gets the first without the second.
5. **Streaming**, purely for the feel of it.
