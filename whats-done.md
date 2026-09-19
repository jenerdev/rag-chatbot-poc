# What's Done — and What Each Step Actually Means

> **Purpose of this file.** `status.md` answers *"what do I do next?"*. This file
> answers *"what did I just do, and why did it matter?"* — the stated goal of the
> project is **"I want to fully understand how it works,"** so every step below is
> written up with the reasoning, not just the outcome.
>
> Covers **Phase 0 (Setup)**, **Phase 1 (Prove the API calls)**,
> **Phase 2 (Ingest)**, **Phase 3 (Query)**, **Phase 4 (UI)** and
> **Phase 5 (Experiments)** — the whole project, complete.
> The measured findings from Phase 5 live in their own file,
> [`notes.md`](./notes.md); this file records what was built and why.
> Last updated: 2026-09-20.

---

## The one-paragraph version

**Phases 0 and 1** put the four external things the project depends on — an OpenAI account with credit, a Postgres
database with `pgvector` turned on, a schema, and a working Node project — into a
known-good state, and then **proved each one works in isolation** before writing
a single line of pipeline code. That ordering is deliberate: when the full
pipeline misbehaves later, the two HTTP calls and the database are already
eliminated as suspects.

**Phase 2** then built the first half of the pipeline itself —
`paste → chunk → embed → store` — as four small modules and three HTTP routes,
verified with `curl` and no UI.

**Phase 3** built the second half — `question → embed → search → prompt →
answer` — and with it **the project's success criterion now passes end to end**:
ask about a fact only the pasted document contains, get the right answer plus
the chunk it came from; delete the document, ask again, get "I don't know."

**Phase 4** put a browser on all of it: two pages, no framework, no build step,
and the sources panel that makes every answer checkable against the text it came
from.

**Phase 5** then broke it on purpose — each of the five knobs turned to its
extremes to see what each one is actually holding up. That phase is the reason
the project exists, and it changed two things I thought I understood.

---

# Phase 0 — Setup

**Goal:** get accounts, keys, database and project skeleton in place.
**Why it comes first:** none of it is code, and one step (OpenAI billing) can
block everything else for reasons that have nothing to do with programming.

---

## 0.1 — OpenAI credits · done

**What was done:** a platform.openai.com account with prepaid credit added
(~$5), and a spending limit set.

**Why this is step one.** It is the only step in the entire project that can stop
you dead for a non-technical reason. The trap it exists to avoid:

> **A ChatGPT Plus subscription grants zero API access.** They are separate
> products with separate billing. An API key created under a Plus account is a
> *valid* key that fails every call with a quota error — which reads like a bug
> in your code, not a billing problem.

**Is $5 enough?** Yes, by a wide margin. The whole POC costs well under $1. For
calibration, the three test scripts we ran in Phase 1 consumed **56 tokens
total** — roughly $0.00002.

**The spending limit is not paranoia.** The one genuine way to burn credit fast
on a project like this is a loop around an API call — a retry that never gives
up, or an accidental `while`. This is also why `architecture.md` § 9 bans retry
logic outright in the MVP.

---

## 0.2 — API key created · done

**What was done:** an API key generated and stored in `.env`.

**The thing to understand:** this key is a **bearer** credential. Anyone holding
the string can spend your credit. That single fact drives the entire shape of
this application's architecture:

- The browser never calls OpenAI. It calls *our* Express server, which calls
  OpenAI. That is the only reason this project has a backend at all.
- `.env` went into `.gitignore` **before** any commit existed, not after. Key
  scrapers crawl GitHub continuously, and deleting a commit does not help — it is
  already indexed.

This is `risks.md` § R-1, and it is the single security rule the POC enforces.

---

## 0.3 — Supabase project · done

**What was done:** a free-tier Supabase project created.

**What Supabase is, in this project:** a hosted Postgres database with an HTTP
API in front of it. We are using almost none of its product surface — no auth, no
storage, no edge functions. We want two things:

1. **Postgres with the `pgvector` extension available**, which is what makes
   vector search possible without running a separate vector database.
2. **HTTP access (PostgREST)**, so `@supabase/supabase-js` can talk to it from a
   laptop with no connection string, no connection pooler and no firewall
   negotiation.

**Why not Pinecone / Chroma / Qdrant?** Because a separate vector database means
the chunk *text* lives in one system and the chunk *embedding* lives in another,
and they can drift out of sync. At this corpus size there is no performance
argument for it whatsoever (D-003).

---

## 0.4 — Credentials copied · done

**What was done:** the project `URL` and the **`service_role`** key copied into
`.env`.

**The distinction that matters.** Supabase gives you two keys:

| Key | Who it is for | What it does |
|---|---|---|
| `anon` | Browsers | Public. Row Level Security applies to it. |
| `service_role` | Trusted servers | **Bypasses Row Level Security entirely.** |

We use `service_role` because our Express server is the only client of this
database and it needs unrestricted read/write. The consequence: **that key must
never reach the browser.** Same rule as the OpenAI key, same reason.

**Verified:** all six variables load from `.env` — checked by printing each name
with only its *length*, never its value.

---

## 0.5 — `schema.sql` written and run · done

**What was done:** `schema.sql` written from `architecture.md` § 4 and run in the
Supabase SQL editor. It creates, in one pass: the `vector` extension, four
tables, three indexes, RLS on all four tables, and the `match_chunks` function.

### The four tables, and why each exists

| Table | Why it exists |
|---|---|
| `documents` | The original pasted text, kept whole. Never searched — it is the human-readable record of what you ingested. |
| `chunks` | **The table RAG actually reads.** Each row is a slice of a document plus its embedding. |
| `conversations` | One row per chat session, so messages can be grouped. |
| `messages` | The turn-by-turn history, so a follow-up like "what about the second one?" has something to resolve against. |

### `vector(1536)` — the number that is welded to the model

The `chunks.embedding` column is declared `vector(1536)` because
`text-embedding-3-small` outputs exactly 1536 numbers. This is not a tuning
parameter. **Changing the embedding model means altering the column type AND
re-embedding every existing chunk** — old vectors cannot be converted, because
they describe positions in a different coordinate space. This is why we verified
the model was still current *before* creating the schema (see "Model check"
below) rather than after ingesting anything real.

### Why HNSW and not ivfflat

```sql
create index chunks_embedding_idx
  on chunks using hnsw (embedding vector_cosine_ops);
```

Both are approximate-nearest-neighbour indexes. The practical difference for us:
**HNSW builds on an empty table; ivfflat needs existing rows to train on.** Since
we created the schema before ingesting anything, ivfflat would have failed or
built a useless index. HNSW is also the current pgvector recommendation.

### `match_chunks` — why the search lives in SQL

Vector search is a SQL operation, so it lives in a Postgres function and is
called from Node via `.rpc()`. Three things in it are worth reading closely:

```sql
1 - (c.embedding <=> query_embedding) as similarity
...
order by c.embedding <=> query_embedding   -- ascending distance
```

- **`<=>` is pgvector's cosine distance operator.** `0` means the two vectors
  point in identical directions; `2` means opposite.
- **`1 - distance` flips it into a similarity score** where higher is better,
  which is the more intuitive direction and what the UI will display.
- **Ordering by distance ascending, not similarity descending.** These produce
  *identical results*, but only the first one can use the HNSW index. Write it
  backwards and Postgres silently falls back to scanning every row — correct
  answers, quietly wrong performance. Nothing warns you.
- **`min_similarity` is the "do I actually know this?" gate.** Without it, vector
  search *always* returns its N nearest chunks, even for a question with nothing
  to do with your documents. Those irrelevant chunks then get pasted into the
  prompt as though they were relevant.

### The RLS detour — and a real lesson

Running the script triggered a Supabase warning: *"This query creates tables
without enabling Row Level Security."* This was anticipated (`risks.md` § R-2) —
`create table` in the SQL editor does not enable RLS, unlike the dashboard's
table editor.

**Decision: enable RLS, write no policies.** It costs the POC nothing, because
`service_role` bypasses RLS anyway. What it buys is that the tables are *not*
wide open if the `anon` key ever leaks. RLS on with zero policies means `anon`
and `authenticated` can do nothing at all, and our server is unaffected. This is
recorded as an amendment to D-006 in `decisions.md`.

**What actually happened, and the lesson:** the first run reported success, but
`pg_tables.rowsecurity` still read `false` — the SQL editor was still holding the
pre-amendment copy of the file, so the `alter table` lines never ran. Running the
four `alter` statements separately fixed it, and all four tables now report
`true`.

> **The lesson is bigger than RLS: "the command succeeded" is not the same as
> "the effect happened."** Verify the state, not the exit code. This is the exact
> shape of every failure in `risks.md` § R-3, where the whole danger is that
> nothing errors.

---

## 0.6 — `pgvector` verified · done

**What was done:** verified *functionally* from Node rather than with the
`select * from pg_extension where extname = 'vector'` query in the roadmap.

**Why the substitution.** Supabase's HTTP layer (PostgREST) cannot query Postgres
system catalogs, so that particular query cannot be run from our code. Instead,
Phase 1.2 inserts a `vector(1536)` value, reads it back, and searches it with the
`<=>` operator. **`<=>` does not exist unless the extension is installed**, so a
successful similarity search is strictly stronger evidence than the catalog row:
it proves the extension is not merely present but working, on the right column,
through the exact code path the app will use.

---

## 0.7 — Node project skeleton · done

**What was done:** `package.json` with `"type": "module"`, three dependencies
installed, `.gitignore` and `.env.example` written.

**Installed versions** (recorded in `techstack.md`):

| Package | Installed |
|---|---|
| node | 24.19.0 |
| express | 4.22.3 |
| @supabase/supabase-js | 2.116.0 |
| dotenv | 16.6.1 |

**`typeof fetch === 'function'` confirmed.** Node 18+ ships a global `fetch`,
which is the reason this project needs no HTTP library and no OpenAI SDK.

**Three dependencies, and what is deliberately absent:**

- **No LangChain / LlamaIndex.** They exist to hide chunking, embedding,
  retrieval and prompt assembly — the exact four things this project exists to
  expose. `RetrievalQAChain.fromLLM(...)` is one line and teaches nothing.
- **No `openai` SDK.** The two API calls are ~10 lines each written by hand, and
  writing them means seeing the actual request body going over the wire.
- **No TypeScript, no bundler, no build step.** A compile step between the code
  you read and the code that runs is precisely wrong for a project about
  understanding what runs.

**`.gitignore` contains `node_modules`, `.env` and `scratch/`** — written before
any commit exists, per R-1.

---

## Model check (Q-3 / R-8) — done before the schema

The planning docs named `gpt-4o-mini` and `text-embedding-3-small` on
2026-09-20, and model lineups move. Because the **embedding** model is welded to
`vector(1536)`, getting this wrong after ingesting real data would mean a schema
change plus a full re-embed.

**Checked against OpenAI's official deprecations page:** neither model is
deprecated or scheduled for shutdown. Community posts claiming an October 2026
shutdown of `text-embedding-3-small` are contradicted by OpenAI's own page.

**Conclusion:** both models stand, `vector(1536)` stands, Q-3 resolved.

---

# Phase 1 — Prove the two API calls

**Goal:** confirm every external dependency works *before* any pipeline exists to
confuse the diagnosis.

**Why this phase is not optional.** RAG fails quietly. When a retrieval result
looks wrong later, you want to already know — with certainty — that the embedding
call, the database write and the chat call are all fine, so the bug must be in
*your* logic. Debugging four unknowns at once is how a weekend disappears.

All three scripts live in `scratch/`, which is gitignored (Q-5's compromise:
keep them for debugging, don't commit them).

---

## 1.1 — `scratch/embed-test.js` · done

**What it does:** sends `"hello world"` to `POST /v1/embeddings` with raw `fetch`
and prints the result.

**Output:**

```
model      : text-embedding-3-small
dimensions : 1536
all numbers: true
tokens used: 2
```

**What "1536" proves — four things at once:**

1. The API key is valid (not a 401).
2. There is credit behind it (not a 429).
3. The network path to OpenAI works.
4. The model name is current (not a 404).

**What an embedding actually is.** 1536 floating-point numbers describing a
position in a 1536-dimensional space, arranged so that texts with similar
*meaning* land in similar directions. That is what makes semantic search
possible: *"How do I get my money back?"* and *"Refund policy"* share zero
keywords but sit close together. Keyword search cannot do that; this can.

**One detail worth noticing in the code:** `input` takes an **array**. That is
what will let the real pipeline embed every chunk of a document in a single HTTP
call instead of one call per chunk (F-3).

---

## 1.2 — `scratch/roundtrip-test.js` · done

**What it does:** the most important test in Phase 1. It embeds a sentence,
inserts it, reads it back, searches it, and deletes it.

**Output:**

```
embedded   : 1536 dims
document id: 1
chunk id   : 1
wire type  : string
parsed dims: 1536
all numbers: true
value drift: 3.59e-9
matches    : 1
  sim 1.0000 | The Q4 offsite is at Lake Tahoe and the budget cod
chunks left: 0 (cascade OK)
```

### What each line proves

**`wire type : string`** — PostgREST has no JSON type for `vector`, so it hands
the column back as the string `"[0.1,0.2,…]"`. **This is normal and is not the
bug this step hunts for.** What matters is that it parses into 1536 numbers
matching what went in. The actual failure mode being guarded against is an
embedding *stored* as text in the database, which makes search behave bizarrely
with no error anywhere (`risks.md` § R-3).

**`value drift: 3.59e-9`** — pgvector stores `float4` (single precision) while
JavaScript numbers are double precision, so a tiny rounding loss on storage is
expected and harmless at cosine-similarity scale. Worth knowing because it means
an exact-equality check against a stored embedding would fail.

**`sim 1.0000` — the strongest signal in the whole phase.** We searched for the
chunk using its *own* embedding. Cosine distance to itself is 0, so similarity is
1. Because `<=>` is a pgvector operator that only works on a genuine vector
column, that single number simultaneously proves:

- the `vector` extension is live (this is Phase 0.6's real verification),
- the column is a true `vector`, not text,
- the insert did not mangle or stringify anything,
- `match_chunks` is correctly defined and callable via `.rpc()`,
- the whole storage-and-search path works end to end.

**`chunks left: 0 (cascade OK)`** — deleting the `documents` row removed its
chunks automatically, via `on delete cascade` in the schema. This matters because
the success criterion for the entire project depends on it: *delete the document,
ask again, and the bot must no longer know the answer.* If chunks survived their
parent document, deleted documents would keep answering questions.

**It also proved the `service_role` key works.** RLS is now on, so the `anon` key
would have failed these writes with a policy error. They succeeded, which
confirms the right key is in `.env`.

---

## 1.3 — `scratch/chat-test.js` · done

**What it does:** one call to `POST /v1/chat/completions`.

**Output:**

```
model  : gpt-4o-mini-2024-07-18
reply  : A vector embedding is a numerical representation of an object...
finish : stop
tokens : 23 in + 31 out
```

**The concept this exists to make concrete:** `messages` is a plain array of
`{role, content}` objects, and **the model has no memory between calls.** Every
request is completely stateless. Everything the model knows on a given turn is in
that array and nowhere else.

That single fact is *why RAG works the way it does.* There is no special
"knowledge base" channel into the model. Retrieved chunks are not injected into
its brain — they are pasted into the prompt **as ordinary text**, exactly like
the user's question. That is the entire trick, and it is also why:

- the system prompt instructing it to refuse is doing real work,
- conversation history must be capped at ~6 messages, since the whole array is
  re-sent and **re-billed** on every single turn.

**`finish: stop`** means the model ended naturally rather than hitting a token
limit — worth knowing because a truncated answer would show `length` instead.

---

# Phase 2 — Ingest

**Goal:** the first half of the pipeline — paste text in, get searchable chunks
out. `paste → chunk → embed → store`.

**What exists after this phase:** four modules, one Express server, three
routes, ~330 lines. No UI; everything verified with `curl`.

---

## 2.1 — `src/chunker.js` · done

**What it is:** a pure function. `chunkText(text, size, overlap)` takes a string
and returns an array of strings. No imports, no `async`, no I/O.

**Why it is isolated like that.** Chunking is the step most people never look
at, and it decides retrieval quality more than the model does. Keeping it free
of dependencies means you can read it, run it and reason about it with no
network, no database and no API key involved.

### The mechanism, in one line

```js
const step = size - overlap;
for (let start = 0; start < clean.length; start += step) { ... }
```

**The difference between `size` and `step` *is* the overlap.** The window is
1000 characters wide but only advances 850 each time, so 150 characters of each
chunk are a repeat of the one before it. That is the whole trick.

### Why overlap exists at all

A hard cut can land mid-sentence and split a fact across two chunks, leaving
neither able to answer a question about it:

```
chunk 1: "...refunds are accepted within"
chunk 2: "30 days of delivery..."
```

Neither chunk alone is a good match for *"how long do I have to return
something?"* With overlap, the tail of chunk 1 is repeated at the head of chunk
2, so the sentence survives whole somewhere. The cost is duplicated storage and
embedding — about 15% here.

### Why the two sizes are what they are

- **Too small:** a chunk loses the context that gave it meaning. *"It must be
  returned within 30 days"* — returned where, by whom?
- **Too large:** one vector has to represent the entire chunk, so a chunk
  covering four topics points somewhere between all four and matches none of
  them well.

**Characters, not tokens** (D-007) — counting tokens needs a tokenizer
dependency, and ~4 characters ≈ 1 token is close enough for sizing.

### Verified

Ran it against a 6,999-character document where every sentence is numbered, so
the overlap is readable rather than theoretical:

```
chunks : 9  | estimate: 9
sizes  : 1000 x 8, then 199
chunk0 tail : "...sentence-030 ... sentence-035 filler "
chunk1 head : "...sentence-030 ... sentence-035 filler "
identical   : true
```

Edge cases all behave: empty string and whitespace-only return `[]`, exactly
1000 characters gives 1 chunk, 1001 gives 2, and an `overlap >= size` throws
immediately rather than looping forever — that combination makes the window
never advance, which would hang the server.

`estimateChunkCount()` is the same arithmetic in closed form, exported so the
admin page can show the count live **as you type**, before anything is sent
(screens.md § S-2). It matched the real count exactly.

### One deliberate wart

A document whose length lands just past a chunk boundary produces a short final
chunk that is mostly duplicate (the 199-character tail above is an example).
Smarter chunkers avoid this. Ours does not, on purpose — Phase 5 is about
feeling these limits rather than being protected from them.

---

## 2.2 — `src/openai.js` · done

**What it is:** the only two HTTP calls this project makes to OpenAI, written
with `fetch` (D-002). This module knows nothing about chunks, documents or
prompts — it takes text and returns vectors, takes messages and returns a
string.

### `embed(texts)` — one call, not N calls

`input` accepts an **array**, so a 40-chunk document is one HTTP request rather
than forty (F-3). This matters far more for latency than for money: the cost is
identical either way, but forty sequential round trips would make ingest
roughly 40x slower.

**The subtle bug this code avoids:** the response is
`{ data: [{ index, embedding }, ...] }`. OpenAI documents that `data` comes back
in input order — but it also gives every item an explicit `index`. We sort by
that index rather than trusting the array order. If a response ever came back
reordered, trusting order would pair every chunk with the wrong vector, and the
result would be a knowledge base that retrieves confidently and wrongly with no
error anywhere. Cheap insurance against the exact class of failure in R-3.

**Where the project's #1 constraint lives.** Both the documents and the
questions are embedded by this one function, reading one env var. That is what
guarantees they use the same model. Vectors from different models describe
positions in unrelated coordinate spaces, so comparing them produces
plausible-looking similarity scores that mean nothing — and nothing errors
(D-004).

### `chat(messages)`

One request, one complete answer — no streaming in the MVP (D-010).
`temperature: 0.2`, because the task is *"read this context and report what it
says"*, which wants faithfulness rather than invention.

### Error mapping

The two failures you will actually hit get their own sentences:

| Status | Message |
|---|---|
| 401 | OpenAI rejected the API key — check `OPENAI_API_KEY` in `.env` |
| 429 | Out of OpenAI credits or rate limited |
| 404 | OpenAI does not recognise that model name |
| 5xx | OpenAI is having a problem on their end |

The original error text from OpenAI is appended, never swallowed, and the
upstream status is attached to the error object as `.status` so `server.js` can
map it. **No retries, no backoff** (`architecture.md` § 9) — retry logic hides
exactly the failures you want to see while learning, and a loop around a paid
API call is the one genuine way to burn credit fast.

---

## 2.3 — `src/supabase.js` · done

**What it is:** one configured client, exported. That is the entire file.

No query logic lives here, which means every database call in the project is
visible at its call site in `rag.js` rather than hidden behind a wrapper.

`persistSession: false` and `autoRefreshToken: false` because there is no user
session — this is a server talking to a database, not a browser talking to an
auth provider.

---

## 2.4 — `src/rag.js` · `ingestDocument()` · done

**What it is:** the ingest pipeline, written to read top-to-bottom like the
flowchart in `architecture.md` § 3.1. No `req`, no `res`, no status codes — it
throws, and `server.js` decides what that means to a browser.

### The four steps

1. **Chunk first**, before touching the database or the network. If the text
   produces nothing, there is no point creating a row.
2. **Insert the `documents` row** — we need its id before chunks can reference it.
3. **Embed every chunk in one call.**
4. **Insert all the chunk rows**, each with its `chunk_index` and vector.

### The `catch` block is the interesting part (R-7)

After step 2 the `documents` row **exists**. If embedding then fails, you are
left with a document that appears in the admin list, has zero chunks, can never
be retrieved, and gives no indication why. So the `catch` deletes the document
row and rethrows.

**This is cleanup, not a transaction.** `supabase-js` speaks HTTP via PostgREST,
so there is no `BEGIN`/`COMMIT` to wrap the sequence in. Deleting the document
cascades to any chunks that did land, so the same three lines work whether the
failure happened before or after the chunk insert.

### The two supporting reads

**`listDocuments()`** uses PostgREST's `chunks(count)` aggregate, which counts
the related rows **without fetching them**. That is deliberate: each embedding
is ~6 KB, and the admin list needs none of them. A document showing 0 chunks is
the R-7 orphan, and the UI will badge it — a symptom you can see beats one you
cannot.

**`deleteDocument(id)`** deletes only the document. The chunks go with it via
`on delete cascade` in the schema, enforced by Postgres, so there is no second
delete to write. This is the half of the project's success criterion that proves
retrieval is real: *delete the document, ask again, and the bot must stop
knowing the answer.*

---

## 2.5 — `server.js` · done

**What it is:** routes, validation, static files, and the single place where an
error becomes an HTTP status code. No business logic.

### Fail fast on missing config

Five required environment variables are checked at boot; a missing one exits
with a message naming it. **A missing key should be a one-line error at startup,
not a confusing 401 twenty minutes later** while you are debugging something
else (`architecture.md` § 8).

### The `route()` wrapper — an Express 4 detail worth knowing

```js
const route = (handler) => (req, res, next) => handler(req, res).catch(next);
```

Express 4 does **not** catch errors thrown inside `async` route handlers. Without
this wrapper, a throw inside a route leaves the request hanging until it times
out, with no response and no error — a genuinely confusing failure. Express 5
fixed this; we are on 4 deliberately, because that is the version every tutorial
and Stack Overflow answer you will hit matches (D-009).

### Validation at the boundary

`title` non-empty, `content` non-empty, `content` under 100,000 characters,
`:id` a positive integer. The pipeline assumes its input is already sane — that
separation is why `rag.js` has no defensive checks cluttering it.

### One place for error to status

```
401 or 429 from OpenAI  -> pass through unchanged
5xx from OpenAI         -> 502 (their problem, surfaced as a gateway failure)
everything else         -> 500
```

The real message always reaches the client. No swallowing, no generic "something
went wrong". This is a local learning POC — the message is going to *you*.

---

## 2.6 — Verified with curl · done

No UI yet, on purpose. Everything below was checked against the running server.

### The happy path

A 2,607-character invented handbook (facts no model could know: a "Quiet Hour"
of 13:40–14:40, a Bay 3 freezer at −68°C, a 400-day chemical sample retention):

```
POST /api/documents -> 201
{"id":4,"title":"Northwind Labs Operations Handbook","chunkCount":3}

[ingest] 2607 chars -> 3 chunks
[ingest] embedded 3 chunks, 1536 dims each
```

In the database:

```
chunk 0 | len 1000 | dims 1536
chunk 1 | len 1000 | dims 1536
chunk 2 | len  907 | dims 1536
overlap between chunk 0 and 1 identical: true
```

**F-2 confirmed:** multiple chunks, and text at a boundary appears in two of
them. **F-1 confirmed:** every chunk row has a populated 1536-dimension
embedding.

`GET /api/documents` returned the document with `chunkCount: 3`.

### The failure paths

| Case | Result |
|---|---|
| Empty title | 400 · "A title is required" |
| Whitespace-only content | 400 · "Document content is required" |
| 100,001 characters | 400 · naming both the size and the limit |
| Delete id 999999 | 404 · "No document with id 999999" |
| Delete id `abc` | 400 · "Invalid document id" |

### R-7, deliberately triggered

Forced the embedding call to fail *after* the documents row was inserted, by
pointing the model env var at a name that does not exist:

```
[ingest] "R-7 rollback probe": 37 chars -> 1 chunks
[ingest] failed after creating document 3 - cleaning up
threw as expected: OpenAI does not recognise that model name (HTTP 404)
documents before: 1
documents after : 1
orphan rows left: 0 (rollback OK)
```

**This is the test that matters most in Phase 2**, because a broken rollback
produces no error — just a document that quietly never works.

### The cascade

```
chunks for document 2 before delete: 3
DELETE /api/documents/2 -> 200 {"deleted":true}
chunks for document 2 after  delete: 0 (cascade OK)
```

---

# Phase 3 — Query

**Goal:** the second pipeline. `question → embed → search → prompt → answer`.

This is where RAG stops being plumbing and starts being the thing itself.

---

## 3.1 — Reading real similarity scores · done

**What was done:** before tuning anything, ran `scratch/score-probe.js` — eleven
questions against the Northwind handbook with `min_similarity: 0`, so **nothing
was filtered out** and the whole range of scores was visible.

**Why this order matters.** The roadmap is emphatic: measure, then tune. A
threshold picked from a blog post is a number you cannot defend. A threshold
picked from your own corpus is one you can.

### What came back

| Kind of question | Example | Top score |
|---|---|---|
| Direct hit | "What time is the Quiet Hour?" | **0.536** |
| Direct hit | "What temperature does the Bay 3 freezer run at?" | 0.462 |
| Paraphrased | "Why cannot I use the centrifuge in the early afternoon?" | 0.446 |
| Paraphrased | "Can a candidate on a tour walk into Bay 7?" | 0.401 |
| **Exact identifier** | "extension 4417" | **0.284** |
| Same domain, absent fact | "policy on laboratory safety goggles?" | **0.427** |
| Off topic | "What is the capital of France?" | 0.039 |
| Off topic | "How do I bake sourdough bread?" | 0.076 |
| Off topic | "Explain the offside rule in football." | 0.099 |

### Three findings, each worth more than the number itself

**1. The gap is enormous.** The highest off-topic score is 0.099. The lowest
genuine hit is 0.284. Nothing at all lands between them. Semantic distance
between "questions about this document" and "questions about anything else" is
not subtle — which is why a threshold works at all.

**2. Vector search is bad at exact tokens.** "extension 4417" scored **0.284** —
worse than a vague paraphrase — even though the exact string is in the document.
Embeddings encode *meaning*, and a phone extension has almost none: the digits
4417 mean nothing semantically, so there is little for the model to encode.

> This single row is the entire argument for **hybrid search** (post-MVP #2):
> run a Postgres full-text query alongside the vector query and merge the
> results. Keyword search would score "extension 4417" at the top instantly.
> Vectors are good at meaning and bad at identifiers; keywords are the reverse.

**3. A threshold cannot catch everything — and this is the important one.**
"What is the policy on laboratory safety goggles?" scored **0.427**, squarely in
direct-hit territory. The handbook says **nothing** about goggles. It scored
high because it is the same domain, the same vocabulary, the same register —
a lab-safety question against a lab-safety document.

**No threshold rejects that.** Raise it above 0.427 and you would also reject
every real paraphrase. This is precisely why D-008 describes the short circuit
as *belt and braces* rather than the defence: the second layer, the system
prompt's refusal instruction, is what actually catches this case. Both were
tested in 3.6 below, and each caught a different question.

---

## 3.2 — Tuning `MIN_SIMILARITY` · done · **0.30 → 0.25**

**The planned value was 0.30.** The measurements say that is wrong — it sits
*above* the "extension 4417" score of 0.284, so the system would have refused a
question it demonstrably has the answer to. A false refusal is the quieter of
the two failure modes and the easier to never notice.

**0.25 was chosen** because it sits in the empty gap: 2.5× above the highest
off-topic score (0.099) and comfortably below the weakest true positive (0.284).

```
0.00      0.099          0.25    0.284              0.54
 |----------|--------------|-------|-----------------|
   off-topic          THRESHOLD   weakest real hit  best hit
              <-- empty -->
```

**Q-1 resolved.** The constant carries the measurements in a comment above it,
so the reasoning survives even if the number is later changed.

**The honest caveat:** this was measured on one document and three chunks. The
number is corpus-dependent, and `scratch/score-probe.js` was kept so it can be
re-measured when the documents change.

---

## 3.3 — `buildPrompt()` · done

**What it is:** the function frameworks hide. Twenty lines that assemble the
array sent to the model.

```js
[
  { role: 'system', content: rules + '\n--- CONTEXT ---\n' + chunks + '\n--- END CONTEXT ---' },
  ...history,                       // last 6, oldest first
  { role: 'user', content: question }
]
```

**Read that and the magic disappears.** The retrieved chunks are pasted into the
system message **as plain text**. There is no special knowledge-base channel
into the model, no fine-tuning, no injection into its weights. It is characters
in a string. That is the entire trick.

Three things in it are doing real work:

1. **The context is text.** Chunks are numbered `[1]`, `[2]`, `[3]` so the model
   can refer to them, and fenced with `--- CONTEXT ---` markers so it can tell
   where your data stops and the conversation begins.
2. **The refusal instruction.** Without *"answer using ONLY the context"* and an
   exact string to reply with, the model happily answers from training data and
   you cannot tell the two apart from the outside. Phase 5.5 removes this line
   on purpose to watch it happen.
3. **History is capped at 6.** The entire array is re-uploaded and **re-billed**
   on every single turn, so uncapped history makes cost grow with the square of
   conversation length (D-011).

---

## 3.4 — `answerQuestion()` and `POST /api/chat` · done

The seven steps, in the order the code runs them:

1. **Find or create the conversation** — created lazily on the first message,
   so a browser that has never chatted sends no `conversationId` and gets one back.
2. **Load recent history** — *before* saving this turn, or the question would
   appear in its own context.
3. **Embed the question** — through the same `embed()` as ingest.
4. **Vector search** via `.rpc('match_chunks')`.
5. **Short circuit** if nothing cleared the threshold.
6. **Build the prompt and ask.**
7. **Save both messages; return the answer and its sources.**

### Two details worth knowing

**History is ordered by `id`, not `created_at`.** Both messages in a turn are
written in the same insert, so their timestamps can be identical to the
millisecond — which would leave their order undefined and could feed the model
an answer before its question. `id` is monotonic and cannot tie.

**Document titles need a second query.** `match_chunks` returns `document_id`
but not the title, and the sources panel needs a human-readable label. One
extra `select` on `documents` is simpler than joining inside the SQL function,
and it is what makes a source read *"Northwind Labs Operations Handbook · 0.552"*
rather than *"document 5"*.

### Where the project's #1 constraint is enforced

The question is embedded by the **same `embed()` function reading the same env
var** as the documents were. That is not a coincidence to be maintained by
discipline — it is structural. If the two ever used different models, the
vectors would describe positions in unrelated coordinate spaces, the similarity
numbers would still look perfectly reasonable, and **nothing would error**
(D-004, R-3).

---

## 3.5 — Message persistence · done

Both messages of a turn go in as one insert. The conversation row is created on
the first message of a session.

**One deliberate deviation from the plan.** The flowchart in `architecture.md`
§ 3.2 shows the "save messages" step only on the *answered* branch — the refusal
path returns directly. This implementation **saves refusals too**, because a
transcript with holes in it would make a later follow-up resolve against the
wrong turn:

```
user:      What is the capital of France?
assistant: I don't know based on the documents I have.   <- if this were missing,
user:      What about the second one?                        "the second one" would
                                                             point at the wrong turn
```

Cost is two rows. Recorded in `status.md` rather than left as a silent
difference from the design.

---

## 3.6 — The short circuit, and proof both layers work · done

When `match_chunks` returns nothing above the threshold, the refusal is returned
**directly — OpenAI is never called** (D-008). Faster, free, and it removes any
chance of the model ignoring its instructions.

### Both layers, caught on camera

Two questions, two different mechanisms, identical output to the user:

```
[query] "What is the capital of France?"                 -> 0 chunks
                                            (no [openai] line — never called)

[query] "What is the policy on laboratory safety goggles?" -> 3 chunks  0.427 0.368 0.329
[openai] chat: 673 in + 10 out              (called, and the MODEL refused)
```

**This is the clearest thing to come out of Phase 3.** The first question was
rejected by the *threshold*, before any money was spent. The second sailed past
the threshold at 0.427 and was rejected by the *prompt*. Remove either layer and
one of these two questions gets a wrong answer.

Note the token counts: the refused-by-prompt question still cost 673 input
tokens, because the chunks were retrieved and pasted in before the model
decided it could not use them. The short circuit exists to avoid exactly that.

---

## Verification — what was actually run

### A grounded answer with sources

```
Q: What are the exact hours of the Quiet Hour and why does it exist?

A: The Quiet Hour is observed daily between 13:40 and 14:40 local time. It
   exists because the building shares a foundation with the Kessler
   Seismograph Annex next door, and vibration during the annex's daily
   calibration window corrupts their readings.

sources: 3
  0.552  Northwind Labs Operations Handbook  "ended. The Quiet Hour exists because..."
  0.459  Northwind Labs Operations Handbook  "Northwind Labs — Internal Operations..."
  0.304  Northwind Labs Operations Handbook  "n automatic alert is sent to the on-call..."
```

Both facts are invented and appear nowhere outside the pasted document. **F-7
and F-8 confirmed.**

### Conversation memory (F-9)

```
turn 1  Q: What colours are the visitor badges and what does each one mean?
        A: green for vendors, amber for auditors, and violet for prospective staff.

turn 2  Q: Which of THOSE may not enter Bay 7?          <- no noun at all
        A: Violet badge holders may not enter Bay 7 under any circumstances.
```

Turn 2 has no subject of its own. It resolves only because the previous turn was
re-sent in the `messages` array. **F-9 confirmed.**

### An observed limitation, reported honestly

```
turn 3  Q: And what is the escort ratio for THAT group?
        A: The escort ratio for auditor groups is one to one.
```

**This answer is arguably wrong.** "That group" should refer to the violet-badge
holders established in turn 2, whose ratio is one staff member per three
visitors. The model latched onto the *auditor* exception instead, because that
is the clause in the source sentence that actually names a ratio.

Retrieval was correct — the right chunk was found and supplied. The failure is
in the model's pronoun resolution, not in the pipeline. It is exactly the kind
of thing you only notice when the sources panel lets you check the answer
against the source. Worth revisiting in Phase 5.

### The success criterion — the one that matters

```
BEFORE  Q: What temperature does the Bay 3 freezer run at?
        A: The sample freezer in Bay 3 operates at minus 68 degrees Celsius.
        sources: 3

        DELETE /api/documents/4  ->  {"deleted": true}

AFTER   Q: What temperature does the Bay 3 freezer run at?     (identical question)
        A: I don't know based on the documents I have.
        sources: 0
        [query] ... -> 0 chunks          (and no [openai] line: never called)
```

**This round trip proves all four hard parts at once:** ingestion worked, the
question and the documents are in the same embedding space, retrieval found the
right chunk, and the prompt grounded the answer instead of letting the model
improvise. The "after" half also proves the cascade deleted the chunks, not just
the document row.

### Validation

| Case | Result |
|---|---|
| Whitespace-only message | 400 · "A message is required" |
| 2,001-character message | 400 · naming the size and the limit |
| `conversationId` sent as a number | 400 · "conversationId must be a string" |

`MAX_MESSAGE_LENGTH = 2000` was added at the route boundary. It is not in the
plan, but a question is embedded as a single unit, and anything much longer is a
document pasted into the wrong box.

---

# Phase 4 — The UI

**Goal:** everything that already worked over `curl`, usable in a browser.

**What exists after this phase:** five files in `public/` (~870 lines including
CSS), one new API route, and zero new dependencies. Native HTML, native DOM, no
framework, no bundler, no build step.

---

## 4.0 — The route that was missing · done

`screens.md` § S-2 says clicking a document row expands it to show its chunks.
The route table in `architecture.md` § 5 never lists a route that would return
them. That gap was flagged at the end of Phase 3 and closed here:

```
GET /api/documents/:id/chunks  ->  [{ id, chunk_index, content }]
```

`getChunks()` deliberately does **not** select the `embedding` column. It is
~6 KB per chunk, and a screenful of floats tells you nothing you could act on.

---

## 4.1 — `admin.html` + `admin.js` · done

### The live chunk estimate, and a small piece of design paying off

The admin page shows `1,204 characters · ≈ 2 chunks` as you type. The obvious
way to build that is to copy `CHUNK_SIZE` and `CHUNK_OVERLAP` into the frontend
— and then watch them silently drift out of step with the server the first time
you tune one in Phase 5.

Instead, `server.js` serves the real module to the browser:

```js
app.use('/chunker.js', express.static('src/chunker.js'));
```

and `admin.js` imports it:

```js
import { estimateChunkCount, CHUNK_SIZE, CHUNK_OVERLAP } from './chunker.js';
```

**The same file now runs unchanged in Node and in the browser.** That is only
possible because `chunker.js` is pure — no imports, no I/O, no `process`, no
`fetch`. Architecture chose that constraint for readability; here it pays a
second dividend. The estimate is not an approximation of what the server will
do; it is the identical arithmetic with the identical constants.

### Expanding a row

Clicking a document title fetches its chunks **lazily** — only on first expand,
never on page load — and renders each one with its index and length. Below them:

> *The last 150 characters of each chunk are repeated at the start of the next
> one — that is the overlap.*

Reading your own text sliced up, and seeing the repeat at each boundary, is what
turns chunking from a paragraph in a document into something you have seen.

### The `⚠ 0 chunks` badge

A document with zero chunks is the R-7 orphan: visible in the list, impossible
to retrieve, with nothing to explain why. Ingest now cleans up after itself so
this should never appear — the badge stays anyway, because a symptom you can see
beats one you cannot.

---

## 4.2 — `index.html` + `app.js` · done

### `conversationId` is the entire client-side state

```js
let conversationId = null;
```

That is all the browser remembers. The transcript lives in Postgres, and the
server re-sends the last six messages to the model on every turn. Refreshing the
page starts a new conversation, which is deliberate — listing past conversations
is on the out-of-scope list.

### Enter versus Shift+Enter

The composer is a `<textarea>`, not an `<input>`, precisely so `Shift+Enter` can
insert a newline while `Enter` alone sends (`screens.md` § S-1). It grows with
its content up to a max height in the stylesheet.

### The two frontend rules, enforced

**`textContent`, never `innerHTML`.** Every string that came from the server or
from the model goes into the DOM through `textContent`. Two of those strings are
attacker-influenced in any real deployment: the model's output, and the document
text you pasted in. `textContent` cannot execute anything, and it removes the
entire question. *Verified: zero occurrences of `innerHTML` in `public/` outside
of comments.*

**No markdown rendering** (`mvp.md`). Newlines are handled by CSS
(`white-space: pre-wrap`), not by parsing. If the model emits `**bold**` you see
the asterisks — correct for the MVP.

*Verified: zero `console.log` left in committed frontend code.*

---

## 4.3 — The sources panel · done

A `<details>` element under every answer, collapsed by default, reading
`▸ 3 sources`. Expanded, each source is a card:

```
Northwind Labs Operations Handbook                        0.552
ended. The Quiet Hour exists because the building shares…
```

Clicking a chunk toggles it between two clamped lines and its full text.

**Three decimal places, not two.** The difference between 0.42 and 0.45 is the
difference between a good match and a mediocre one. Rounding that away throws
out the signal you most want while tuning.

**When nothing matched**, the panel is still there and reads *"No matching
chunks above the similarity threshold."* That is a success state, not an error
— it is the system correctly declining — and saying so is what stops it looking
like a bug.

**Why this is a feature and not a debug toggle (D-012):** it is the only way to
distinguish *"the bot read my document"* from *"the model happened to know
this."* Without it, the project's success criterion is unverifiable. It already
earned its place in Phase 3, when it was the sources panel that revealed the
turn-3 pronoun answer was drawn from the right chunk but the wrong sentence.

---

## 4.4 — States and errors · done

Every state in `screens.md` is implemented:

| State | What you see |
|---|---|
| Empty, KB has documents | "Ask a question about your documents." |
| Empty, KB is empty | "Your knowledge base is empty — add a document first" + a link |
| Loading | User message appears at once; assistant bubble reads "Searching the knowledge base…"; input and Send disabled |
| Success | Answer + collapsed sources, scrolled to bottom |
| No relevant context | The refusal, with the "no matching chunks" sources panel |
| OpenAI 429 | "out of credits or rate limited", **with a Retry button** |
| OpenAI 401 | "OpenAI rejected the API key — check .env" |
| Server unreachable | "Cannot reach the server. Is `node server.js` running?" |

**The user's message survives an error.** It stays in the transcript with a
Retry button beside the failure, rather than vanishing along with whatever you
typed.

**The empty-knowledge-base check matters more than it looks.** With no documents
loaded, every question returns the refusal — which looks completely broken if
you do not know why. One `GET /api/documents` on page load turns a mystery into
a sentence.

---

## 4.5 — `style.css` · done

250 lines, hand-written, CSS custom properties for the palette. No framework,
no preprocessor. The layout is a flex column with a scrolling transcript and a
pinned composer.

---

## Verification — what was actually checked

**Static assets**, all served with the right content type:

```
/              200  text/html
/admin.html    200  text/html
/style.css     200  text/css
/app.js        200  application/javascript
/admin.js      200  application/javascript
/chunker.js    200  application/javascript     <- the shared module
```

**Every endpoint the UI calls:**

```
GET  /api/documents             -> 1 document, 3 chunks
GET  /api/documents/:id/chunks  -> 3 chunks
POST /api/chat                  -> 3 sources, correct grounded answer
GET  /api/conversations/:id/messages -> 4 messages
```

**Code checks:** both frontend modules parse as ES modules; no `console.log`
anywhere in `public/`; no `innerHTML` outside comments.

**Verified by the user, in a real browser:** the full walkthrough in
`status.md` — both pages, the sources panel, the live chunk estimate, expanding
chunks, delete, and the success criterion done entirely through the UI with no
curl. Confirmed working 2026-09-20.

---

## A structural limitation found while testing Phase 4

This is the most interesting thing to come out of the phase, and it is not a bug
in the code.

```
turn 1  Q: Who signs off on a 5000 credit equipment request?
        A: The floor supervisor and the Operations Director.        [3 sources]

turn 2  Q: When did they join?
        A: I don't know based on the documents I have.
        [query] "When did they join?" -> 0 chunks
```

**The answer is in the document.** It says Marisol Venn "joined Northwind Labs
in the spring of the third fiscal cycle." So why nothing?

Because **retrieval embeds the raw question and nothing else.** "When did they
join?" has no nouns, no domain vocabulary, no proper names — embedded on its
own it is a vector pointing at nothing in particular, and it scored below the
threshold against every chunk.

The conversation history *is* sent to the model. It is **never sent to the
retriever**. Look at the pipeline and you can see exactly why:

```
history -----------------------------> buildPrompt -> chat model   ✓ has context
question -> embed -> match_chunks ----> buildPrompt                ✗ no context
```

Contrast with turn 2 of the Phase 3 test, *"Which of those may not enter Bay
7?"*, which worked — because "Bay 7" is a strong retrieval anchor all by itself.
The difference between the two is not the pronoun; it is whether the question
contains anything worth searching for.

**The standard fix is query rewriting:** a cheap model call that turns
*"When did they join?"* plus the history into *"When did Marisol Venn join
Northwind Labs?"*, and you retrieve on that instead. It is explicitly post-MVP,
and the naive version is exactly what you need to feel first — which is the
whole argument of D-007 applied to a different knob.

---

# Phase 5 — Understand it

**Goal:** turn each knob to its extremes and watch what breaks. This phase is
the deliverable; Phases 0–4 exist to make it possible.

**The full measured findings are in [`notes.md`](./notes.md).** This section
records how the experiments were run and what changed as a result.

---

## Method

Each configuration ran in a **fresh Node process** via `scratch/experiment.js`,
because the knobs are module constants — a long-running process would keep
serving the first value it imported and every result after the first would be a
lie.

`src/chunker.js` and `src/rag.js` were copied to `scratch/*.bak` before the
first edit and `diff`-verified **byte-identical** after the last restoration.
A post-restore baseline run reproduced the original numbers exactly, which is
the check that actually proves nothing was left behind.

Four questions were used throughout: a direct fact, a two-part question needing
two separate sentences, a same-domain question whose answer is **absent** from
the corpus, and an off-topic question.

---

## 5.1 and 5.2 — chunk size · done

| | 300 | **1000** | 4000 |
|---|---|---|---|
| Chunks | 17 | 3 | **1** |
| `direct` top score | **0.726** | 0.462 | 0.365 |
| `absent` top score | 0.427 | 0.427 | **0.424** |
| Input tokens, 3 answers | **1,198** | 2,026 | 1,807 |

**The roadmap predicted 300 would be worse. It was better** — higher scores and
40% cheaper. A small chunk about exactly one thing produces a vector pointing
exactly at that thing; a 1000-character chunk covering three topics is pulled
toward their average.

**4000 produced the clearest single result of the phase:** at that size the
whole document is one chunk, and the question the corpus *cannot* answer
(0.424) outscored the one it *can* (0.365). The ranking stopped measuring
"does this contain the answer" and started measuring "is this vaguely about
laboratories."

**A knob changed the meaning of another knob.** `CHUNK_OVERLAP` stayed at 150
while size dropped to 300, silently taking overlap from 15% of a chunk to 50%.
Half the corpus stored and embedded twice, from editing a different constant.

---

## 5.3 — `MIN_SIMILARITY` → 0 · done

**Expected nonsense answered with a straight face. Got nonsense retrieved and
then refused anyway.**

```
Q: What is the capital of France?
   chunks: 3   scores: 0.042  0.006  0.006   671 input tokens spent
   A: I don't know based on the documents I have.
```

Three lab-handbook chunks were pasted in as context for a question about France,
and the model read them, found nothing, and followed its instruction.

**This reframed the whole design for me.** The threshold is a **cost gate**, not
a correctness gate — it saves ~671 tokens and a round trip per unanswerable
question. D-008 calls the short circuit "belt and braces"; the braces turn out
to be doing nearly all the work.

---

## 5.4 — `MATCH_COUNT` 1 vs 20 · done

Run against the 17-chunk corpus so that 20 means something.

| | 1 | 5 | 20 |
|---|---|---|---|
| Total input tokens | **424** | 1,198 | **2,257** |
| `two-part` correct | **NO** | yes | yes |

**7× the tokens for answers that were no better** — the chunks at 0.256–0.29
contributed nothing and were billed in full.

### The hallucination

At `MATCH_COUNT = 1`:

> "The Quiet Hour is observed daily between 13:40 and 14:40 local time.
> **It exists because the building requires a period of reduced noise and
> activity.**"

The first sentence is correct. The second is **invented** — the real reason is
the Kessler Seismograph Annex sharing a foundation. The single 300-character
chunk held the hours but not the reason, and the model completed the pattern
rather than admitting the gap.

**The grounding instruction was present and did not stop it.** "Use ONLY the
context" is strong when *nothing* relevant is retrieved and much weaker when
*part* of the answer is there — the model treats the missing half as something
to fill in. Nothing errored; same status code, same confident tone.

**One click on the sources panel shows the reason is not in the chunk.** This is
D-012 earning its keep: without visible sources this is undetectable unless you
already know the document by heart.

---

## 5.5 — Removing the grounding instruction · done

With the threshold still at 0.25, the `absent` question degraded from an exact
refusal to a hedge that began recommending other places to look.

With the threshold **also** at 0 — both guards off, which is what a naive
implementation looks like:

```
Q: What is the capital of France?     scores: 0.042 0.006 0.006
A: The capital of France is Paris.

Q: How do I bake sourdough bread?     scores: 0.076 0.067 0.062
A: [a complete 400-word recipe — ingredients, autolyse, bulk fermentation,
    shaping, proofing, 450°F in a Dutch oven]
```

**A lab-handbook chatbot produced a sourdough recipe while reporting three
chunks of a laboratory operations handbook as its sources.**

The retrieval scores were right there — 0.076 — saying nothing matched. The
system had everything it needed to refuse and refused nothing, because the
instruction to refuse was the only thing that had ever been doing that job.

Both lines were restored and verified immediately afterwards.

---

## 5.6 — What it cost · done

| | Approximate |
|---|---|
| Chat input tokens | ~26,000 |
| Chat output tokens | ~2,000 |
| Embedding tokens | ~6,000 |
| **Total for the entire project** | **under $0.01** |

`costs.md` predicted "well under $1 of the $5 minimum" and was, if anything,
pessimistic by two orders of magnitude.

**The cost intuition worth keeping:** output tokens cost 4× input, but input
dominates completely, because every question re-uploads ~670 tokens of
retrieved context. `MATCH_COUNT` and `CHUNK_SIZE` are the real cost levers in a
RAG system — not the model, and not the length of the question.

*(The authoritative figure is on OpenAI's usage dashboard; the numbers above are
summed from the token counts `chat()` logged on every call.)*

---

## 5.7 — `notes.md` · done

337 lines, every number measured on this build. It also absorbs the two findings
from earlier phases that belong with the rest: **retrieval has no memory**
(history reaches the generator, never the retriever) and **vector search is bad
at exact identifiers** (an exact quoted string scored below a vague paraphrase,
and very nearly caused a false-refusal bug at the originally planned threshold
of 0.30).

It closes with the question the phase exists to answer — why the question and
the documents must share an embedding model, and what happens if they do not.

---

## `README.md` · build instructions added

The repo layout in `CLAUDE.md` asks for a `README.md` with setup steps and how
to run. The existing one was the planning pitch, so the build sections were
**added above it rather than replacing it** — nothing was lost. It now covers
prerequisites, `.env`, running `schema.sql` (including the RLS warning and the
stale-paste trap), starting the server, stopping it on Windows, the five knobs,
and where each piece of code lives.

---

# Where the project stands

| | |
|---|---|
| **Phases complete** | **0, 1, 2, 3, 4, 5**, plus D-015 – D-018 |
| **Progress** | **100%** |
| **Code** | ~1,740 lines: ~690 backend, ~870 frontend, 86 SQL |
| **Documentation** | `notes.md` 337 lines, `whats-done.md`, the planning set |
| **Dependencies** | 3, as planned. Zero in the browser |
| **Success criterion** | **passes**, via curl and in the browser |
| **Total spend** | under $0.01 |
| **Blockers** | none |
| **Git** | initialised, 32 files, `.env` excluded and verified |

**All ten MVP features (F-1 – F-10) are built and verified.** Nothing on the
out-of-scope list was built.

---

## The three things worth remembering

**1. The two guards protect different things, and not the ones you would guess.**
`MIN_SIMILARITY` protects **cost** — removing it produced zero wrong answers,
just wasted tokens. The "use ONLY the context" line protects **correctness** —
removing it produced a sourdough recipe cited to a lab handbook. Tune the wrong
one when the bot starts inventing things and you will get nowhere.

**2. The grounding instruction is weaker than it looks.** It reliably stops the
model answering when *nothing* relevant is retrieved. It is much weaker when
*part* of an answer is present — at `MATCH_COUNT = 1` the model reported the
Quiet Hour's times correctly and invented its reason, with the instruction
fully in place.

**3. Retrieval quality is decided by chunking more than by the model.** Three
different chunk sizes moved the top similarity score from 0.365 to 0.726 on an
identical question, against an identical model, with identical code everywhere
else. At 4000 the ranking inverted entirely.

---

## Files

```
rag-chatbot-poc/
├── .env                 # filled, gitignored
├── .env.example         # committed, empty values
├── .gitignore           # node_modules, .env, scratch/
├── package.json         # "type": "module", 3 deps
├── schema.sql           # extension, 4 tables, 3 indexes, RLS, match_chunks
├── server.js            # 6 routes, validation, error mapping
├── src/
│   ├── chunker.js       # pure - runs in Node AND the browser
│   ├── openai.js        # embed() + chat(), raw fetch
│   ├── supabase.js      # the configured client
│   └── rag.js           # both pipelines, the 5 knobs
├── public/
│   ├── index.html       # S-1 chat
│   ├── admin.html       # S-2 knowledge base
│   ├── app.js           # chat logic, sources panel
│   ├── admin.js         # add / list / delete / expand
│   └── style.css        # hand-written
├── scratch/             # gitignored - the Phase 1 proofs, score-probe,
│                       #   experiment harness, .bak files, server.log
├── notes.md             # Phase 5 findings, measured
├── whats-done.md        # this file
└── README.md, status.md, architecture.md, mvp.md, screens.md,
    techstack.md, decisions.md, risks.md, costs.md, idea-intake.md,
    BUILD.md / CLAUDE.md
```

---

## Post-MVP: hybrid search (D-015) · done

Built on request after Phase 5. Three pieces:

- **`schema-hybrid.sql`** — a GIN index on `to_tsvector('english', content)`,
  a `to_or_tsquery()` helper, and `match_chunks_fts()`. Run once, idempotent.
- **`retrieve()` in `src/rag.js`** — runs both searches in parallel and merges
  them with Reciprocal Rank Fusion.
- **A `vector` / `keyword` / `both` badge** in the sources panel.

**Why RRF.** Cosine similarity and `ts_rank` cannot be compared — different
scales, different distributions. RRF discards both scores and fuses on rank
alone: `score = Σ 1/(60 + rank)`. A chunk both searches found gets two
contributions and rises. No weighting to tune.

**Why `to_or_tsquery`.** `plainto_tsquery` ANDs the terms, so "Who do I contact
on extension 4417?" becomes `contact & extens & 4417` — and the chunk saying
"reachable at extension 4417" has no "contact", so the AND matches nothing and
the exact case keyword search exists for is missed.

**Measured on a 19-chunk corpus, and the result is modest.** For four properly
phrased questions containing identifiers, hybrid changed **nothing** — vector
search already ranked the right chunk #1 or #2. The single clear win was a
**bare identifier typed alone**: `NL-220` was missed entirely by vector-only
(five chunks passed the threshold, none contained it) and rescued at rank #2 by
hybrid.

The 0.284 score that motivated this was measured on a **3-chunk** corpus with
nothing competing. The feature is cheap and additive — zero extra prompt tokens
— but its value scales with corpus size rather than being visible at this one.

---

## Post-MVP: query rewriting (D-016) · done

One cheap model call resolves a follow-up into a standalone search query before
embedding. The **search** uses the rewrite; the **answer** uses the user's
original words.

**Fixed the Phase 4 failure outright:**

```
BEFORE  "When did they join?"  -> 0 chunks -> refusal
AFTER   searched for "When did the floor supervisor and the Operations
        Director join?" -> 3 chunks -> correct answer naming Marisol Venn
```

**Cost, measured:** 3 rewrite calls across a 4-turn conversation, 409 in + 30
out, $0.000079 — **21%** on top of the answers, not the ~100% first estimated.
The rewrite prompt carries only the transcript; the answer prompt carries ~670
tokens of chunks. The real cost is one extra round trip of latency.

**No over-rewriting:** 2 of those 4 turns came back unchanged.

**And the pattern both post-MVP features confirm:** each fixed *retrieval* and
left *generation* alone. Hybrid search delivered the right chunk at rank #1 for
"Who do I contact on extension 4417?" and the model refused. Query rewriting
produced a perfect search query for "what is the escort ratio for that group?"
and the model still answered about the wrong group. **Once retrieval is good,
the remaining errors are prompt problems** — and the sources panel is what
distinguishes them, because you can see the correct chunk sitting there unused.

---

## Post-MVP: rewording the grounding instruction (D-017) · done

The original *"Do not use outside knowledge. Do not guess."* collapsed three
different things into one instruction, and **"do not guess" reads to a model as
"do not reason"** — which is why it refused questions whose answer was in the
retrieved chunk. The new wording separates them: **connecting** stated facts is
allowed, **adding** absent facts never is, and a **partial** answer should say
what is missing.

**Judged with a fixed battery** (`scratch/prompt-eval.js`, six cases, run before
and after), because Phase 5.5 proved this instruction is the only thing
preventing hallucination — a "fix" that loosens it would be a regression.

**4/6 → 5/6, with all three refusal cases holding.** The one-step inference now
works: *"You can contact the Kessler Seismograph Annex liaison at extension
4417."*

**Two things prompting could not fix:**

- **The wrong-antecedent case is a model limit.** Retrieval and rewriting were
  both perfect; `gpt-4o-mini` still quoted the auditor exception. Identical
  prompt on `gpt-4o`: **6/6**. A second prompt attempt gave no improvement and
  was removed rather than kept as dead tokens.
- **The partial-answer clause loses to the pull to finish a sentence.** Under a
  starved retriever (`MATCH_COUNT=1`) both models still invented a reason for
  the Quiet Hour rather than admit the gap. Fixed by retrieving enough context,
  not by wording.

Model left as `gpt-4o-mini` — `gpt-4o` costs ~16× per input token and the gap
showed on one contrived case out of six.

---

## Post-MVP: paragraph-aware chunking (D-018) · done

Phase 5 showed chunking moves retrieval quality more than any other knob, so
this was the change with the most left in it. `chunkText()` now packs **whole
paragraphs** up to a `CHUNK_SIZE` ceiling rather than cutting at a fixed
offset. Sizes unchanged (1000 / 150); the old sliding window survives as the
fallback for oversized paragraphs and for text with no blank lines.

```
Northwind handbook, before : 3 chunks  1000 / 1000 / 907   cut mid-sentence
                     after : 4 chunks   584 / 804 / 720 / 937   all end on a full stop
```

**Re-measured rather than assumed.** Direct-hit scores rose 0.462→0.530,
0.457→0.577, 0.536→0.588, while the absent question stayed at 0.427 and
off-topic stayed under 0.10 — so the band the threshold sits in got **wider**.
`MIN_SIMILARITY` re-checked and left at 0.25. Prompt battery unchanged at 5/6.

**The reason it works:** a chunk is one embedding. One complete idea embeds
cleanly; the tail of one idea plus the head of another embeds as a blur — and a
fixed offset guarantees the second kind at every boundary. On a test document
where a suite's name and its price fell into different chunks, the chunk
holding the **price** scored 0.384 against "what is the nightly rate for the
Presidential Suite?" while the chunk merely naming the suite scored 0.498. The
chunk with the answer ranked below the chunk without it.

**Two things worth keeping:**

- **It only helps where the source has paragraph breaks.** One unbroken wall of
  text still falls back to fixed-size cuts.
- **My first version had a real bug** — the carried overlap tail was emitted as
  a chunk of its own, so 1001 characters with no breaks gave 3 chunks where the
  old splitter gave 2. Caught only by diffing the new output against the old on
  identical input. A regression check now covers it, on a function pure enough
  that it looked obviously correct.

⚠ **Documents ingested before this change keep their old chunks.** Changing the
chunker does not touch what is already stored — delete and re-add.

---

## What is left — all optional

2. **Decide whether `gpt-4o` is worth ~16× the input cost** — 6/6 on the
   prompt battery versus 5/6 for `gpt-4o-mini` (D-017). One env var. — the most user-visible gap. One cheap model call turns
   "When did they join?" plus history into a standalone query before embedding.
4. **Re-measure `MIN_SIMILARITY`** on a corpus that is not three chunks of one
   invented document.
5. **Paragraph-aware chunking** — 5.1 showed smaller retrieves better, 5.4
   showed too-small cuts answers in half. Splitting on structure gets the first
   without the second.
6. **Streaming**, purely for the feel of it.

**If this is ever deployed, two notes become blockers:** R-1 (the API key) and
R-2 (RLS is enabled but has no policies; `service_role` bypasses it entirely).
