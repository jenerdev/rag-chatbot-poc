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
> Last updated: 2026-09-22.

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
| **Phases complete** | **0, 1, 2, 3, 4, 5**, plus D-015 – D-019 |
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

## Post-MVP: streaming responses (D-019) · done

`POST /api/chat` streams as Server-Sent Events when the client sends
`Accept: text/event-stream`, and returns the original JSON otherwise — so every
curl example in the docs still works. Reverses D-010, which kept streaming out
of the MVP so the route stayed readable while being learned.

```
streamed : sources on screen 1,381ms | first word 2,013ms | done 2,651ms
blocking : nothing at all until 2,353ms
```

**Something useful appears 1.7× sooner**, for identical tokens and identical
cost. The best part is not the typing effect: the `meta` event fires before the
model has written anything, so the sources panel is readable *while* the answer
is being generated.

**Three things that made it harder than it looks:**

- **A network chunk does not respect event boundaries.** Both server and
  browser buffer and process only up to the last blank line. Assuming one
  chunk equals one event works until it doesn't, then fails intermittently.
- **Errors after the headers are sent cannot use a status code.** The response
  is committed to 200, so failures travel down the stream as an `error` event.
  Validation errors still return 400, since they happen first.
- **`req.accepts()` honours wildcards and curl sends `*/*`.** Every curl was
  being handed a stream it could not parse. Caught in testing; now an explicit
  header check.

`answerQuestion()` and `answerQuestionStream()` share `prepareAnswer()` rather
than keeping two copies of the pipeline — a retrieval fix applied to one of two
near-identical functions is a bug nobody finds.

---

## `flow.md` · the implemented flow, diagrammed

`architecture.md` § 3 has the original MVP pipelines, which by this point were
three features out of date. [`flow.md`](./flow.md) documents the flow **as
built**:

1. **System overview** — browser, Express, OpenAI and Postgres, including the
   dotted line showing `chunker.js` being served to the browser.
2. **Ingest sequence** — paste → chunk → embed → store, with the R-7 rollback.
3. **Query sequence** — rewrite → embed → two parallel searches → RRF → gate →
   stream, with the same flow written out in eleven numbered sentences.
4. **A where-it-goes-wrong map** — which stage to suspect for each failure
   mode measured in Phase 5, and the rule of thumb: sources irrelevant means a
   retrieval problem, sources correct means a generation problem.
5. **The route table and the seven knobs.**

Every box names the file and function behind it, so it can be read with the
source open. `architecture.md` § 3 now carries a pointer saying its diagrams
are the original design.

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

---

# Migration to Next.js + TypeScript (Turborepo)

Planned in [`plan/steps.md`](./plan/steps.md) — 8 phases. The POC is finished;
this is the port, not new features.

## Migration plan written · done

An 8-phase plan with one rule at the top: **port, do not improve.** Every
constant in the pipeline — `CHUNK_SIZE` 1000, `CHUNK_OVERLAP` 150,
`MIN_SIMILARITY` 0.25, `MATCH_COUNT` 5, `RRF_K` 60, `MAX_HISTORY` 6, the
`buildPrompt()` wording — was set by measurement in Phase 5, and changing any of
them *during* the port destroys the only available proof that the port worked: a
before/after run of the same eval battery on the same corpus.

**Why that rule needed to be written down.** A TypeScript port invites tidying,
and the things most inviting to tidy here are exactly the ones that took
measurement to get right. D-017's grounding line reads like it could be
shortened. `req.accepts()` reads like the polite version of the explicit header
check. Both would pass review and both would be wrong.

The five traps identified, each with the mitigation in the phase where it bites:

| Trap | Why it matters | Where |
|---|---|---|
| The `service_role` key can reach the browser | Next.js has no server/client boundary by default. A `NEXT_PUBLIC_` prefix or one import from a Client Component inlines a master key into the bundle. `import 'server-only'` makes it a build error | Phase 3 |
| SSE is not `res.write()` | Route Handlers return a `Response`, so the stream becomes a `ReadableStream`. Four details must survive: the explicit `Accept` check, `X-Accel-Buffering: no`, the abort guard, and the two-delivery contract | Phase 5 |
| The `chunker.js` static-serve hack | Disappears — it becomes an ordinary workspace import, which is a genuine improvement, not a loss | Phase 6 |
| The eval corpus was gitignored | See below. Fixed first | Phase 0 |
| Turbo caches against declared env vars only | An undeclared `SUPABASE_URL` means a cached build can silently point at the wrong project | Phase 1 |

## Phase 0 — baseline · done, except the measurement

### 1. The eval corpus was not in version control

`tools/prompt-eval.js` asserts on six cases, and three of them name facts —
the Bay 3 freezer temperature, extension 4417, the violet badge escort ratio —
that exist in exactly one document: the Northwind Labs handbook. That document
lived only in `scratch/testdoc.json`, and `.gitignore` excludes `scratch/`.

**What that means in practice.** `CLAUDE.md` says *"Re-run `npm run eval` after
any edit to `buildPrompt()`"*, and calls that prompt the only thing separating a
grounded answer from a confident invention. The command enforcing that rule
could not be run from a fresh clone of this repo, and was one `git clean -fdx`
from being unrunnable here.

Copied to `fixtures/northwind.json` and committed. **2,607 characters** —
matching the figure at the top of `notes.md`, which confirms it is the same
document every measured number in that file came from. `fixtures/README.md`
records why it is committed and why only one corpus may be loaded at a time.

### 2. `todo.txt` moved out of `sample-documents/`

It sat in a folder whose own README says *"paste each one into the admin page as
a separate document"*, next to eight files that are meant to be pasted. It is a
list of future product ideas. Moved to `todo.md` at the repo root.

### 3. The measurement — deferred, deliberately

`plan/baseline/eval-before.txt` and `scores-before.txt` do not exist yet.

Capturing them requires the database to hold the Northwind handbook **and
nothing else**, and it currently holds the eight Villa Amihan documents. The two
cannot be loaded at once for this purpose: `03-amenities-and-facilities.md`
documents the resort's parking, so the eval case `absent-2` — *"How many parking
spaces does the building have?"*, which exists to prove that a plausible but
absent fact is still refused — would receive a genuine, correct answer and be
scored a **failure**. The battery would report a regression that is not one.

Clearing the corpus is fully reversible (the eight source files are in
`sample-documents/`), but it is the user's data and the call was to leave it.
Recorded as the one open blocker on migration Phase 4, with the exact commands,
in `plan/baseline/db-state.md`.

### 4. What was observed instead

Read-only, against project `jkpdxolpydnenxeljmln`:

| | |
|---|---|
| `documents` / `chunks` | 8 / 30 — 3.75 chunks per document at 1000/150 |
| `conversations` / `messages` | 150 / 428 |
| Loaded corpus | Villa Amihan, ingested 2026-09-19, ids 27–34 |
| node / npm | v24.19.0 / 11.17.0 |
| express / supabase-js / dotenv | 4.22.3 / 2.116.0 / 16.6.1 |
| Models | `gpt-4o-mini`, `text-embedding-3-small` |

**The one finding worth carrying forward:** selecting `embedding` from `chunks`
returns a **string**, which parses to exactly 1,536 numbers.

This is *not* the trap in `CLAUDE.md` § 5. The column is a real `vector(1536)` —
a text column could not be ordered by `<=>`, and `match_chunks` does exactly
that. What is a string is only PostgREST's JSON serialisation of the vector type
on the way out, and nothing in `rag.js` ever reads a vector back: every
comparison happens inside Postgres.

It matters in migration Phase 3, because `supabase gen types typescript` will
type that column `string`. Changing it to `number[]` to make the types look
right would be a lie the compiler accepts and the runtime does not — which is
precisely the failure mode TypeScript is being adopted to prevent.

### What Phase 0 proves

That the migration is now falsifiable in principle — the corpus exists in git,
the versions are recorded, the database state is written down — and that it is
not yet falsifiable in practice, because the numbers have not been taken. The
distinction is recorded rather than glossed, because "the command succeeded" is
not "the effect happened", and a plan that claims a baseline it does not have is
worse than one that says plainly where the gap is.

## Phase 1 — workspace skeleton · done

The POC now lives at `apps/legacy-poc/` inside a pnpm + Turborepo workspace, and
runs there unchanged.

### What was built

| | |
|---|---|
| `pnpm-workspace.yaml` | `apps/*`, `packages/*` |
| `turbo.json` | seven tasks; `globalEnv` naming all five secrets plus `PORT` |
| `package.json` (root) | workspace scripts only — `dev`, `build`, `lint`, `typecheck`, `test`, `eval`, `scores` |
| `packages/tsconfig` | `@rag/tsconfig` — `base.json` (strict, `moduleResolution: bundler`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`) and `node-library.json` |
| `apps/legacy-poc/` | `server.js`, `src/`, `public/`, `tools/`, both `.sql` files |

Every file moved with `git mv`; git recorded all 15 as 100% renames, so
`git log --follow` on `rag.js` still reaches the commit that wrote it.

### Verified, not assumed

Server started from its new home with `pnpm --filter legacy-poc start`:

| Check | Result |
|---|---|
| `GET /` , `/admin.html`, `/style.css` | 200 |
| `GET /chunker.js` | 200 — the `express.static` hack still works from the new path |
| `GET /api/documents` | the eight Villa Amihan documents, with chunk counts |
| Boot banner | both model names printed, so env loading works from the new cwd |
| `express` / `@supabase/supabase-js` / `dotenv` | 4.22.3 / 2.116.0 / 16.6.1 — **identical to the Phase 0 baseline**, so switching package manager did not move the dependency graph |
| `node --check` on both tools | clean |
| All nine frozen constants, read out of the moved modules | `CHUNK_SIZE` 1000, `CHUNK_OVERLAP` 150, `MATCH_COUNT` 5, `CANDIDATE_COUNT` 10, `RRF_K` 60, `MIN_SIMILARITY` 0.25, `MAX_HISTORY` 6, `REWRITE_MAX_TOKENS` 60, `NO_ANSWER` exact — all match § 0 of `plan/steps.md` |

### The blocker this turned up: the OpenAI key has expired

The end-to-end check — one real question against the loaded corpus — returned:

```
HTTP/1.1 401 Unauthorized
{"error":"OpenAI rejected the API key — check OPENAI_API_KEY in .env (HTTP 401):
 Your API key has expired. Create a new API key to continue."}
```

**This is not caused by the move.** The opposite: it is proof the move worked.
The key was read from `.env` at the new path, sent to OpenAI, and rejected *as
expired* rather than as missing — which means env loading, the route, the
pipeline and `openai.js` all functioned. It also exercised the error map end to
end: an upstream 401 arrived at the client as a 401 carrying the real upstream
sentence, exactly as `architecture.md` § 9 specifies and with no swallowing.

Supabase is unaffected — `/api/documents` returns real rows.

**What it blocks:** everything that calls OpenAI. That includes the Phase 0
baseline, which was already deferred, and Phase 4's verification, which depends
on it. Replacing `OPENAI_API_KEY` in `.env` is now on the critical path for the
migration, not just for using the app.

### Three deviations from the plan, with reasoning

**1. pnpm 12.5.1, not pnpm 9.** `corepack enable pnpm` installs what corepack
ships, which is 12.5.1. No reason to pin backwards; `packageManager` in the root
`package.json` now pins it so every machine gets the same one.

**2. The fixture stays at `fixtures/` in the repo root.** The plan said to move
it next to `legacy-poc`. It is a data file that *no code reads* — the corpus is
loaded by a human running `curl -d @fixtures/northwind.json`, and
`prompt-eval.js` only assumes the result is in the database. Moving it now means
moving it again at Phase 4 and editing the path in three documents twice, for no
gain. It moves once, to `packages/rag/fixtures/`, when there is a package that
actually reads it.

**3. `--env-file=../../.env`, rather than moving or copying `.env`.** The POC
calls `import 'dotenv/config'`, which resolves `.env` relative to the working
directory — and pnpm runs each package's scripts from the package directory, so
the POC would have found nothing. The options were: edit `server.js` (breaks
"moved unchanged"), copy `.env` into the app (two files holding the same secrets,
free to drift), or load it from the launcher. The launcher wins: every source
file is byte-identical to what it was, the secret exists once, and Node's
`--env-file` takes precedence because dotenv does not override variables that are
already set. It is also a preview of Phase 4, where `--env-file` removes the
`dotenv` dependency outright.

### Also updated, so the docs stop lying

`README.md`, `CLAUDE.md` and `BUILD.md` all describe `src/rag.js` and
`schema.sql` at the repo root, and `CLAUDE.md` forbids TypeScript and
frameworks. Rather than rewrite them now — Phase 7's job, when there is one
stack to describe — each carries a banner saying which parts are now historical
and which still bind. The two rules called out as binding *harder* during a port
are the ones a port is most likely to erode: the key never reaches the browser,
and `pnpm eval` is re-run after any change to `buildPrompt()`.

## Phase 2 — `@rag/chunker` and `@rag/openai` · done

The two leaf modules are TypeScript. The chunker is proven byte-identical to the
JavaScript it was ported from; the OpenAI client typechecks and its error
contract is verified against the live API.

### `@rag/chunker` — proven, not reviewed

`tools/parity.mjs` runs the old chunker and the new one over the same inputs and
compares with `JSON.stringify`:

| | |
|---|---|
| Documents | **17** — the 8 `sample-documents/*.md`, the Northwind fixture, and 8 synthetic shapes |
| Configurations | **4** — defaults (1000/150), 300/50 and 4000/150 (the two Phase 5 measured), and 1000/0 |
| Also compared | `estimateChunkCount` on every document, plus `CHUNK_SIZE` and `CHUNK_OVERLAP` themselves |
| Result | **87 comparisons, 0 differences** |

The synthetic shapes exist because no real document in the repo exercises the
branches most likely to break: empty and whitespace-only input, a 3,500-character
wall with no blank lines (the D-018 sliding-window fallback), a heading followed
by an oversized paragraph (the special case that stops `# Refund Policy` being
emitted as its own 15-character chunk), six 300-character paragraphs (where the
overlap gets dropped), CRLF line endings, and multi-byte characters.

**Why this was worth building rather than reading the diff.** A chunk boundary
that moves by one character changes what gets embedded, which changes every
similarity score downstream. That would surface in Phase 4 as a drifted eval
number with no obvious cause, days after the change that caused it. The constants
are compared for the same reason: a chunker that behaves identically but exports
`CHUNK_SIZE = 900` passes every behavioural test and silently re-chunks the next
document differently from the 30 chunks already in the database.

Also added: **13 vitest cases** stating what the chunker is *supposed* to do.
The parity script dies with `apps/legacy-poc` at Phase 7; these outlive it.

### `@rag/chunker` has no dependencies, and now cannot have any

In the POC, "this file has no imports" was a convention held up by a comment and
by `server.js` serving the file straight to the browser. It is now an empty
`dependencies` block in a package manifest. The rule became checkable at exactly
the moment the mechanism enforcing it was removed.

### `@rag/openai` — one real change, and it is the typed error

The JS attached `status` to a plain `Error` after construction. It is now an
`OpenAIError` class with `readonly status: number`. Behaviour is identical —
same message text, same property — but the error map in the web app
(`401 and 429 pass through, >= 500 becomes 502`) is built entirely on that
property, and leaving it untyped would leave the one part of the contract that
matters unchecked.

Everything else is the same code: raw `fetch`, no SDK (D-002), the sort by
`index` rather than trusting response order, the SSE buffering across network
chunk boundaries, and the `sawDone` guard that refuses to present a truncated
stream as a complete answer.

Response bodies are cast at the boundary (`as EmbeddingsResponse`) rather than
validated. That is honest about what is happening — a cast is a claim about
someone else's JSON, and pretending otherwise would need a schema validator this
package has no business depending on.

### The 1536 check is still blocked, but the failure verified something

`embed(['hello'])` against the live API:

```
threw       : OpenAIError
instanceof OpenAIError: true
status      : 401 (typeof number)
message     : OpenAI rejected the API key — check OPENAI_API_KEY in .env
              (HTTP 401): Your API key has been invalidated.
```

Note the upstream sentence **changed** — 2026-09-21 it read *"Your API key has
expired. Create a new API key to continue."*, today *"Your API key has been
invalidated."* Same 401; OpenAI's own wording differs. Recording both, because
the next person to read this will otherwise wonder which one they should expect.

The success path — an embedding of length 1536 — remains unverified and is
carried forward. What the failure *did* prove is the contract the entire route
layer depends on: the thrown value is an `OpenAIError`, `status` is the number
`401` rather than a string, and the message is formatted exactly as the JS
version formatted it.

### One build-system fix worth remembering

`rootDir` and `outDir` in `@rag/tsconfig/node-library.json` resolved relative to
**that file's** directory, not the package extending it:

```
error TS6059: File '.../packages/chunker/src/index.ts' is not under
rootDir '.../packages/tsconfig/src'
```

Relative paths in an extended tsconfig always resolve against the config that
declares them. So the shared config now holds only path-independent options, and
each package declares its own `outDir`/`rootDir`. Same rule applies to `include`.

Two smaller ones: pnpm 12 refuses to run a dependency's install scripts until
explicitly allowed, so `esbuild` (vitest's compiler) is approved in
`pnpm-workspace.yaml` with a note on why. And on Windows, `import()` of an
absolute path reads `C:` as a URL scheme — the parity script uses
`pathToFileURL`.

### Verification summary

| Command | Result |
|---|---|
| `pnpm build` | 2 packages, clean |
| `pnpm typecheck` | 2 packages, clean |
| `pnpm test` | 13 passed |
| `pnpm --filter @rag/chunker parity` | 87 comparisons, 0 differences |
| `embed(['hello'])` → 1536 | **blocked** — invalid API key |

## Phase 3 — `@rag/db` · done

One typed client, the schema moved into the package that owns it, and the
service-role key made structurally unable to reach a browser.

### Tenancy: decided, single tenant

`plan/steps.md` § Phase 3 called this the last cheap moment to add `tenant_id`.
Asked and answered on 2026-09-22: **no**. The port stays a port, which keeps the
Phase 4 eval comparison meaningful. Multi-tenancy becomes its own plan after
Phase 7 — and it now carries a known, accepted cost: a backfill plus a rewrite of
every query and both SQL functions, with the filter pushed *inside*
`match_chunks` so it stays indexable.

### The guard is real, and it has a price that was measured

`src/client.ts` opens with `import 'server-only'`. Verified both directions
rather than assumed:

```
node                             -> This module cannot be imported from a Client
                                    Component module.
node --conditions=react-server   -> imports fine; exports supabase,
                                    parseStoredVector, VECTOR_DIMENSIONS
```

So a Client Component importing `@rag/db` fails **at build time** instead of
inlining a key that bypasses RLS entirely into a bundle served to every visitor.

**The cost, found by testing rather than by reading about it:** a plain Node
process has no `react-server` condition either, so `import 'server-only'` throws
there too. Any script importing this package must run with
`node --conditions=react-server`.

That matters more than it first looks. `CLAUDE.md` names `npm run eval` as the
gate on every `buildPrompt()` change, and from Phase 4 those tools import the
pipeline, which imports this package. **So `pnpm eval` and `pnpm scores` will
need that flag**, or the battery stops running — and a gate that does not run is
not a gate. Recorded here, in `packages/db/README.md`, and in the plan, because
the failure mode is a confusing module error in a tool nobody expected to break.

The alternative — dropping `server-only` and relying on discipline — was
rejected. Discipline is what the POC had, and it worked only because Express
made the boundary physical.

### The types are hand-written, and why that is not laziness

The plan called for `supabase gen types typescript`. It needs either a personal
access token (`supabase login`, interactive) or a database URL, and the direct
host is gone:

```
getaddrinfo ENOTFOUND db.jkpdxolpydnenxeljmln.supabase.co
```

Supabase serves direct connections over IPv6 only now; reaching the database
from a script means the connection pooler, whose hostname carries a region this
repo never recorded.

So `src/database.types.ts` is written from `sql/schema.sql` and
`sql/schema-hybrid.sql` — which are committed, are what actually ran, and are
already the source of truth this project treats as authoritative. The file's
header carries the regeneration command and says to **diff** the result rather
than trust either copy blindly.

Writing them by hand forced two things a generator would have decided silently:

**1. The vector column is typed `string`.** Phase 0 observed that a
`vector(1536)` comes back from PostgREST as a string that parses to 1,536
numbers. The type now says `StoredVector = string` for reads and
`VectorInput = number[] | string` for writes. Typing it `number[]` because that
is what it "should" be would be a lie the compiler accepts and the runtime does
not — exactly the failure mode TypeScript is here to prevent.

**2. `id` on the three identity tables is `id?: never` in Insert.** They are
`generated always as identity`; Postgres rejects a supplied value. A generator
would have written `id?: number` and left a foot-gun typed as legal.

### The verification does not need an OpenAI key

`pnpm --filter @rag/db verify` — **10 checks, all passing**:

| Check | Observed |
|---|---|
| `documents` / `chunks` / `conversations` / `messages` readable | 8 / 30 / 153 / 428 rows |
| Embedding arrives as a string | `typeof string` |
| Parses to finite numbers | 1536 dims |
| `match_chunks` rows match `MatchRow` | shape ok |
| A chunk is its own nearest neighbour | chunk 106, top 106 |
| **Self-similarity is 1** | **1.000000** |
| Ordered most-similar first | 1.000 > 0.757 > 0.655 |

The query vector is an embedding **already in the database**, so the whole run
costs nothing and needs no API key — which is why Phase 3 could proceed while
the OpenAI key is still invalid.

**The sharpest check is the cheapest one.** A chunk searched against its own
embedding must return itself at similarity exactly 1. If the vector had been
stored into a text column by accident — `CLAUDE.md` § 5, the failure that
produces no error at all — that number would not be 1, and nothing else in the
system would have complained. `1.000000` is the proof that the column is a real
vector and that `<=>` is doing vector arithmetic on it.

Note `conversations` is now 153, up from 150 at Phase 0: the three chat attempts
made during Phases 1 and 2 each created a conversation row before the OpenAI
call failed. Harmless, and a small reminder that the conversation row is created
before anything can fail (`rag.js` step 1).

### What is in the package

| Path | |
|---|---|
| `sql/schema.sql`, `sql/schema-hybrid.sql` | moved with `git mv`, unchanged |
| `src/client.ts` | the POC's `supabase.js` verbatim, plus the guard and `createClient<Database>` |
| `src/database.types.ts` | hand-written; 4 tables, 3 functions |
| `src/index.ts` | `MatchRow`, `FtsRow`, `parseStoredVector`, `VECTOR_DIMENSIONS` |
| `tools/verify.mjs` | the 10 checks |
| `README.md` | the guard's cost, and the two schema facts that are expensive to get wrong |

`parseStoredVector()` is the runtime guard the plan asked for. Nothing in the
pipeline reads an embedding back today — every comparison happens inside
Postgres, which is the point of `match_chunks` — so it earns its place by being
what the verification script uses, and by existing before the first piece of
code that needs one has to invent it in a hurry.

## Phase 4 — `@rag/pipeline` · code complete, verification partial

The 645 lines of `rag.js` are TypeScript, split five ways. **This phase is not
closed**: the check that defines it — `pnpm eval` matching the baseline — cannot
run while the API key is invalid.

### The split

| File | From `rag.js` | Holds |
|---|---|---|
| `constants.ts` | 152–203 | the seven knobs, collected rather than scattered |
| `types.ts` | (new) | `Source`, `Answer`, `StreamMeta`, `FoundBy`, `HistoryMessage`, `RetrievedChunk` |
| `ingest.ts` | 28–143 | `ingestDocument`, `listDocuments`, `deleteDocument`, `getChunks` |
| `prompt.ts` | 213–263 | `buildPrompt` |
| `retrieve.ts` | 301–436 | `rewriteQuestion`, `retrieve` |
| `answer.ts` | 461–645 | `prepareAnswer`, `answerQuestion`, `answerQuestionStream`, `saveMessages`, `getMessages` |

`constants.ts` exists because the convention in `CLAUDE.md` — every knob at the
top of its module, in SCREAMING_SNAKE_CASE, so the dials are findable — would
have been destroyed by splitting one file into five. Collecting them preserves
the property that made the convention worth having.

The types in `types.ts` existed before as whatever properties an object literal
happened to carry, described in a JSDoc block and enforced by nothing. They are
the contract between the pipeline and both screens, so they now have names.

### What was proved, without an API key

`pnpm --filter @rag/pipeline parity` — **22 comparisons, 0 differences**,
running the old `rag.js` and the new package against identical inputs:

| Covered | How |
|---|---|
| All seven constants | compared by value, because a drifted constant changes retrieval without changing any logic |
| `buildPrompt` | 4 inputs: no chunks, one chunk, five chunks with history, and content full of newlines, quotes and unicode |
| `retrieve` | 7 queries against the live database |
| `listDocuments`, `getChunks`, `getMessages` | live reads, compared exactly |

**The `retrieve` coverage is the part worth having.** The query vector is an
embedding already stored in a chunk row, so the whole run is free and needs no
OpenAI. The seven queries deliberately produce different shapes, and the two
implementations agreed on every one:

```
"What is the Wi-Fi password?"        vector:10 keyword:3  -> both both vector vector vector
"extension 4417"                     vector:10 keyword:4  -> both both vector keyword vector
"What is the capital of France?"     vector:10 keyword:0  -> vector vector vector vector vector
"pool refill time and early check-in" vector:10 keyword:10 -> both both both both vector
```

That exercises RRF fusion with both lists populated, with one list empty, and
with a chunk rescued by keyword search alone — which is D-015's entire reason
for existing, and the part of the port where a subtle mistake would have been
invisible until a user asked about an identifier.

### What is NOT proved, stated plainly

`ingestDocument`, `rewriteQuestion`, `answerQuestion` and `answerQuestionStream`
call OpenAI. The key is still invalid — a **third** distinct message today:

```
2026-09-21  Your API key has expired. Create a new API key to continue.
2026-09-22  Your API key has been invalidated.
2026-09-22  Incorrect API key provided: sk-proj-****6DwA
```

`pnpm eval` and `pnpm scores` were run anyway, and the result is worth recording
because of *where* they fail:

```
at embed          (packages/openai/dist/index.js)
at prepareAnswer  (packages/rag/dist/answer.js:53)
at answerQuestion (packages/rag/dist/answer.js:94)
at                (packages/rag/tools/prompt-eval.mjs:73)
```

Every module resolved, `server-only` loaded, the pipeline ran, and the first
thing to fail was the OpenAI call. **That proves the wiring and nothing about
the behaviour** — which is exactly the distinction this project keeps insisting
on, and the reason the phase stays open rather than being marked done.

### The tools were ported by changing only their imports

`diff` between the old `prompt-eval.js` and the new `prompt-eval.mjs` is two
hunks: the header comment and the import block. The six cases, the multi-turn
loop and the scoring are byte-identical. That is deliberate — the battery is the
gate on `buildPrompt`, and a gate that was rewritten at the same time as the
thing it guards is not a gate.

They are `.mjs`, not `.ts`. The plan said `.ts`; they are scripts rather than
library code, `packages/db` and `packages/chunker` already carry `.mjs` tools,
and making them TypeScript would have meant contorting `rootDir` to emit
`dist/tools/` alongside `dist/index.js` for no benefit.

**Both carry `--conditions=react-server`**, the cost recorded in Phase 3.
Without it `@rag/db` refuses to load and the battery cannot run at all.

### One fidelity slip, caught by reading an error dump

The first run printed `partial: undefined` on every `OpenAIError`. Under
`target: ES2022` TypeScript compiles a declared class field into a
`defineProperty` in the constructor, so `readonly partial?: string` gave every
error an own property set to `undefined` — where the JS original left it absent
entirely.

Harmless to the code that reads it (`typeof x === 'string'` is false either
way), but it is a difference from the original, and it would appear in every
logged stack trace. Changed to `declare readonly partial?: string`, which emits
nothing. Verified:

```
own properties: status, name
has partial   : false
```

Small, but it is the kind of thing that makes "identical behaviour" either true
or nearly true, and nearly true is what this whole phase is trying to avoid.

## Phase 5 — API routes · done

The six endpoints are Next.js Route Handlers, and the proof is not a reading of
the diff: the Express POC ran on **:3099** and the Next app on **:3000** at the
same time, and every response was compared.

### 24 comparisons, 0 differences

`pnpm --filter web parity` hits both servers with identical requests:

| Group | Cases |
|---|---|
| Reads | `GET /api/documents`, `GET /api/documents/34/chunks` — full body equality, not shape |
| Document validation | missing body, missing title, blank title, missing content, blank content, over-length content, non-string title |
| Id handling | `abc`, `0`, `-5`, a valid-but-absent id, on both DELETE and chunks |
| Chat validation | missing message, blank message, over-length message, non-string conversationId |
| The error map | a valid question → upstream 401 reaching the client as a 401 |
| Content negotiation | `Accept: */*` and `application/json` both get JSON |
| Streaming | `Accept: text/event-stream` → 200, `X-Accel-Buffering: no`, failure as an `error` event |

Body equality matters as much as status equality, because the screens render
the `error` string verbatim. `"Document is 100001 characters; the limit is
100000"` still tells a user exactly how much to cut.

### The dead API key turned out to be a test fixture

Two of the hardest parts of this phase are normally awkward to test, and an
invalid key exercises both for free:

- **An upstream 401 must reach the client as a 401**, not as a 500, carrying
  OpenAI's own sentence. That is the error map working end to end.
- **A failure after the headers have gone out cannot use a status code.** The
  SSE response is already a 200, so the failure has to travel down the stream
  as data. Both servers produced exactly that:

```
legacy   200 text/event-stream  events=[error]
next     200 text/event-stream  events=[error]
   OpenAI rejected the API key — check OPENAI_API_KEY in .env (HTTP 401): ...
```

Identical wording, identical delivery. A client that ignores `error` events
would show a half-answer as a whole one — which is why the client must treat
one as seriously as a bad status.

### The regression I introduced, and how it surfaced

The env check started as a throw at module scope, mirroring the POC's
`process.exit(1)` as closely as Next allows. Testing it with an empty
`OPENAI_API_KEY` showed the problem:

```
HTTP 500
<!DOCTYPE html>…<h1>500</h1><h2>Internal Server Error.</h2>…
```

**A module that throws while loading never finishes loading**, so the handler
it exports never exists, so `withRoute` never runs. The real message reached
the server log and nothing else — precisely the generic "something went wrong"
that `architecture.md` § 9 forbids.

Fixed by splitting the two jobs the POC's single check was doing: the missing
variables are logged **at import** (one line, immediately, as § 8 wants) and
`assertEnv()` throws **per request** inside `withRoute`, so the message reaches
the client (as § 9 wants). Now:

```
HTTP 500
{"error":"Missing required environment variable(s): OPENAI_API_KEY. Copy .env.example to .env and fill it in."}
```

Worth recording because it is a failure mode the POC could not have: Express
had one boot moment, and Next has none.

### Decisions this phase forced

**`withRoute` must wrap every handler, by hand.** Express called its error
middleware for anything that threw; Route Handlers have no equivalent. One
unwrapped handler and that route answers with Next's generic 500 instead of the
real reason. There is no way to enforce this in the type system — it is a
review item, and it is in `apps/web/README.md`.

**`lib/limits.ts` is separate from `lib/env.ts`.** The admin page renders a live
character count against `MAX_CONTENT_LENGTH`, so a Client Component has to
import it — and importing anything from a `server-only` module fails the build,
correctly. This is the line the monorepo makes explicit: values the browser may
know, apart from values it may not. It also removes the POC's
`// must match server.js` duplication, the second of the two warts this
migration deletes.

**zod at the boundary (D-022).** The hand-written `typeof` ladder was right for
a three-dependency learning build. With two clients, a streaming route and types
to keep honest, a schema that produces the parsed *type* as well as the check is
worth one dependency. The error strings are copied character for character,
because they are part of the contract.

**The root `.env` is loaded by `next.config.mjs`.** Next reads `.env` from the
Next project root, which is `apps/web`; the secrets live at the repo root where
the POC, the eval tools and the db verification all read them. Copying them
would mean two files holding the same key, free to drift, and two places to
revoke when one leaks.

### Still unverified

Everything that needs a working key: a real ingest, a real grounded answer, a
real stream of deltas. The routes are proven to carry a failure correctly; they
are not yet proven to carry an answer.

## Phase 6 — the two screens · built, not signed off

`screens.md` S-1 and S-2 are React. They compile, render and serve. **Nobody has
clicked them yet**, so this phase is marked built rather than done.

### What was ported

| From | To | Lines |
|---|---|---|
| `public/index.html` + `app.js` | `app/page.tsx` | 439 → ~330 |
| `public/admin.html` + `admin.js` | `app/admin/page.tsx` | 319 → ~300 |
| the sources panel, inline in `app.js` | `components/sources-panel.tsx` | — |
| `readEventStream` + `describeFailure` | `lib/chat-stream.ts` | logic unchanged |
| `public/style.css` | `app/globals.css` | 275, verbatim |

The SSE reader moved almost word for word, including the comment explaining why
`EventSource` cannot be used: it only issues GET requests, and the question has
to go up in a POST body. That constraint has not changed, so neither has the
hand-written parser or its buffering across network chunk boundaries.

### Two rules, one of which is now free

`CLAUDE.md` demands `textContent`, never `innerHTML`, for anything from the
server or the model. React escapes children by default, so the rule costs
nothing here — and it comes back the instant anyone reaches for
`dangerouslySetInnerHTML`, which is exactly what adding markdown rendering would
require. The comment at the top of `app/page.tsx` says so, because the rule
being free is not the same as the rule being gone.

The second rule — no markdown in the MVP, newlines handled by CSS
`white-space: pre-wrap` — is unchanged and needed no work.

### The state model, and the one thing it had to get right

The POC built DOM nodes imperatively and held a reference to the current bubble.
React needs the turns as data, so a turn is now one of four shapes: `user`,
`pending`, `answer` (with optional `error`), `failed` (with Retry).

The distinction that had to survive is the one the POC drew with
`if (bubble && bubble.textContent !== '')`: **a failure arriving after the
answer has started keeps the partial text and puts the error underneath it**,
while a failure before it replaces the whole turn with a Retry button. Throwing
away text the model already produced, because something broke afterwards, is a
worse outcome than showing it with a warning.

Retry still removes the question as well as the error, for the reason the POC
recorded: `send()` re-adds the user's message, so leaving the original would
show the same question twice after one retry.

### Scrolling: `useLayoutEffect`, not `useEffect`

The POC scrolled synchronously inside its DOM writes. In React, scrolling in a
`useEffect` runs after the browser has painted, which produces a visible jump on
every delta. `useLayoutEffect` runs before paint.

The "only follow the text if the reader is already at the bottom" rule survives
as a ref updated by `onScroll` — yanking the viewport while someone is re-reading
an earlier answer is worse than making them scroll.

### The `chunker.js` hack is gone, and the proof is in the HTML

`server.js:62` served `src/chunker.js` to the browser so the admin page's live
estimate used the server's `CHUNK_SIZE`. The admin page now does
`import { CHUNK_SIZE, CHUNK_OVERLAP, estimateChunkCount } from '@rag/chunker'`,
and the rendered page says:

```
0 characters · ≈ 0 chunks (1000 chars, 150 overlap)
```

Those two numbers came from the package the server chunks with. One definition,
no static-file route, no chance of drift. The discipline that made it possible —
pure, no I/O, no dependencies — is kept anyway, because that is what makes the
file readable on its own.

`lib/limits.ts` does the same job for `MAX_CONTENT_LENGTH`, which is why it had
to be split out of the `server-only` `lib/env.ts` back in Phase 5.

### The service-role grep finally means something

Client components did not exist until this phase, so `plan/steps.md` § 2.1's
check had nothing to catch. Run against the built client bundle now:

| Pattern | Files in `.next/static/` |
|---|---|
| `service_role` | 0 |
| `SUPABASE_SERVICE` | 0 |
| the live service-role key's first 24 chars | 0 |
| the live OpenAI key's first 24 chars | 0 |
| `sk-proj` | 0 |
| `eyJhbGci` | 0 |

`SUPABASE_SERVICE_ROLE_KEY` appears in exactly one place: a **server** chunk.
That is the evidence; "I was careful" is not.

### What has not been verified, precisely

Browser tooling was declined this session, so everything below was reasoned
about and compiled but not clicked:

- text appearing token by token, and the sources panel being on screen *before*
  the first token (the whole point of D-019);
- click-to-expand on a source chunk, and on a document row;
- Retry after a failure;
- the delete confirmation and the list refreshing after it;
- the textarea growing with its content, and Enter vs Shift+Enter;
- the empty-knowledge-base hint, which needs a database with no documents.

**A five-minute check, once there is a working API key:**

```sh
pnpm --filter web dev      # http://localhost:3000
```

1. `/admin` lists 8 documents with chunk counts; click a title, chunks appear.
2. Paste a document with a fact the model cannot know; the estimate updates as
   you type; add it.
3. Ask about that fact on `/`. The answer should stream, with the sources panel
   visible before the text finishes.
4. Delete the document and ask again — it must say it does not know.

Steps 2–4 are the `mvp.md` definition of done, and they need the key regardless
of the UI.

## Phase 7 — cutover · done

`apps/legacy-poc` is gone. The repo is one Next.js app and five packages.

### The decision that shaped this phase

Phase 4 was never closed, because its proof — `pnpm eval` matching the Phase 0
baseline — needed a baseline that was never captured. Deleting the old
implementation makes any old-versus-new comparison impossible forever, so the
choice was put explicitly: capture it now, or close Phase 4 on the structural
evidence already gathered.

**Decided 2026-09-22: close it on the structural evidence.** Recorded plainly
because it is a real limitation, not a formality:

| Proved | Not proved |
|---|---|
| Chunker output byte-identical, 87 comparisons | That the six eval verdicts are still what they were |
| Pipeline identical on constants, `buildPrompt`, `retrieve`, and three DB reads, 22 comparisons | That a *generated answer* matches what the old code would have produced |
| API identical on 24 request/response pairs, diffed against both servers running at once | — |

The gap is narrower than it sounds: retrieval and prompt assembly are proved
identical, and those are what determine what the model is asked. What is not
proved is the model's half, which is nondeterministic anyway and which the
battery judges by verdict rather than by text.

Before deleting anything, the two parity runs that cost nothing were captured to
**`plan/baseline/parity-final.txt`** — they cannot be re-run now, and a claim
with no artifact behind it is worth very little.

### What was deleted, and what went with it

- `apps/legacy-poc/` — the whole POC.
- `packages/chunker/tools/parity.mjs`, `packages/rag/tools/parity.mjs`,
  `apps/web/tools/api-parity.mjs` — all three imported the old implementation,
  so they became unrunnable the moment it went. They were migration scaffolding
  and always had this expiry date; their results are in `plan/baseline/`.
- The `parity` scripts and the turbo task that ran them.
- `BUILD.md` — byte-identical to `CLAUDE.md`, a duplicate since the repo was
  created.

**What did not go:** the 13 vitest cases in `@rag/chunker`. They state what the
chunker should do rather than what it used to do, so they outlive the thing it
was compared against — which is exactly why they were written in Phase 2.

### Verified after the cutover

| Check | Result |
|---|---|
| `pnpm build` | 5 tasks, clean |
| `pnpm typecheck` | 9 tasks, clean |
| `pnpm test` | 13 passed |
| `pnpm --filter @rag/db verify` | 10/10 |
| Secrets in `apps/web/.next/static/` | **0 files** for all six patterns |

The security grep is the one from `plan/steps.md` § 2.1, and it is the evidence
that item asked for: `service_role`, `SUPABASE_SERVICE`, `sk-proj`, `eyJhbGci`
and both live key prefixes all return zero files.

### The docs, which were the largest part of this phase

`CLAUDE.md` said, in order: no TypeScript, no framework creep, three
dependencies, and here is the layout with `server.js` at the root. Every one of
those was false. A brief that lies to the next person — or the next agent — is
worse than no brief, so it was rewritten around what is now true, and `BUILD.md`
collapsed into it.

**Four decisions amended, four added:**

| | |
|---|---|
| D-009 Express 4 | **Superseded.** Noted that the one place the 4-vs-5 choice actually mattered (async errors not caught, hence the `route()` wrapper) has an exact counterpart in `withRoute()` |
| D-013 Local only | Still true; Phase 8 changes it |
| D-014 No TypeScript | **Reversed** — with the original reasoning left intact, because it was right and has been served. The sentence that changed is "this is a throwaway learning POC" |
| D-020 | Turborepo monorepo: why packages rather than folders, and the honest cost |
| D-021 | Next.js App Router: the three things it makes easy to get wrong |
| D-022 | zod at the boundary; what it still does *not* validate |
| D-023 | Why the env check logs at import and throws per request |

**D-020 records something worth not overselling:** the TypeScript port caught
nothing that was already broken. The two real bugs found during the migration —
`partial: undefined` on every error, and an env check that made the real message
unreachable — were both found by *running* things, not by the compiler. What
made the port safe was the parity tooling.

`architecture.md`, `flow.md`, `mvp.md` and `screens.md` each carry a banner
saying precisely which parts are still binding and which are historical, rather
than being rewritten. Their content is still accurate — the data model, the
pipelines, the prompt, the error policy and every UI state are unchanged. Only
the file names moved, and pretending otherwise by rewriting them would destroy
the record of what was planned and why.

`README.md` was updated properly rather than bannered, because it is the file
someone runs commands from: paths, the pnpm commands, `/admin` instead of
`/admin.html`, and the pipeline diagram, which had never been updated for query
rewriting or hybrid search.

## Phase 6 — signed off

Checked by hand in the browser, 2026-09-22. All four steps of the `mvp.md`
definition of done pass on the new stack:

1. `/admin` lists the documents with chunk counts; a title expands to its chunks.
2. The live estimate updates while typing, and a pasted document embeds.
3. A question about a fact the model cannot know is answered, streamed, with the
   sources panel on screen before the text.
4. Deleting the document makes the same question return the refusal.

**What that closes.** Phase 6 was the last piece carrying an unverified claim,
and it was the one that mattered most: everything else in the migration was
proved by comparison against the old implementation, but the screens had no
counterpart to diff against once they became React. The only way to know was to
use them.

**The migration is functionally complete.** Phases 0–7 are done; Phase 8
(deploy) remains and is optional — D-013's local-only decision still stands
until someone decides otherwise, and `risks.md` R-2 becomes a blocker rather
than a note on the day that changes.

### The honest summary of what this migration proved, and did not

| | |
|---|---|
| **Proved by measurement** | Chunking byte-identical (87 comparisons). Retrieval, prompt assembly, constants and DB reads identical (22). The six API endpoints identical in status and body (24, both servers running at once). No secret in the client bundle (0 files, six patterns). |
| **Proved by use** | The pipeline end to end, on the new stack: real grounded answers over both the JSON and SSE paths, and both screens by hand. |
| **Never proved** | That the eval battery's six verdicts survived the port. The baseline was never captured, and after Phase 7 it cannot be — a deliberate, recorded choice. |

The last row is the one to remember. It is also cheap to fix whenever it
matters: load `fixtures/northwind.json` as the only corpus and run `pnpm eval`.
That will not be a before/after any more, but it will answer whether the battery
passes today, which is the question that actually governs future prompt edits.

---

# Post-migration

## Greeting handling (D-024) · done

"hi" used to return *"I don't know based on the documents I have."* It now gets
a greeting, and nothing else changed.

### Where it went, and where it deliberately did not

**Not in the knowledge base.** That is the obvious fix — paste a greetings
document — and it quietly taxes every other question. That document would
compete for the `MATCH_COUNT` slots on every search, so a chunk of small talk
filling one of five slots is a chunk of the real answer that never reached the
prompt. Retrieval is the wrong instrument anyway: a greeting has no facts to
look up, so the search returns whatever is merely nearest in a corpus with
nothing to say about it — the exact case `MIN_SIMILARITY` exists to reject.

`packages/rag/src/greeting.ts` is pure: no I/O, no model call, no imports. Same
discipline as the chunker, for the same reason — it can be read and tested on
its own. It runs **before** the rewrite, the embedding and the search, so a
greeting costs nothing but the conversation row and returns instantly.

### The failure mode that shaped it

Two things can go wrong here and they are not equally bad:

| | |
|---|---|
| A greeting is missed | The user gets the refusal. Mildly rude. |
| **A question is taken for a greeting** | The user asked something real and got a canned hello, with no sources and nothing explaining why |

Almost all the design guards against the second. The pattern is anchored at both
ends, anything containing `?` is rejected before normalisation strips the
punctuation that reveals it, and anything longer than 24 normalised characters
is rejected as a second line of defence. Most of the 40 unit cases are things it
must **not** claim.

### Verified

| | |
|---|---|
| Unit | **40 cases**, the majority of them negative: `high chair availability`, `hello kitty themed party`, `hi i need the wifi password` |
| Live | **6/6** — greetings greeted, real questions answered, absent and off-topic facts still refused |

The live case that mattered: **`hi, what is the Wi-Fi password?`** is answered
with its three sources intact, not swallowed by the matcher. A greeting that
opens a real question is still a real question.

Both refusal cases still refuse, which is the thing worth checking whenever the
answer path changes — `buildPrompt()` was not touched, so `CLAUDE.md` rule 1 did
not strictly apply, but the refusal is the behaviour most easily broken by
accident and it costs three API calls to confirm.

### What it does not do

Only English, and only greetings. `thanks` and `bye` hit the same wall and are
not handled; adding them is a line in the same file. Greetings in another
language are one line too — the regex is the whole surface.

## Tenancy plan written · done

[`plan.md`](./plan.md) — 8 phases, the plan `plan/steps.md` § 7 deferred and its
Phase 3 callout warned would be expensive if decided late. It *was* decided
late, and the plan is explicit about what that costs: a backfill, and a rewrite
of every query in `@rag/pipeline` plus both SQL functions, rather than one
migration taken at the right moment.

### What was decided before writing, and why those three

Three questions change the shape of the work rather than its details, so they
were answered first:

| Decision | Why this one, not the alternative |
|---|---|
| A tenant is a path segment `/t/<slug>` (**D-026**) | Identical on localhost and hosted. A subdomain needs wildcard DNS and a wildcard cert before the first tenant works at all, and local dev needs a hosts-file trick. Resolution is one function, so subdomains later are one file |
| Per-tenant admin key, scrypt, path-scoped signed cookie, hand-rolled (**D-028**) | ~80 readable lines of `node:crypto` against an auth framework's worth of concepts. D-001/D-002 — "no library does a step" — is still a functional requirement of this repo |
| Persona **is** in scope (**D-029**) | It is what "tenant base" means in `todo.md`: business name and assistant name. It also means `buildPrompt()` changes, which is what makes the missing eval baseline a blocker rather than a note |

### The two rules at the top, and why there are two

`plan/steps.md` needed one rule (*port, do not improve*). This plan needs that
one **plus** a second, because tenancy introduces a failure mode the migration
did not have:

> **Isolation is proven by a test, not by reading the code.**

`service_role` bypasses RLS. After this plan the only thing between tenant A and
tenant B is a `where tenant_id = …` in application code and inside two SQL
functions. A missing filter throws nothing, logs nothing, and returns plausible
answers — the R-3 pattern, aimed at other people's documents. So the acceptance
test is two tenants loaded and each one refusing the other's question
(`leak-1`, `leak-2`, `leak-3`), not a careful reading of thirteen queries.

### The finding that changed the plan

`ensureConversation()` (`packages/rag/src/answer.ts:18`) trusts a
client-supplied `conversationId` without verifying it exists or belongs to
anyone, and `getMessages()` (`:259`) has no tenant filter at all. In a
single-tenant app both are harmless. With tenants they are two distinct holes:

- **History injection** — post tenant A's conversation uuid to tenant B's chat
  endpoint and A's last six messages are loaded as history and pasted into B's
  prompt. The retrieved chunks are correctly B's, which is what makes it hard to
  notice.
- **Transcript read** — any uuid returns its own full transcript, unauthenticated.

This is why Phase 3 is not simply "add `.eq('tenant_id', …)` everywhere", and
why `leak-3` asserts on `getMessages` rather than on an answer.

### The trap that is genuinely new: HNSW post-filtering

An HNSW index does not know what a tenant is. Postgres walks the graph in
distance order, pulls candidates, and *then* discards the ones failing the
tenant filter — giving up after `hnsw.ef_search` candidates (default **40**).

At two tenants this is free. At fifty, a question from a small tenant can walk
40 neighbours that all belong to other tenants and come back with **zero rows**;
the D-008 short circuit fires, and the bot refuses a question it could have
answered. The only sign is `[retrieve] vector:0` in a log nobody is reading.

That is why Phase 2 exists as a phase of its own, before any application code:
`explain analyze` must still report `Index Scan using chunks_embedding_idx`, and
the five chunk ids returned must match the five Phase 0 recorded. Options, in
order: `hnsw.iterative_scan = 'relaxed_order'` set on the function (needs
pgvector ≥ 0.8.0 — check `pg_extension` first), a raised `ef_search`, or a
partial index per tenant, which is correct and unmanageable. Logged as R-10.

### The guard that does not depend on remembering

`chunks` carries `tenant_id` denormalised, because both SQL functions scan
`chunks` alone and joining to `documents` to discover each candidate's tenant
defeats the index before the filter can help. Denormalisation invites drift — a
document under tenant A with chunks under tenant B — so it is enforced by
Postgres rather than by discipline: `unique (id, tenant_id)` on `documents`,
then a **composite foreign key** from `chunks (document_id, tenant_id)`. A
mismatched insert now fails. Same treatment for `messages` → `conversations`.

Every other isolation guarantee in the plan is a filter someone has to remember
to write. This one is four lines that make the mistake impossible, and Phase 1's
verify script asserts it by attempting the bad insert and requiring it to fail.

### One liability turned into the strongest test in the battery

`CLAUDE.md` rule 1 currently says: load `fixtures/northwind.json` **and nothing
else**, because the Villa corpus describes parking and the `absent-2` case
exists to have parking refused. That makes the one test protecting the prompt
unrunnable against a database with real content in it.

Under tenancy the two corpora become two tenants, and `absent-2` stops asserting
"the fact is absent" and starts asserting **"the fact is in this database and
still unreachable from this tenant."** The precondition becomes the feature.
Rule 1 gets amended in Phase 8.

### Also worth writing down

- **`tenant` is a required parameter, never ambient** (D-027). No
  `AsyncLocalStorage`, no module-level current tenant, no `tenantId = 1`
  default. Required means every forgotten call site is a compile error — the
  same move `server-only` made for the service-role key, applied to the tenant.
- **Branding sets CSS custom properties through React's `style` prop** (D-030),
  from a five-key allowlist validated with zod. The obvious implementation is
  `<style dangerouslySetInnerHTML=…>`, which is CSS injection from a database
  column and is precisely what `CLAUDE.md` § Conventions forbids. The `style`
  prop needs no exception to the rule.
- **`admin_key_hash is null` means nobody can administer that tenant**, not
  everybody. Default-deny, because the other default is one forgotten column
  away from an open admin panel.
- **Phase 0 finally pays the baseline debt.** Migration Phase 4 closed on
  structural parity (22/0) and recorded that the eval baseline was never
  captured. A prompt change with no baseline is unmeasurable, so it is the first
  step and the plan says to stop if the battery does not read 5/6.

### Status

**Nothing is implemented.** This entry records a plan, and the next observable
value in this file should be the Phase 0 baseline — real verdicts, real scores,
real chunk ids.

---

## Tenancy Phase 0 — the baseline, captured · done 2026-09-23

**What was done:** Cleared the database down to `fixtures/northwind.json`
alone, which meant deleting the 8 Villa Amihan documents. Then ran the eval
battery and the score probe into `plan/baseline/`, and recorded the raw
`match_chunks` ids plus the pgvector version.

**Why it mattered:** tenancy changes `buildPrompt()`, and until now there was
nothing to compare a prompt change against. Every later phase is now measured
against these files.

**What each observed value proves:**
- **`5/6 as intended`, with only `antecedent` failing.** This is exactly the
  D-017 result, so nothing drifted through the TypeScript/Next.js migration.
  Migration Phase 4 closed on structural parity. This run is the behavioural
  parity that phase never measured.
- **`[retrieve] vector:0 keyword:0 -> fused:0` for "capital of France".** The
  D-008 short circuit still fires before any OpenAI call; the log shows no
  `[openai] chat` line for that case.
- **Chunk ids 139/138/140/137 (freezer) and 140/137/138[/139] (extension
  4417).** Phase 2 re-runs these after the tenant filter goes in. Same ids in
  the same order means the filter did not change what HNSW returns.
- **pgvector 0.8.2.** `hnsw.iterative_scan` exists, so § 2.1's first-choice fix
  for post-filter recall loss is available without an upgrade.

**Traps it hit and avoided:**
- **A dead API key mid-ingest (401).** The `catch` in `ingestDocument()`
  deleted document 36. Without it, a zero-chunk document would have sat in the
  "Northwind only" database. That is R-7 working exactly as designed.
- **Only four ids, not five.** `match_count: 5` against a 4-chunk corpus
  returns four. This is recorded as it is rather than padded.

---

## Tenancy Phase 1 — schema and migration · done 2026-09-23

**What was done:** `packages/db/sql/schema-tenancy.sql` adds:
- a `tenants` table, seeded with `northwind` (id 1, "Northwind Labs", assistant
  "Nora", no admin key);
- `tenant_id` on all four tables, backfilled and then NOT NULL;
- the `(id, tenant_id)` unique keys and the two composite foreign keys;
- three tenant indexes;
- tenant-scoped overloads of `match_chunks` and `match_chunks_fts`.

`schema.sql` was left untouched, as the plan requires. `verify.mjs` gained
checks 11–14. They create and then delete a throwaway `verify-probe` tenant.

**Why it mattered:** this is the data model every later phase stands on. The
composite FK is the one isolation guarantee that does not depend on a filter
being remembered.

**What each observed value proves:**
- **NULL counts 0 · 0 · 0 · 0.** The backfill reached every row, including the
  191 conversations and 494 messages. A missed row would have been invisible to
  `where tenant_id = …`, not an error.
- **`23503 ... violates foreign key constraint "chunks_document_tenant_fk"`.**
  Postgres itself refuses a chunk that claims a different tenant from its
  document. The check passes *because* the insert failed.
- **`match_chunks(own tenant)`: chunk 137 at 1.000000.** The filtered function
  is still a real vector search. It is the old self-similarity check (chunk
  137, 1.000000) run through the new signature.
- **`match_chunks(another tenant)`: 0 rows.** Leakage is caught in SQL, with no
  API key.
- **Eval 5/6, the same verdicts as Phase 0.** The bridge works: chat, rewrite,
  retrieval and message inserts all still function on the un-threaded pipeline.

**The deviation, and why (D-031):** following the plan literally would have
broken ingest, chat and `pnpm eval` until Phase 3, despite the plan saying
Phases 0–2 touch no app code. So the bridge was added: a default of northwind,
plus the old unfiltered functions kept as overloads. It is safe with one
tenant, and it becomes a leak with two, which Phase 2 creates. That is why the
Phase 2 villa ingest must set `tenant_id` explicitly, and why Phase 3 is not
done until the bridge-removal block has run.

**Trap avoided:** `create or replace function` with a new parameter list does
not replace anything. Postgres creates a second overload, and the old signature
stays. It was used deliberately here, and it is also why the removal block has
to name the old signatures explicitly.

---

## Tenancy Phase 2 — the index, measured · done 2026-09-23

**What was done:** Loaded a second tenant, `villa` (id 3, 30 chunks), next to
`northwind` (id 1, 4 chunks). Measured the tenant-scoped searches with
`explain analyze` through a temporary `tenancy_explain()` RPC. Then added
`set hnsw.iterative_scan = 'strict_order'` to `match_chunks`. The full write-up
is in `notes.md` § "Tenancy Phase 2", and the raw plans are in
`plan/baseline/explain-phase2.txt`.

**Why it mattered:** the tenant filter is a post-filter on a global HNSW graph.
That shape can lose recall with no error (§ 2.1, R-10), and this phase is the
only place that is looked at before real tenants depend on it.

**What each observed value proves:**
- **`Index Scan using chunks_tenant_idx` plus a `Sort`.** At this size a
  tenant-scoped search is exact, not approximate, so the § 2.1 failure cannot
  happen today. It is also not the HNSW scan the plan expected. That is
  recorded as a deviation, not hidden.
- **Ids 139 · 138 · 140 · 137 and 140 · 137 · 138, the same as Phase 0.** The
  filter changed nothing about what northwind retrieves, even with 30 villa
  chunks in the same table.
- **Run N: 0 rows. Run O: 5 rows.** With HNSW forced and a short walk, a tenant
  can get nothing back, and iterative scan fixes it. This is the
  before-and-after the plan demanded.
- **`pg_proc` lookup, 0 rows then 1 row.** The setting really is on the
  function, not just in the file.
- **Anon → `42501 permission denied for function tenancy_explain`.** The helper
  that runs arbitrary SELECTs is not reachable with the publishable key.

**Traps avoided:**
- **Seeding villa through `ingestDocument()`** would have filed all 30 chunks
  under northwind, because of the D-031 default. The seed wrote `tenant_id`
  explicitly instead.
- **`relaxed_order`** fixed recall just as well, but can return rows out of
  distance order, which quietly breaks most-similar-first. `strict_order` was
  chosen for that reason.
- **Measuring the function call itself** showed only `Function Scan on
  match_chunks`, because the function is not inlined. The query body was
  explained directly instead, and the setting was proven from the catalog.

---

## Tenancy Phase 3 — the tenant threaded through `@rag/pipeline` · done 2026-09-23

**What was done:**
- `TenantContext { id, slug, businessName, assistantName }` is the pipeline's
  view of a tenant. `loadTenant(slug)` is the only place a `tenants` row
  becomes one, and it names its four columns.
- Every pipeline function that touches the database takes `tenant` as a
  required first argument. Every query gets `.eq('tenant_id', …)`, every insert
  gets `tenant_id`, and both RPCs get `p_tenant_id`.
- § 2.2 is fixed. A client-supplied `conversationId` is used only if this
  tenant owns it. `getMessages()` returns `null` for "not yours / not there"
  and `[]` for "yours, empty".
- The existing routes are pinned to northwind by `bridgeTenant()`.
- The D-031 database bridge is removed, and `schema-tenancy.sql` now describes
  the final state.

**Why it mattered:** this is where Rule 2 becomes code. After this, the only
thing between two tenants is these filters, and the missing default makes a
forgotten one a compile error or a database error, not a silent read.

**What each observed value proves:**
- **15/15 grep lines carry a tenant.** Every call was read line by line, as the
  plan demands. Two lines had no visible filter: the chunk insert, where the
  tenant is in `rows`, and the R-7 cleanup delete, which now filters too.
- **Isolation 11/11, with and without the bridge.** One tenant asking for the
  other's documents, chunks, conversation or transcript gets nothing. A delete
  across tenants is refused. An ingest lands in the right tenant.
- **Score probe byte-identical to Phase 0, and eval 5/6 with the same
  verdicts.** Tenancy is a filter, not a behaviour change. `absent-2` stays
  refused with villa's parking documents in the same table. That means CLAUDE.md
  rule 1's "Northwind only" precondition is now enforced by tenancy rather than
  by discipline. It is amended in Phase 8.
- **`PGRST202` for the old functions, `23502` for a tenant-less insert.** The
  bridge is gone, not merely unused. An un-threaded call now fails loudly.
- **HTTP: a northwind-only list, `[]` and `404` for villa's document 38.** The
  route pin holds end to end, through Next.js.

**Traps hit and avoided:**
- **Phase 1 had silently broken `listDocuments()`.** The composite foreign key
  is a second relationship between chunks and documents, and PostgREST refuses
  to guess between two. Nothing that was being run called it. Naming the
  relationship fixes it, and the name chosen, the composite FK, can only join
  within one tenant.
- **Keeping the bridge in the SQL file** would have re-armed it on the next
  idempotent re-run. The file was rewritten to drop it instead.
- **`parity.mjs` could not be re-run**, because the legacy POC it compared
  against is deleted. That was replaced by measurements that can still be
  taken, and recorded as a deviation rather than claimed.

---

## Tenancy Phase 4 — persona, then measure · done 2026-09-23

**What was done:** `buildPrompt()` takes the tenant and opens with *"You are
{assistantName}, the assistant for {businessName}."* Everything below that line
is D-017's block, byte for byte. The greeting names the tenant's assistant and
business, and it is still pure and still says what the bot is for. The eval
battery now names a tenant for every case and has four new cases, all of which
need both tenants loaded.

**Why it mattered:** a persona is an invitation to be helpful, and being
helpful is how refusals erode (§ 2.6, R-12). Phase 0's baseline existed so this
could be measured rather than assumed.

**What each observed value proves:**
- **Six verdicts identical to Phase 0, on two runs.** The persona line cost no
  refusal and fixed no failure. `antecedent` still gives the auditor 1:1 ratio:
  the same model limit, and the same wrong words.
- **leak-1 refused.** The fact exists in this database (villa's parking), and
  northwind cannot reach it. `absent-2` has been promoted from "absent" to
  "isolated".
- **leak-2: northwind `keyword:0`, villa `keyword:1`.** The exact-token path,
  `match_chunks_fts`, is filtered too, and the control proves the token is
  findable, so the refusal means something.
- **leak-3: 2 messages for the owner, `null` for northwind.** § 2.2's
  transcript read is closed, and asserted in the same battery as the prompt
  cases.
- **persona: "Hello! I'm Lia, the assistant for Villa Amihan Private
  Resort…"**, with no Nora or Northwind. Each tenant has its own identity.

**Traps avoided:**
- **A persona check that could not fail.** Villa's assistant was first named
  "Amihan", which is also part of "Villa Amihan Private Resort". So "the reply
  mentions Amihan" was true however the greeting was written. The assistant was
  renamed to "Lia", and the check asserts the assistant name AND the business
  name, and neither of the other tenant's.
- **A leak case that could not fail.** Without leak-2's villa control, a
  northwind refusal would be consistent with an identifier nobody can find.
- **Adding the optional "answer only from context" sentence by default.** It
  was measured as unnecessary, so it stays out. Every extra line in that prompt
  is something the next edit has to re-measure.

---

## Tenancy Phase 5 — routes under `/api/t/<slug>/` · done 2026-09-23

**What was done:** Every route moved under `app/api/t/[tenant]/`. The new
`withTenantRoute()` in `apps/web/lib/tenant.ts` resolves the slug through the
cached `getTenant()`, answers an unknown one with a 404, and hands the handler a
`TenantContext`. It is built on `withRoute()`, so the single error map still
applies. The Phase 3 route pin, `bridgeTenant()`, is deleted, and the old
paths no longer exist.

**Why it mattered:** the URL is now the only way a request names a tenant.
There is no default and no redirect, so there is nothing that could pick a
tenant on a request's behalf.

**What each observed value proves:**
- **northwind shows only document 37, villa only documents 38–45.** The slug
  selects the tenant end to end, through Next.js.
- **`/api/t/nope/documents` → `404 No workspace named "nope"`.** An unknown
  tenant is an error that names the slug. It is neither a fallback nor a list
  of real slugs.
- **`/api/chat` → `404`.** The old paths are gone, not redirected. A
  compatibility shim would have been the default tenant by another name.
- **Villa's document 38 through northwind gives `[]` for chunks and `404` on
  delete.** These are indistinguishable from an id that does not exist, so ids
  cannot be enumerated across tenants.
- **SSE: `meta`, 13 × `delta`, `done` on villa.** The streaming path survived
  the move and the wrapper.

**Traps avoided:**
- **Stale `.next/types`.** They still referenced the old route paths and
  failed `tsc`. A clean build regenerated them. Nothing was wrong in the
  source.
- **An ingest example against a fixture tenant in the README.** Anyone who
  copy-pasted it would have silently changed the eval battery's verdicts. It
  was replaced by a warning.

---

## Tenancy Phase 6 — admin auth · done 2026-09-23

**What was done:** Editing a tenant's knowledge base now requires that
tenant's admin key.
- **Keys** are scrypt-hashed (N = 2^15, a 16-byte salt, stored as
  `scrypt$N$salt$hash`), in `@rag/db`'s `admin-key.ts`. They are checked with
  `timingSafeEqual`. A NULL hash means nobody can administer the tenant.
- **Logging in** (`POST /api/t/<slug>/admin/session`) sets an httpOnly,
  SameSite=lax cookie, `<slug>.<expiry>.<hmac>`, with its path set to
  `/api/t/<slug>`.
- **`requireAdmin()`** guards the admin routes by throwing a 401 through the
  existing error map. Chat stays open.
- **The tools** `tenant:add` / `tenant:key` generate a 32-byte key, print it
  once, and store only its hash.

**Why it mattered:** before this, anyone who could reach the API could delete
any tenant's documents. The chat is the product, but the knowledge base is the
tenant's property.

**What each observed value proves:**
- **Cookies from another tenant, swapped-slug, tampered and expired: all 401.**
  readSession checks three things: the HMAC, the slug match, and the expiry.
  The cross-tenant case was sent by hand, so it proves the server check
  itself, not just the browser's path scoping.
- **`Path=/api/t/authprobe; HttpOnly; SameSite=lax`.** Browsers do not send the
  cookie to any other tenant's routes, scripts cannot read it, and it is not
  sent on cross-site POSTs. `Secure` is set everywhere except `next dev`.
- **Key-less tenant: 401, "has no admin key set".** Default-deny: a missing
  column value locks the admin panel instead of opening it.
- **Chat 200 with no cookie.** The guard is only where it belongs.
- **The key appeared 0 times in the dev log, and 0 static files contain
  `admin_key`, the secret or `scrypt`.** The rule 2 grep, applied to the new
  secret, is clean.

**Deviations and traps:**
- **The plan's cookie path (`/t/<slug>`) would have made login a no-op.** The
  cookie would be set and then never sent to `/api/t/<slug>/…`, which is where
  it is checked. So the path is `/api/t/<slug>`.
- **`tenant:key` was not in the plan**, but northwind and villa were created
  in Phase 1 and Phase 2 with no key, so they could never have been
  administered.
- **The real keys were never seen by Claude.** Auth was tested against a
  throwaway tenant whose key went to a gitignored scratch file. The file was
  deleted, and so was the tenant.

---

## Tenancy Phase 7 — the screens · done 2026-09-23, signed off in the browser

**What was done:**
- **Pages:** both screens live under `/t/<slug>`. The pages are Server
  Components that resolve the tenant (a 404 on a miss) and hand the Client
  Components plain props: the slug, the names, the validated image URLs, and
  the document count. The browser never works out which tenant it is on.
- **Theme:** five allowlisted custom properties set through the `style` prop.
  `globals.css` needed no rewrite, only the rules for the new elements.
- **Admin screen:** it checks for a session first and shows a login form
  otherwise. Any 401 drops back to that form.

**Why it mattered:** this is where two tenants become visibly two products.
It is also where the § 2.4 trap lives: branding is data from the database
that becomes markup.

**What each observed value proves:**
- **Hostile theme values rendered 0 times, and only three variables appeared.**
  A tenant cannot write CSS or scripts into its own page. That applies to a
  CSS-rule break-out (`;}body{…`), a `url(javascript:…)`, an unknown key, and
  non-https image URLs.
- **Villa is styled and northwind is not.** Each tenant's theme is scoped to
  that tenant's pages.
- **`/t/nope` → 404 "No such workspace", and `/` has no list or redirect.**
  Neither reveals which slugs exist.
- **The browser walk passed, all seven steps.** Each tenant answers its own
  question and refuses the other's, the sources never cross tenants, and
  logging in to one tenant does not log you in to the other.

**Traps avoided:**
- **`notFound()` in a layout** skips that segment's own `not-found.tsx`. So
  the pages call it, and the layout only styles.
- **The chat page's empty-knowledge-base check** used `GET /documents`, which
  Phase 6 made admin-only. It now comes from a server-side count, which also
  removes a request made on page load.

---

## Tenancy Phase 8 — cutover and the record · done 2026-09-23

**What was done:** the repo stopped describing a single-tenant app.
- **Decisions and risks:** decisions.md D-025 to D-030 (plus the D-006
  amendment) and risks.md R-10 to R-13 (plus the R-2 amendment) were written
  from the values observed in Phases 0–7.
- **Architecture and flow:** architecture.md and flow.md now draw the tenant
  step first.
- **CLAUDE.md:** the battery rule now asks for both tenants, and a new rule
  names the `tenant_id` filter as the only isolation there is.
- **README.md:** takes a fresh reader from clone to two working tenants.

**Why it mattered:** the next reader, human or model, starts from these files.
A CLAUDE.md that still said "load northwind and nothing else" would have sent
them to delete villa, and with it the leak cases that protect isolation.

**What each observed value proves:**
- **The README loader, run verbatim, gave 9 documents and 34 chunks, with the
  same per-document counts as the real tenants.** The done-when ("a fresh
  reader can go from `git clone` to two working tenants using only README.md")
  was checked by running the instructions, not by reading them. The tenant
  used was a throwaway, deleted afterwards (0 documents left), so the fixtures
  the battery depends on were never touched.
- **Every number in the new doc sections was checked against this session's
  observations**: 50 ms, 0 → 5 rows, 11/11, 15 of 15, 9/10, the theme
  colours, and the error codes. None were predicted.

**Traps avoided:**
- **Stale architecture and flow diagrams.** architecture.md §2 and §3 still
  drew `server.js` and `public/index.html` after the migration. They were found
  in review and redrawn, not left for "later".
- **Testing the loader against the real tenants** would have given each of
  them duplicate documents and shifted the eval verdicts. A throwaway tenant
  gave the same proof without that cost.

---

# Bookings

## Bookings plan written · done 2026-09-24

[`plan/bookings.md`](./plan/bookings.md), Phases 0–8. It covers a booking
manager for a tenant's staff, and then the chatbot's first tool,
`check_availability`, so availability is answered from live data instead of
from a document.

### What was decided before writing

| Decision | Why this one, not the alternative |
|---|---|
| Domain logic in `@rag/bookings`, HTTP in `apps/web` (**D-032**) | The admin routes and the tool executor call the same functions. If the chatbot called this app's own `/api`, it would add a network hop, an auth problem and a loss of types |
| Applications as a code registry plus a `tenant_applications` table (**D-033**) | An application is code, so a row cannot create one. The row only switches it on for a tenant, and the model is offered only the tools of enabled applications |
| Chatbot tools are read-only (**D-037**) | The chat route is open. A write tool there would be an unauthenticated write to the database through the model |

### The finding that changed the data model

The first sketch had rooms. `sample-documents/02-rates-and-schedules.md` says
otherwise: Villa sells the **whole property** in three slots, Overnight runs
from 14:00 to 12:00 the next day, and "only one slot is sold per day". So a
booking is a `tstzrange`, computed in SQL from the tenant's timezone, and an
exclusion constraint rejects overlaps. Every rule in the document (Overnight on
the 1st blocks the Day Tour on the 2nd, and so on) falls out of range overlap
with no code, and the same model still covers a hotel later.

### The traps the plan is built around

- **"Check, then insert" double-books** under concurrency. The exclusion
  constraint makes the loser a `23P01` → 409, whatever the timing (§ 2.2).
- **D-008's short circuit would make the tool unreachable**, because "Is the
  12th free?" may retrieve nothing. It is reworded, not removed (D-035): with
  zero chunks, a reply is accepted only if a tool was called that turn.
  Northwind, which has no tools, gets exactly D-008's behaviour (§ 2.4).
- **The documents tell the model to message the owners.** The bot could answer
  availability from `04-booking-and-payment.md` and never call the tool. The
  battery therefore asserts *that the tool was called*, not just what the
  reply says (§ 2.5).
- **The model has no clock.** Today's date, in the tenant's timezone, goes into
  the tools paragraph, or "this Saturday" resolves against training data (§ 2.3).
- **PII through a tool result.** The availability result type has no guest
  fields, and the SQL function never selects them (Rule 3).

### Status

Nothing is built yet. The next step is Phase 0, the baseline. Three questions
for the Villa owners (§ 8) block the slot seed in Phase 1.

## Bookings Phase 0 — the baseline · done 2026-09-24

**What was done:** the four baselines from `plan/bookings.md` Phase 0, in
`plan/baseline/`: `verify-pre-bookings.txt`, `isolation-pre-bookings.txt`,
`eval-pre-bookings.txt` and `northwind-prompt-pre-bookings.txt`. A new script,
`pnpm --filter @rag/pipeline prompt-snapshot [slug]`, prints the exact
`buildPrompt()` messages for a tenant, using fixed chunks and fixed history.

**Why it mattered:** Phase 6 changes `buildPrompt()` and the zero-match path.
Without these files, "the original ten verdicts are unchanged" and
"Northwind's prompt is byte-identical" could only be asserted, not checked.

**What each observed value proves:**
- **verify 14/14** (9 documents, 34 chunks). The schema is the tenancy end
  state, which is what `schema-bookings.sql` will be applied on top of.
- **isolation 11/11.** Cross-tenant reads are refused before any bookings
  table exists, so a later failure belongs to the new code.
- **eval 9/10, and the one FAIL is `antecedent`**, the known D-017 model limit.
  That matches the number `CLAUDE.md` rule 1 expects, so nothing had drifted
  since tenancy Phase 8.
- **Northwind's prompt: sha256 `d6337d0f…`**, 18 lines, with the persona line
  "You are Nora, the assistant for Northwind Labs." followed by the D-017
  block. Phase 6 must produce this same hash.

**Trap avoided:** snapshotting a prompt built from *retrieved* chunks. Its
bytes would move with embedding noise and database content, and a diff would
flag changes unrelated to the prompt code, so real ones would get ignored.
Fixed inputs mean the only things that can change the hash are
`buildPrompt()` and the tenant's persona columns.

## Bookings Phase 1 — schema · done 2026-09-24

**What was done:** `packages/db/sql/schema-bookings.sql`, run by the user in
the Supabase SQL editor. It adds:

- **`tenant_applications`**, with a trigger that requires a valid
  `config.timezone` for `bookings`;
- **`units` and `slots`**;
- **`bookings`**, with composite FKs to both, and the `bookings_no_overlap`
  exclusion constraint over `(unit_id =, during &&)` that ignores cancelled
  rows;
- **the `bookings_compute_during` trigger** and **`slot_range()`**;
- **`check_availability(p_tenant_id, p_from, p_to)`**, which has no default
  tenant;
- **RLS** on, with no policies;
- **the Villa seed.**

Hand-written types went into `database.types.ts`, and verify checks 15–28
into `verify.mjs`. Results: `plan/baseline/verify-post-bookings-schema.txt`.

**Why it mattered:** everything later (the package, the admin screen, the
chatbot tool) reads availability from this. If the rule "these two bookings
overlap" lived in TypeScript, two callers could disagree about it. Here it
lives in one constraint, and `check_availability` applies the same `&&` test,
so "open" means "an insert would succeed".

**What each observed value proves:**
- **`["2026-10-01 06:00:00+00","2026-10-02 04:00:00+00")`** for an Overnight on
  1 Oct. 14:00 Manila is 06:00Z, and the 22-hour span ends at 04:00Z the next
  day, which is 12:00 Manila. Timezone and midnight-crossing are both right,
  computed by Postgres, with no date library.
- **A supplied `during` of 2000-01-01 came back as the computed 2026-11-01
  range.** The trigger overwrites; it does not trust the caller.
- **`23P01 … "bookings_no_overlap"`** for a Day Tour on 2 Oct after an Overnight
  on 1 Oct. The document's "Overnight blocks the next morning" rule, enforced
  by range overlap alone.
- **Day Tour 00:00Z–09:00Z, then Evening 09:00Z–13:00Z on the same day, both
  accepted.** Half-open ranges: back-to-back bookings do not collide.
- **A cancelled booking freed its span**: the Day Tour refused earlier was
  then accepted.
- **Cross-tenant unit → `23503 bookings_unit_tenant_fk`, and cross-tenant slot
  → `23503 Slot 3 does not belong to tenant 21`.** Cross-tenant writes are
  refused by the database, not by a filter someone has to remember.
- **`check_availability` keys: `booked_date,slot,status,unit`**, with no guest
  fields. Rule 3 is enforced at the SQL layer. Asked as Northwind, it returned
  **0 rows**.
- **`22023 time zone "Mars/Olympus_Mons" not recognized`.** A bad timezone
  fails when it is written, not eight hours out on the first booking.
- **After the run:** tenants are only `northwind` (1) and `villa` (3), with 0
  bookings. The probe cascade cleaned up all four tables, which also proves
  that the `no action` slot FK does not block deleting a tenant.

**Deviation:** the plan had a `create_booking()` RPC compute `during`. It
became a trigger, which is stronger: every insert path gets the same range, and
the trigger also refuses bookings for a tenant without the application
(`23503 Tenant 21 does not have the bookings application`). Recorded in
plan/bookings.md § 1.3.

**Traps caught:**
- **A HEAD count on a missing table returned `count: null` with no error.**
  Before the SQL ran, "read the bookings tables" passed. The check now also
  requires a numeric count. Without that, it would have kept passing against
  a database the file was never run on.
- **My expected value for check 25 was wrong, not the SQL.** I expected
  Overnight on 2 Oct to be open, but it starts at 14:00, inside that day's
  08:00–17:00 Day Tour. The database applied "one slot per day" more
  faithfully than the hand-written expectation did, which is the argument for
  keeping the rule in the constraint.

## Bookings Phase 2 — `@rag/bookings` · done 2026-09-24

**What was done:** a new package, `packages/bookings`. It depends on `@rag/db`
only, and is server-only through it. The files:

- `validate.ts`: pure date and text checks, plus `localDate(timezone)`;
- `errors.ts`: `BookingInputError` 400, `BookingConflictError` 409,
  `BookingsNotEnabledError` 404;
- `bookings.ts`: `checkAvailability`, `listBookings`, `createBooking`,
  `cancelBooking`, `listUnits`, `listSlots`, `bookingsConfig`.

It also has 27 unit tests and a 13-check isolation script,
`pnpm --filter @rag/bookings isolation`, saved to
`plan/baseline/isolation-bookings-phase2.txt`.

**Why it mattered:** this is D-032 made real. The admin routes (Phase 3) and
the chatbot's tool executor (Phase 6) both call these functions, so there is
one place that validates a date, one place that maps `23P01` to 409, and one
availability result type with no guest data in it.

**What each observed value proves:**
- **Northwind: all three calls throw `BookingsNotEnabledError`, status 404.** A
  tenant without the application gets "not there", not "locked".
- **Same Villa slot twice → `409 "That slot on 2027-07-21 overlaps an existing
  booking."`** `createBooking` does no availability read first. The insert is
  attempted and Postgres's `23P01` becomes the 409. There is no race window to
  double-book in.
- **The probe tenant, which has bookings too, sees 0 of Villa's bookings, gets
  its own unit only from availability, and cannot cancel Villa's booking**
  (`false`, and Villa's is still `confirmed`). Reads are tenant-scoped through
  the package, not only in SQL.
- **Villa's unit id and a nonexistent id both give "No such unit or slot."**
  Byte-identical messages, so unit ids cannot be enumerated across tenants.
- **Availability keys `date,slot,status,unit`, and neither the guest name nor
  the phone appears in the serialised result.** Rule 3, at the package layer,
  on top of the SQL layer. Rows are mapped field by field rather than spread,
  so a column added to the SQL function later cannot reach a prompt by
  accident.
- **"2026-09-23 is in the past. Today is 2026-09-24."** The message names today.
  When the chatbot gets this back as a tool result, the model has what it
  needs to ask the user again.
- **At 01:04 SGT (17:04Z), Manila's date is 2026-09-24 while UTC's is
  2026-09-23.** Observed while checking the output above. A "today" taken from
  the server's UTC clock would have been one day behind at that moment, and
  would have accepted yesterday as a bookable date. This is plan § 2.3, seen
  for real rather than predicted.

**Deviations, each recorded in plan/bookings.md Phase 2:**
- The isolation checks are a sibling script in `@rag/bookings`, not in
  pipeline's `isolation.mjs`, because pipeline does not depend on bookings
  until Phase 6.
- `MAX_AVAILABILITY_DAYS` (31) lives in this package, because the package
  that enforces a limit should own it.
- Functions take `BookingTenant { id, slug }`, because `TenantContext` lives in
  `@rag/pipeline` and the dependency points the other way. `TenantContext`
  satisfies it structurally.

**Traps avoided:**
- **"2026-02-30" passes a regex, and `Date` silently rolls it into March.** The
  round-trip check in `isIsoDate` rejects it, and a test pins it. A model will
  write dates like that.
- **Cleaning up by cancelling** would have left a cancelled row in Villa's
  real booking history. The isolation script hard-deletes its one Villa
  booking instead.

## Bookings Phase 3 — applications and admin routes · done 2026-09-24

**What was done:**
- **The registry.** `APPLICATIONS = { bookings: { label } }` and
  `enabledApplications(tenant)` in `@rag/pipeline`. Keys that the registry does
  not know are dropped even if the database holds them.
- **The gate.** `requireApplication()` and `hasApplication()` in
  `apps/web/lib/applications.ts`, memoised per request with `cache()`. A
  missing application is a 404.
- **The error map.** `lib/route.ts` now passes 400/401/404/409 through for
  status-carrying errors that are not `OpenAIError`.
- **Validation.** `createBookingSchema` checks types only; `@rag/bookings`
  owns the rules.
- **The routes,** each `withTenantRoute` → `requireAdmin` →
  `requireApplication` → package:
  - `GET/POST /api/t/[tenant]/bookings`;
  - `DELETE /bookings/[id]` (cancels);
  - `GET /bookings/availability`;
  - `GET /bookings/setup`.
- **Docs.** README curls.

**Why it mattered:** the package's errors now reach a client as what they are.
Before the `route.ts` change, a double booking would have been reported as a
500, a server failure, when it is the most expected outcome in the feature.

**What each observed value proves** (27 curl cases, `next start --port 3100`,
throwaway tenant `bookprobe` id 24, deleted afterwards):
- **No cookie → 401 "Admin login required", and a valid cookie without the
  application → 404 "does not have the bookings application".** The order
  admin → application means a stranger always gets 401. Whether a tenant
  has bookings is visible only to that tenant's admin.
- **Create → 201. Same slot → 409. Day on 11 Oct after Night on 10 Oct →
  409.** The exclusion constraint's `23P01` travels through package → route →
  error map as a 409, with the package's message intact.
- **`2026-02-30`, a past date, a blank name, and 40 days → 400**, each with the
  package's own wording ("Use YYYY-MM-DD.", "Today is 2026-09-24.", "The limit
  is 31 days."). One set of rules, in one place.
- **Villa's unit id from bookprobe → 400 "No such unit or slot."** A
  cross-tenant id looks exactly like no id, over HTTP too.
- **Cancel → 200, and availability for 10–11 Oct returns to all open.** The row
  is kept as `cancelled` (confirmed in the database before the probe was
  deleted), and it frees the span.
- **bookprobe's valid session cookie, sent by hand to `villa` and `northwind`,
  → 401.** `readSession` checks the slug inside the signed cookie, not only
  that the signature is valid. The cookie's path is `/api/t/bookprobe`, so a
  browser would not even send it there.
- **`/api/t/nope/bookings` → 404 "No workspace named "nope"".** Unchanged
  tenant resolution, now covering the new routes.

**Deviation:** only non-OpenAI errors pass client statuses through. An
`OpenAIError` 400 or 404 is OpenAI telling this server it sent a bad request
or an unknown model name. That is a server fault, and it stays a 500. Recorded
in plan/bookings.md Phase 3.

**Traps caught:**
- **The first cross-tenant cookie test tested nothing.** curl's cookie jar
  writes httpOnly cookies as `#HttpOnly_localhost …` lines. Filtering out
  comment lines removed the cookie, so "probe cookie at villa → 401" was
  really "no cookie → 401". It was re-run with the cookie proven valid first,
  by getting past admin at its own tenant. A test that cannot fail is not a
  test.
- **Port 3000 belonged to another project** (`gecom-apps`). A second
  `next dev` on this repo would also have fought over `.next`. The checks ran
  on a production build on port 3100 instead, which was stopped afterwards.

## Bookings Phase 4 — the admin screen · done 2026-09-24 (one step unconfirmed)

**What was done:**
- **The page.** `/t/[tenant]/admin/bookings` is a Server Component. It returns
  the ordinary "No such workspace" 404 when the tenant has no bookings
  application.
- **The screen.** `components/bookings-screen.tsx` is a Client Component
  containing:
  - the login;
  - a create form whose date input has `min` set to the tenant's today;
  - a 14-day range, where each day shows every slot as an open or taken chip,
    then the bookings that start that day, with Cancel;
  - earlier / today / later navigation.
- **The shared login.** `LoginForm` and `describeFailure` moved into
  `components/admin-login.tsx`, so both admin screens use one login. One
  session cookie (path `/api/t/<slug>`) covers both.
- **The link.** The knowledge-base admin page shows a Bookings link only when
  `hasApplication(tenant, 'bookings')` is true.

**Why it mattered:** it is the first thing a tenant's staff can actually use.
It also exercises the whole stack built in Phases 1–3 from a real browser:
the SQL constraint, the package, the routes, the error map and the session
cookie.

**What each observed value proves:**
- **Villa's bookings page is 200; Northwind's and `nope`'s are 404, with the
  same page.** A tenant without the application cannot tell the feature
  exists.
- **Bookings link: 1 occurrence on Villa's admin page, 0 on Northwind's.**
  Decided on the server from `tenant_applications`, not hard-coded per slug.
- **Bundle grep `service_role|guest_phone|admin_key|SUPABASE` → 0 files.** The
  screen imports `@rag/bookings` for types only (`import type`), so no server
  code reached the browser. CLAUDE.md rule 2 holds.
- **Booking #27: Overnight 2026-10-22, `["2026-10-22 06:00:00+00","2026-10-23
  04:00:00+00")`.** Made through the form, it is the same range verify.mjs
  computes. Browser → route → package → trigger agree.
- **`That slot on 2026-10-23 overlaps an existing booking.` in the server
  log.** The user tried the next-day slot in the UI, and the 409's message
  reached the form, as the plan's step 3 expects.

**What was NOT confirmed:** the user reported the walk as passed, but step 4
(cancel in the UI, then both days back to open) left no trace. #27 was still
`confirmed` afterwards, with no cancelled row. The cancel *route* is proven
(Phase 3: cancel → 200, availability back to open). The Cancel *button* is not
proven by this walk. This is recorded as it is rather than rounded up.

**Trap avoided:** a Cancel button with a `danger` class that no stylesheet
defines. It would have rendered as a plain button while reading as if it were
styled. The screen reuses the knowledge base's plain Delete button style
instead.

## Bookings Phase 5 — tool calling in `@rag/openai` · done 2026-09-24

**What was done:** tool calling added to the two hand-written requests, still
with no SDK (D-002):
- **Types.** `ChatMessage` is a union (system/user, assistant with optional
  `tool_calls` and nullable content, tool with `tool_call_id`). Also
  `ToolDefinition`, `ToolCall` (arguments kept as a string), `WireToolCall`
  and `ChatTurn`.
- **`chat()`.** Overloaded: with `tools` it returns a `ChatTurn`, without them
  a string. The existing callers are unchanged.
- **`chatStream()`.** Overloaded the same way, plus a per-index `Map`
  accumulator for tool-call fragments, and a `holdContent` option that
  collects text instead of emitting it.
- **Helpers.** `assistantToolCallMessage()` and `toolResultMessage()` for the
  round trip.
- **Tests.** 14 fixture tests with `fetch` and the env stubbed.

**Why it mattered:** Phase 6's loop needs three things from the transport: the
calls the model asked for, a way to send results back, and a way to hold text
until the zero-match rule has decided. All three now exist and are tested
without a network. The request for a tenant with no tools is provably the
request it was before.

**What each observed value proves:**
- **Body keys without tools: `messages, model, stream, stream_options,
  temperature` (stream) and `max_tokens, messages, model, temperature` (the
  rewriter), with the log lines unchanged.** Northwind's wire request cannot
  have moved. Rule 1 is checked at the HTTP layer, not only at the prompt
  string.
- **A network cut inside `"2026-10-12"` and inside the blank line still
  reassembled `{"date_from":"2026-10-12","date_to":"2026-10-14"}`.** The
  existing split-event buffering carries tool-call fragments too. This is the
  boundary bug § 2.7 predicted.
- **Interleaved indexes 0/1 came back as two separate calls with the right
  dates.** Per-index accumulation, not "the current call".
- **No `[DONE]` → `OpenAIError` 502 with `partial: "Let me check"`.** The R-3
  guard still holds with tools on.
- **Real calls:**
  - `chat`: 91 in + 21 out, 1 tool call. `chatStream`: 91 in + 21 out, 1 tool
    call. Both returned `{"date_from":"2026-10-12"}`, which `JSON.parse`
    accepted.
  - Round trip with a tool result: 147 in + 15 out, 0 tool calls, a text
    answer, with the streamed deltas byte-equal to the returned content.
  - The shapes match the real API, not only the fixtures written to imitate
    it.

**Finding carried into Phase 6:** the dummy result listed only *Overnight* as
open, and the model answered "The villa is available for booking on 12 October
2026." That is a claim about the whole day which the tool did not make. It is
the tool-result version of adding a fact the context does not state (D-017).
Phase 6's paragraph must require naming the slots, and the battery gets a
partly-open case.

**Trap avoided:** vitest runs without `.env`, so `OPENAI_CHAT_MODEL` was
undefined and `JSON.stringify` silently dropped the `model` key. The first run
failed on exactly that. Stubbing the env fixed it. Loosening the assertion
would have left the key-list test unable to notice a request with no model.

## Bookings Phase 6 — the tool in the pipeline, then measure · done 2026-09-24

**What was done:**
- **`tools.ts`.**
  - `toolsFor(tenant)` offers `check_availability` only when the tenant has
    the bookings application. Its description names the tenant's real slots
    ("Overnight (from 14:00, 22 hours)") and its timezone. The schema has only
    `date_from` and `date_to`, and no tenant or unit id (Rule 2).
  - `executeTool()` checks enablement against the database again, parses the
    arguments, and calls `checkAvailability`. A bad JSON argument or a
    `BookingInputError` becomes the result `{error}`. Anything else throws.
- **`answer.ts`.** One `toolLoop()` serves both paths, bounded by
  `MAX_TOOL_ROUNDS = 2`. `acceptReply()` is D-035. A tenant without tools
  takes the old code path, D-008's short circuit included, unchanged.
- **Streaming.** With zero chunks, the text is held (`holdContent`) until
  D-035 has decided.
- **`buildPrompt(…, tools)`.** The block goes after END CONTEXT: "a tool
  result is context too", the availability rules (including "never say a
  whole day is free unless every slot is open", from the Phase 5 finding),
  and today's date.
- **The chat route** sends a `tool` event.
- **The battery.** 9 `tool-*` cases, seeding `fixtures/villa-bookings.json`
  (Overnight at +10 days) and deleting it again.
- **Tests.** `prompt.test.ts`.

**Why it mattered:** this is the feature, and the prompt change that CLAUDE.md
rule 1 exists for. The measurement is what shows it did not cost a refusal.
The original ten verdicts are unchanged, and Northwind's prompt is the same
bytes.

**What each observed value proves:**
- **`original 9/10`, the same verdict for every one of the ten as
  `eval-pre-bookings.txt`.** Adding tools cost no refusal and no answer on the
  existing cases. `antecedent` is still the only failure (D-017).
- **Northwind's prompt, built through `toolsFor()`, has an empty diff against
  the Phase 0 snapshot.** The first attempt at this check passed trivially:
  the snapshot script was not yet passing tools, because a Python edit had
  silently failed its assertion. It was caught, and redone through the real
  path.
- **`tool-leak`: 0 tool calls and 0 OpenAI answer calls.** Northwind's refusal
  is still the free D-008 short circuit, not a model that happened to
  refuse.
- **`tool-taken`: "The Day Tour slot on 5 October 2026 is taken", from a
  fixture Overnight on 4 October.** § 2.1's cross-midnight rule, from SQL to
  the model's sentence.
- **`tool-slotfill`: "8 October", with no year, on the second turn became
  `{"date_from":"2026-10-08",…}`.** The `todo.md` flow works, and the model
  resolved the year from the "Today is 2026-09-24" line (§ 2.3).
- **`tool-docs`: 0 tool calls, 5 sources, a GCash answer.** A documents
  question on a tool tenant still goes to the documents.
- **`tool-pii`: neither "Battery Fixture" nor "555-0199" appears in the reply
  or the tool results.** Rule 3, end to end.
- **Streaming: `meta → tool → 35 deltas`.** The tool call reaches the client
  before the answer. **Zero-match on villa: held, replaced, 1 delta, 485 in +
  11 out.** D-035 works on the streaming path, and it has a cost: that
  question used to be free.
- **Tool-tenant answer calls: 1,251–1,680 input tokens.** This is the price of
  the tool definition plus the extra paragraph, and it goes into `notes.md`
  in Phase 8.

**Deviations:** there is no separate `seed` command. The battery seeds and
cleans up its own fixture, because relative dates go stale overnight.

**Findings, not fixed. Each is wording, not a wrong fact:**
- **`tool-ask`:** "I don't know based on the documents I have. Please provide
  a specific date for me to check availability." The refusal string is
  glued to a clarifying question. The grounding block's "reply exactly …"
  and the tools block's "ask for a date" are both being obeyed at once.
- **`tool-past`:** the tool returned "2020-01-01 is in the past. Today is
  2026-09-24." and the model answered with the bare refusal instead of
  saying so. It passed on the lenient branch (it did not invent
  availability). But the error message was written to be passed on, and it
  was not.
- **`tool-partial`:** each slot's status is right, under the heading "the
  following slots are available:", which then lists two taken slots.

Fixing any of them means editing the tools block, which means another eval run.

**Trap avoided:** trusting a passing check without checking that it could
fail. "NORTHWIND PROMPT: IDENTICAL" was first printed by a script that had
not been changed, and that would have been identical whatever the pipeline
did.

## Phase 6 wording fixes · done 2026-09-24

**What was done:** the three wording findings from Phase 6, fixed in the
tools block only (`tools.ts`). The grounding block was not touched. Each fix
was measured against a case tightened to fail on the old wording first. Also
added `pnpm eval <label> --only <prefix>`.

**Why it mattered:** the battery passed all three before, so it could not
have told a fix from no fix. A check that cannot fail cannot measure a
change. Tightening them first turned "the replies read oddly" into three
FAILs with the exact bad sentences in them.

**What each observed value proves:**
- **Tightened, on the unchanged prompt: tool cases 6/9.** `tool-partial`
  failed on "the following slots are available: … taken … taken",
  `tool-ask` on "I don't know based on the documents I have. Please
  provide…", and `tool-past` on the bare refusal. The checks now catch
  exactly what was seen.
- **First wording, prohibitions: 7/9.** Only `tool-past` was fixed, with "1
  January 2020 is in the past. Today is 2026-09-24.". A positive instruction
  ("tell the user what the error says"). `tool-partial` and `tool-ask`
  produced almost the same sentences as before. "Never introduce a list as
  available" and "do not add the I-don't-know sentence" were ignored.
- **Second wording, what to write instead: 9/9.**
  - `tool-partial`: "Open: Overnight / Taken: 22-Hour Whole Day, Day Tour".
  - `tool-ask`: "Which date are you referring to for availability?"
  - It is the same lesson as D-017, which had to separate "connect" from
    "add" to stop a vague prohibition. This model follows a concrete
    instruction about what to write, and loses a prohibition to the pull of
    a familiar phrase. Here the familiar phrase is the refusal sentence the
    grounding block says to "reply exactly".
- **Full battery after: 18/19, the original ten identical verdict by verdict,
  the Northwind prompt diff empty.** The fix did not leak outside tool
  tenants, and did not cost a refusal.

**New side effect, not fixed:** availability replies are now terse and
form-like. "Is the Overnight slot free on 8 October?" → "Open: 22-Hour Whole
Day, Day Tour, Overnight / Taken: None", with no date and no direct "yes".
Correct, and less natural than before. A line asking for the date first
would probably fix it, and would need another eval run.

**Trap avoided:** editing the saved before-fix output. That run printed
"original 0/10 · 6/19" because the totals still counted all 19 cases under
`--only`. The code was fixed, and the saved file's summary line was
corrected with a note saying so, rather than silently.

## Availability replies name the date · done 2026-09-24

**What was done:** the four availability cases now also fail if the reply
does not name the date (`namesDate()`: "8 October", "October 8th", "8th of
October" or "2026-10-08", and never "18 October" for the 8th). The tools
block gained a first sentence naming the date, and it was then scoped to
availability answers after the battery caught it costing a documents answer.

**Why it mattered:** "Open: 22-Hour Whole Day, Day Tour, Overnight / Taken:
None" answers "which slots?" but not "which day?". In a chat that has gone on
for a while, or across a range of dates, the reader cannot check it. And
along the way, this is the clearest example so far of a prompt edit that
passes the cases it targets while breaking one it does not.

**What each observed value proves:**
- **Old wording, tightened checks: tool cases 6/9.** `tool-open`,
  `tool-partial` and `tool-slotfill` returned bare Open/Taken lines. The new
  check catches exactly the problem.
- **Unscoped "Start with one sentence that answers the question and names the
  date": tool cases 9/9, full battery 17/19.** `leak-2` flipped from PASS.
  Northwind was fine (0 chunks, a refusal). Villa's control ("What is
  amihanpansol2019?", with 5 chunks retrieved, the first found by both
  searches) replied with the refusal. The targeted cases alone would have
  shipped this.
- **`leak-2` alone, three runs per wording: unscoped 1/3, previous 3/3,
  scoped 3/3.** The regression is caused by the sentence, not by noise, and
  scoping removes it. A Wi-Fi question has no date to name, so an
  instruction to name one for EVERY answer pushed the model onto the one
  sentence it can always say.
- **Scoped, full battery: 18/19, the original ten identical, the Northwind
  prompt diff empty.** Kept.
- **`tool-partial`: "No, the Day Tour and 22-Hour Whole Day slots are taken
  on 5 October 2026, but the Overnight slot is open."** Better than the
  unscoped run's "Yes, the Overnight slot is open…" for a question about
  the whole day, which copied the example sentence almost word for word.

**Lesson, for `risks.md` in Phase 8:** a tools-block sentence can cost a
documents answer on a tools tenant. And the battery runs each case once, so a
1-in-3 failure can pass a single run. When a verdict flips, repeat that case
under both wordings before deciding what caused it.

**Trap avoided:** testing `namesDate()` with a shell one-liner whose quoting
doubled the backslashes. It printed `false` for correct input, which looks
like a broken function. The file's own code was then extracted and tested,
and was right.

## Bookings Phase 7 — tool calls in the chat screen · done 2026-09-24

**What was done:** the chat screen shows what the tool said.
- **`chat-screen.tsx`.** Each answer turn keeps a `toolCalls` list, and every
  `tool` SSE event appends to it.
- **`sources-panel.tsx`.** A `ToolCallBox` is rendered above the collapsed
  sources and is always visible: "Checked availability · Thu 8 Oct", then one
  row per date with an open or taken chip per slot. These are the same
  `slot-chip`s as the bookings screen, so the two screens show a slot the
  same way.
- **Edge cases.** A tool error ("…is in the past") shows in red. A tool the
  screen does not know is shown as raw JSON, never hidden.

**Why it mattered:** D-012 says an answer is only checkable if you can see what
it was built from. For an availability answer, that is the tool result, not
the chunks. The box also makes R-15 visible: the dates shown are the ones the
model SENT. If it resolved "this Saturday" to the wrong day, that shows on
screen rather than in a log.

**What each observed value proves:**
- **curl SSE order: `meta → tool → 32 deltas → done`.** The tool box reaches
  the screen before a word of the answer, the same way sources arrive first
  (D-019).
- **The `tool` event payload has `name`, `args`, and `result.slots` with
  `date, unit, slot, status`, and nothing else.** No guest field reaches the
  browser, over the wire.
- **The walk, confirmed from the server log rather than only reported:**
  - "I want to check availability" → no tool call, 7 output tokens (the date
    question). "Oct 8 availability" → `check_availability {"date_from":
    "2026-10-08"}`, 3 open. The `todo.md` slot-filling flow works in the real
    UI.
  - "Can I book the Day Tour on 23 October 2026?" → 1 open of 3. The user's
    own walk booking #27 (Overnight 22 Oct) blocks the next morning, seen
    end to end in the chat.
  - "How do I pay the reservation fee for the Overnight slot?" → 0 tool calls,
    5 sources. It mentions a slot and is still answered from the documents.
  - Northwind "Is the villa free on 8 October 2026?" → `0 chunks`, and no
    `[openai]` line after it. The free D-008 short circuit is intact in the
    running app.
- **Bundle grep `service_role|guest_phone|admin_key|SUPABASE` → 0.**

**Trap avoided:** putting the tool result inside the collapsed sources
`<details>`. For a tool answer that would hide the one thing it rests on,
behind a click that most readers never make.

## Bookings Phase 8 — the record · done 2026-09-24

**What was done:** the documentation, so the repo stops describing a bot that
only reads documents.

| File | What changed |
|---|---|
| `CLAUDE.md` | the header names the bookings plan. Rule 6 covers the four new tables and says the model never supplies a tenant. New rule 7: tool results carry no PII, and tools are read-only. Trap 6 is amended for D-035. New traps: 8 "check, then insert", 9 the tenant's today, 10 a tools-block sentence costing a documents answer |
| `decisions.md` | D-032–D-037 in the house format, and D-008 amended in place, saying what changed and why the guarantee still holds |
| `risks.md` | R-14–R-18, and the "still missing" list extended |
| `architecture.md` | the bookings tables in § 4, the six routes and the SSE `tool` event in § 5, the tools block and D-035 in § 6 |
| `flow.md` | the tool loop in the sequence diagram, and step 11a |
| `notes.md` | the bookings section: the battery, the wording history, the leak-2 repeats, and the cost |
| `README.md` | status, four SQL files and nine tables, the bookings screen and the Checked box |

**Why it mattered:** the next reader, human or model, starts from these files.
A `CLAUDE.md` that still said "short-circuit the empty retrieval, do not call
OpenAI" would send them to "fix" D-035 back into D-008, and make the tool
unreachable again.

**What each observed value proves:**
- **Tools off → on, the same villa question with the same 5 chunks: 1,260 →
  1,682 and 1,279 → 1,701 input tokens.** Measured for this phase from
  `eval-pre-bookings.txt` against `eval-post-date-scoped.txt`, not estimated.
  The tool definition and the block cost **+422 input tokens on every answer
  call of a tool tenant**, documents questions included. An availability
  answer makes two calls, about 3,300–3,500 input tokens.
- **Every other number in the new sections is one observed in Phases 0–7:**
  the `during` range, `23P01`/`23503`/`22023`, 18/19, 6/9 → 7/9 → 9/9, 1/3 vs
  3/3, 485 + 11, 0 answer calls, 13/13, 28/28. Tool-call latency was not
  measured, and `notes.md` says so rather than giving a number.

**Deviation:** `todo.md` was not edited. It holds the user's own uncommitted
changes, and committing them inside a docs commit would publish someone
else's work under this one's message. Its items "add tool calls for dynamic
data" and "chatbot can ask question" are both done.

**Trap avoided:** leaving trap 6 as it was. It is true for Northwind and wrong
for villa. A rule that is half right is the one most likely to be followed
into a regression.

## Phase 4's missing step, confirmed · 2026-09-24

**What happened:** after the merge, the user cancelled booking #27 (the
Overnight on 22 Oct from the Phase 4 walk) from the admin screen, on this
repo's own `next dev` (:3000, PID 16536).

**What it proves:** #27 is `status = 'cancelled'`, the row is kept and not
deleted, and `check_availability` for 22–23 Oct returns **6 of 6 open**. The
Overnight had made the 23rd's Day Tour and 22-Hour taken. The UI Cancel
button → `DELETE /bookings/27` → `cancelBooking` → the exclusion constraint
ignoring cancelled rows. That is the step the Phase 4 walk recorded as
unconfirmed, now proven from the browser as well as by Phase 3's curl.

---

# Auth + RLS

## Auth + RLS plan written · done 2026-09-24

[`plan/auth-rls.md`](./plan/auth-rls.md), Phases 0–8. It makes Postgres
enforce the tenant, rather than every query holding the `service_role`
master key and remembering a filter. It also replaces the shared per-tenant
admin key with staff accounts.

### What was decided before writing, and why those three

| Decision | Why this one |
|---|---|
| Staff log in with **Supabase Auth** (D-040) | password storage, reset tokens and email verification are the parts where a readable hand-rolled version is also the dangerous one. Our HMAC session cookie stays; the shared key goes |
| **Tenant tokens on every request, chat included** (D-039) | the anonymous chat is the path open to the internet. Leaving it on `service_role` would protect the admin path, which is already behind a login, and not the exposed one |
| **One role** (D-041) | the smallest policy set that works. A role column can come later |

### The finding that shaped Phase 0

The `.env` contains `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` and
`SUPABASE_JWKS_URL` (names only were read, never values). So the project uses
Supabase's asymmetric JWT signing keys, and Supabase holds the private key.
The whole design needs the server to mint a token PostgREST accepts, and that
may not be possible the simple way. So Phase 0 is a spike with three ranked
options:
- **A:** our own key, imported as a signing key;
- **B:** the legacy shared secret, a bridge with a deadline;
- **C:** a direct Postgres connection with `set local role` and
  `request.jwt.claims`.

It has an explicit stop condition. The design must not quietly fall back to
`service_role`.

### The rules at the top

1. **Two walls, each tested alone.** The code filters stay. RLS must stop a
   leak with the filter removed (`select * from chunks` under villa's token
   returns only villa's rows), and the filters must still pass their suites.
2. **`service_role` leaves the request path,** with an import check.
3. **No prompt changes,** so the battery must match 18/19 verdict by verdict.
   A flipped verdict is a policy that is too tight.

### Traps written down before they cost anything

- **The signing key is itself a master key** (R-19). The gain is that one
  function uses it, for one narrow token.
- **RLS can cost the vector index** through non-leakproof quals. Measure it
  as a token, not as `service_role`.
- **`auth.uid()` casts `sub` to uuid,** so a chat token must carry no `sub`,
  or policies error instead of denying.
- **`check_availability` must become `security definer`,** or a chat token
  would need SELECT on `bookings`, which holds guest PII.
- **Supabase's default email sender is for testing.** Custom SMTP comes
  before real staff.
- **The eval and the tools need identities too:** an operator member per
  tenant, not a quiet `service_role`.

### Status

Nothing is built yet. Next is Phase 0, which needs the Supabase dashboard.

---

## Auth + RLS Phase 0 — the signing spike, and the baseline · done 2026-09-26

**What was done:**
- Wrote `plan/auth-phase0-spike.sql`: a throwaway `whoami()`, which returns
  `auth.jwt()`, and `auth_explain()`, which is tenancy's explain helper again,
  executable by `service_role` only.
- Wrote `packages/db/tools/auth-spike.mjs`, which signs JWTs by hand on
  `node:crypto` and calls `whoami()`.
- Generated an EC P-256 key into the gitignored `scratch/`. The user imported
  it in the dashboard as a **standby** JWT signing key.
- Ran the full baseline into `plan/baseline/*-pre-auth.txt`. The spike's
  evidence is in `plan/baseline/auth-spike-phase0.txt`.

**Why it mattered:** the whole plan rests on the server minting a token that
PostgREST accepts. The project uses asymmetric signing keys, so Supabase holds
its own private key, and none of this was guaranteed. The plan had a stop
condition for exactly that case.

**What each observed value proves:**
- **`401 PGRST301 "No suitable key was found"` before the import, then `200`
  with `{"role": "authenticated", "tenant_id": 3}` after it.** The code and the
  claims were identical and the key was the same key; only its registration
  changed. So the pass means PostgREST trusts our key, not that it accepts
  anything, and the claims reach Postgres unchanged. That settles option A
  (D-039). B and C were not tried.
- **The JWKS lists `ea5ce335…` (ours) next to `cb77f580…` (Supabase's).**
  Standby keys are published for verification.
- **A Supabase Auth sign-in after the import still has `kid=cb77f580…`.**
  Importing as standby did not change what Auth signs with. Staff tokens stay
  Supabase's, and chat tokens are ours.
- **Auth token claims:** `iss https://…supabase.co/auth/v1`, `aud
  authenticated`, `role authenticated`, a uuid `sub`, a 3600 s lifetime, and
  `app_metadata.provider email`. There is no tenant claim. Phase 3 will have
  to derive the tenant from `memberships`, not from the token, as planned.
- **`{"role": "anon"}` from `whoami` with only the publishable key.** The
  publishable key is not a JWT, and PostgREST maps it to `anon`.
- **Anon calling `auth_explain` gets `42501 permission denied`.** The
  arbitrary-SELECT helper is not reachable from the browser key.
- **Baseline:**
  - verify 28/28, isolation 11/11, bookings isolation 12/12;
  - eval 18/19 (`original 9/10 · tool 9/9`, `antecedent` only);
  - `prompt-snapshot` is byte-identical to the pre-bookings file (sha256
    `d6337d0f…`);
  - villa's inlined `match_chunks` as `service_role` is a `Seq Scan on
    chunks c, Filter: (tenant_id = 3)` plus a top-N heapsort: 5 rows,
    0.974 ms. At 34 chunks the planner does not use an index. This is the
    plan Phase 2 re-runs under a tenant token.

**Deviation:** bookings isolation printed **12** PASS lines, and the docs
said 13. The script contains 12 `check(` calls, and the Phase 2 baseline file
(`isolation-bookings-phase2.txt`) also has 12. So nothing regressed; the "13"
was a miscount from the start. It is corrected in CLAUDE.md and
`plan/auth-rls.md`, and historical records are left as written.

**Traps avoided:**
- An ES256 JWT signature must be raw `r||s` (`dsaEncoding: 'ieee-p1363'`),
  not node's default DER.
- Importing the key as *active*, or rotating it, would have moved Supabase
  Auth onto our key.
- **Not yet safe:** the spike key's private half was shown in the session
  transcript. Phase 3 generates a fresh key, keeps it only in `.env`, and
  deletes `ea5ce335…` in the dashboard.

**R-13's partial answer:** the dashboard's rate limit for sign-ups and
sign-ins is **30**, one limit shared by both. The window was not noted.
Password guessing against a staff account is throttled by Supabase, not by
us.

---

## Auth + RLS Phase 1 — policies and memberships · done 2026-09-26

**What was done:**
- Wrote `packages/db/sql/schema-auth.sql`, which is idempotent. The user ran
  it in the SQL editor. It adds:
  - `memberships (user_id → auth.users, tenant_id → tenants)`;
  - `app_tenant_id()` and `app_is_admin()`;
  - 17 policies across `documents`, `chunks`, `conversations`, `messages`,
    `tenant_applications`, `units`, `slots`, `bookings` and `memberships`.
    `tenants` has none, on purpose;
  - `check_availability` rewritten as `security definer` with
    `search_path = ''` and a tenant check;
  - `tenant_public(slug)`;
  - EXECUTE revoked from `public`/`anon`/`authenticated`, then granted back
    exactly: `tenant_public` to anon, the rest to authenticated, and
    service_role explicitly on every function.
- `verify.mjs` gained 19 checks, which mint tenant tokens with the Phase 0
  key (`TENANT_SIGNING_JWK` in `.env`). They run through the publishable key
  and create and delete their own probe tenant and Supabase Auth user.
- `database.types.ts` gained `memberships`, the helpers, `tenant_public` and
  `whoami`.

**Why it mattered:** these policies are the second wall (Rule 1). Every
check before this ran as service_role, which bypasses RLS, so no policy had
ever been observed. The app still runs as service_role, so this phase could
be applied, and proved, with nothing in the app changed.

**What each observed value proves:**
- **villa's chat token, NO filter: documents 8/8, chunks 30/30,
  conversations 141/141, messages 368/368, and 0 foreign rows each.** RLS
  alone confines reads to the token's tenant. The equal counts show it is
  not too strict either. A too-strict policy would pass "no foreign rows"
  on fewer rows, and flip eval verdicts in Phase 4.
- **A probe token calling `match_chunks` with another tenant's
  `p_tenant_id`: 0 rows.** The code filter said yes and RLS said no, and
  RLS won inside a security-invoker function. The same call under the
  chunk's own tenant token finds the chunk first (148).
- **Anon: 0 chunks, and `42501` on `match_chunks`.** The publishable key
  alone gets nothing, not even the search function.
- **A chat token reads 0 of the probe's 5 bookings and cannot insert one
  (`42501`), but `check_availability` gives it 6 rows with "taken" in
  them.** Availability works without row access to guest data (§ 2.5).
- **`check_availability` with villa's id under the probe's token:
  `42501 … tenant 3 is not the token's tenant`.** The definer function
  enforces the tenant itself, since RLS does not apply inside it.
- **`app_is_admin()` under a chat token: `false`, not an error.** A chat
  token has no `sub`, as § 2.4 intended.
- **A chat token reads 0 `tenants` rows. `tenant_public('villa')` keys are
  exactly `assistant_name,banner_url,business_name,id,logo_url,slug,theme`.**
  `admin_key_hash` has no path to a token.
- **Staff with no membership: `42501`. With a membership: insert, then
  `deleted 1`.** Admin needs the database's agreement, not only the claim.
- **A member of the probe with a token claiming villa: `42501` on the
  document insert, `42501` on the booking insert, 0 of villa's 3 bookings
  read.** A minting bug that names the wrong tenant cannot write, and cannot
  read guest data.
- **A real Supabase Auth token: 0 chunks.** A staff login alone carries no
  tenant, so it reaches nothing until the server mints a tenant token.
- **The app is unchanged:**
  - verify's original 28 checks still pass;
  - isolation 11/11, bookings isolation 12/12;
  - eval 18/19 (`original 9/10 · tool 9/9`), with PASS/FAIL lines identical
    to `eval-pre-auth.txt`;
  - `prompt-snapshot` byte-identical.

  Files: `plan/baseline/*-auth-phase1.txt`.
- **Both service keys reach `auth.jwt()` with `role: service_role`**
  (checked with `whoami`). That is what `check_availability` lets through.
  The legacy service_role JWT is still accepted, so the legacy HS256 secret
  is live. That is not needed now (D-039 is option A), but it is a second
  master key that still exists.

**Deviations from the plan, with the reasoning:**
1. **`app_is_admin()` is security invoker, not definer.** The plan's § 1.2
   sketch said definer, which contradicts D-042's "exactly two definer
   functions". Invoker is enough: the `memberships` policy lets a user read
   their own rows, and that is all the function reads. It also leaves
   `memberships` under RLS. The plan now notes this at the sketch.
2. **Every write policy checks the tenant AND admin.** The plan's § 1.3
   table lists only `app_is_admin()` for writes. That proves "admin of the
   token's tenant", not "writing into the token's tenant", so on its own
   it would let an admin of A insert a row carrying B's id.
3. **`tenant_public` is granted to anon.** It is called before the server
   knows the tenant, which is Phase 3 step 3 of the plan itself. Everything
   it returns is already on the public page.

**Traps avoided:**
- **A check that passes on zero rows.** Before the SQL was run, a chat
  token read 0 chunks, so every "only villa's rows" check would have passed
  vacuously. Check 28 fails unless the token sees more than 0, and it did
  fail before the run: `villa's token sees 0 chunks`.
- **A check refused by the wrong guard.** The first wrong-tenant booking
  insert got `23503` from the slot trigger, which fires before RLS. It
  proved nothing about RLS. With villa's own unit and slot, only RLS could
  refuse the insert, and it did (`42501`).
- **Per-row policy functions.** Every policy calls
  `(select public.app_tenant_id())`, which runs once as an InitPlan and
  makes the qual `tenant_id = $1`. Whether the plan really is unchanged is
  Phase 2's measurement.

---

## Auth + RLS Phase 2 — the index under RLS, measured · done 2026-09-26

**What was done:**
- Explained the bodies of `match_chunks` and `match_chunks_fts` for villa
  twice: as service_role, which has no RLS, and as villa's tenant token,
  under the Phase 1 policies.
- Each was run with the planner's default and with seq scans off. There was
  also a forced-HNSW pair.
- Compared the ids each role gets from the real functions.
- The helpers are in `plan/auth-phase2-explain.sql`, the runner is
  `auth-spike.mjs phase2`, the output is
  `plan/baseline/explain-auth-phase2.txt`, and the write-up is in `notes.md`.

**Why it mattered:** RLS applies policies as security-barrier quals, which
can quietly change what the planner is willing to do with an index. The
results stay correct and the plan gets slower (§ 2.3). The only way to see
it is to explain AS a token. The Phase 0 baseline was service_role and could
not show it.

**What each observed value proves:**
- **Every token plan uses the same scan as its service_role twin.** Seq Scan
  for Seq Scan, `chunks_tenant_idx` for `chunks_tenant_idx`, in all four
  pairs. The policy adds no access path and removes none.
- **`InitPlan 1` plus `One-Time Filter: ((InitPlan 1).col1 = 3)`.** The
  policy's `app_tenant_id()` is evaluated once per query, not per row, and
  folded against the query's own `tenant_id = 3`. That is the
  `(select …)` wrapping from Phase 1 working as intended.
- **Identical ids** (`142 · 162 · 143 · 168 · 149`, and `149 · 156 · 168 ·
  161 · 150`). Under the policies, the searches return the same rows. That
  is Rule 3's precondition for Phase 4 moving chat onto tokens.
- **Forced HNSW: service_role walks `chunks_embedding_idx`, while the token
  takes `chunks_tenant_idx` with `Index Cond: (tenant_id = (InitPlan
  5).col1)`.** The policy qual is usable as an index condition, so
  leakproofness is not blocking it. The planner prefers an exact tenant-scoped
  sort to the forced walk. That is not a regression: it is the plan tenancy
  Phase 2 found the real query already uses at this size.
- **A chat token without `app_explain` → `42501`.** The token-callable
  explain helper is unreachable with any real token.

**Chosen:** nothing to change. There is no `leakproof` marking and no policy
rewrite.

**What this does not settle:** whether HNSW is still picked under RLS for a
tenant large enough that the B-tree plus sort costs more. That is R-10's
scale question. It is now written down to be re-measured as a token, since
from Phase 4 that is how searches run.

**Trap avoided:** my first forced-HNSW attempt ran from `scratch/`, where
`@supabase/supabase-js` does not resolve, and its error text was appended to
the results file. The pair was moved into `auth-spike.mjs phase2` and the
file regenerated, so the evidence is one clean, reproducible run.

---

## Auth + RLS Phase 3 — tenant tokens and scoped clients · done 2026-09-26

**What was done:**
- **`@rag/db`:**
  - `src/tenant-client.ts` holds `mintTenantToken({ tenantId, userId?,
    admin? })`, hand-rolled ES256 on `node:crypto` in about 30 lines.
  - It has no `role` parameter, so it cannot mint `service_role`. The token
    lasts 5 minutes. It validates the tenant id and the uuid, and an admin
    token requires a user.
  - The same file holds `scopedClient(token)` and `anonClient()`.
  - The service client moved to the `@rag/db/service` entry point, and the
    main entry no longer exports `supabase`, so every old import stopped
    compiling.
- **Pipeline and bookings:**
  - `TenantContext` and `BookingTenant` gained `db`.
  - All 22 `supabase.` calls in `@rag/pipeline` and `@rag/bookings` became
    `tenant.db.`, and every `tenant_id` filter stayed.
  - `loadTenant(slug)` calls `tenant_public` with no token, then mints a
    **chat** token for the tenant it found.
- **Web app:**
  - `loadBranding` uses `tenant_public`.
  - `env.ts` requires `SUPABASE_PUBLISHABLE_KEY` and `TENANT_SIGNING_JWK`.
- **Tools:**
  - they use `@rag/db/service` for setup only: the fixture, the probe
    tenants, and the admin writes until Phase 5;
  - `verify.mjs` now uses the shipped `mintTenantToken`;
  - rag isolation gained `--filters-only`.
- **Key swap:**
  - generated a fresh key (`45345cbc…`) without displaying it, and the user
    imported it as standby;
  - swapped `.env`;
  - the spike key `ea5ce335…` is revoked.

**Why it mattered:** this is the step where Postgres starts enforcing the
tenant on real requests. Until now the policies existed, but everything
bypassed them. It is also where a forgotten tenant stops meaning "a query
without a filter" and starts meaning "no database at all": there is no
module-level client left to reach for.

**What each observed value proves:**
- **Eval 18/19 (`original 9/10 · tool 9/9`), PASS/FAIL identical to
  `eval-pre-auth.txt`, with every question on a chat token.** The whole chat
  path runs under RLS and returns the same answers and refusals: retrieval,
  history, the transcript and the `check_availability` tool. No policy is too
  tight (Rule 3).
- **rag isolation 11/11 on chat tokens, AND 11/11 with `--filters-only`.**
  - The first run has both walls up.
  - The second has the service client under every context, so RLS is
    bypassed and only the code filters stand.
  - That is Rule 1's "filters alone" half, still true after the refactor.
    (Phase 1's verify checks are the "RLS alone" half.)
- **bookings isolation 12/12.** Staff operations run on the service client,
  which is filters alone. Availability runs on chat tokens, through the
  security-definer function's own tenant check.
- **verify 47/47 with the shipped signer, then again on the new key.** The
  19 RLS checks now test the code the app mints with, not a copy.
- **The token header now carries `kid 45345cbc…`.**
  - A token from the revoked spike key gets `401 PGRST301`.
  - A `mintTenantToken` token gets `200` from `whoami`, with
    `{"role":"authenticated","tenant_id":3}`.
  - The JWKS lists only `45345cbc…` and `cb77f580…`.
  - The key whose private half was in the transcript no longer opens
    anything.
- **`grep -rn "@rag/db/service" apps packages/*/src`** prints the one
  documented exception (`apps/web/lib/admin-auth.ts`) plus comments.

**Deviations from the plan, with the reasoning:**
1. **The done-when grep has one hit, not zero.** `checkAdminKey()` must read
   `tenants.admin_key_hash`, and by design no token can. The admin key is
   the plan's own "way back in" until Phase 6, which deletes it. So the
   exception is commented at the import and ends in Phase 6, whose REQUIRED
   list already drops the service key.
2. **Phase 4's step 1 happened here.** `loadTenant` mints the chat token, so
   `withTenantRoute` attaches a chat context to every route already. There
   was no way to keep apps/ off the service client (this phase's grep)
   without it.
3. **The tools' admin writes use the service client, labelled**, until
   Phase 5's operator member. § 2.7 wants staff tokens there. That needs a
   real member, which Phase 5 creates.

**Consequence, known and temporary:** between now and Phase 5, the admin
routes run on chat tokens.
- Ingest, delete and booking writes are refused (`42501`).
- The bookings screen shows **no bookings** rather than an error, because
  "not yours" and "not there" look the same, by design.
- Admin login still works.

**Traps avoided:**
- **Sourcing `.env` in bash** strips the quotes out of the JWK JSON.
  `node --env-file` never overrides a variable that is already set, so verify
  read the mangled copy: `SyntaxError … at position 1`. It was diagnosed
  without printing the key, and re-run with the variable unset.
- **One standby key at a time.** The dashboard hides "create standby" while
  one exists. The old one had to be removed before the new import, which
  leaves a short window in which no tenant token verifies.
- **Showing the key.** The new key went from the file to the clipboard with
  `clip`, and was never opened, selected or printed.

---

## Auth + RLS Phase 4 — the chat path on chat tokens · done 2026-09-26

**What was done:**
- Took `SUPABASE_SERVICE_ROLE_KEY` off `apps/web/lib/env.ts`'s REQUIRED
  list.
- `admin-auth.ts` now imports `@rag/db/service` lazily, inside
  `checkAdminKey()`, and throws its own clear error when the key is missing.
- Wrote `plan/auth-phase4-walk.sh`: nine HTTP checks of the chat path.
- Ran the walk against `pnpm dev` twice. Run A had the service key set. Run
  B had it **empty in the web process**. Outputs:
  `plan/baseline/walk-auth-phase4-{with,no}-key.txt`.

**Why it mattered:** Phase 4's done-when is that no chat code path needs
the master key. The eval had already shown that chat is correct under RLS.
It could not show that the web process runs without `service_role`, because
the eval is a tool, and tools keep the service key for setup.

**What each observed value proves:**
- **Runs A and B are identical on every chat line**, with ids, delta counts
  and the admin line excluded from the diff:
  - `/t/villa` is 200 and `/t/nope` is 404;
  - the parking answer comes with 5 villa sources;
  - the transcript has 2 messages;
  - northwind is refused villa's transcript with a 404, and refuses villa's
    fact with 0 sources;
  - availability for 5 November 2026 called `check_availability`, which
    returned 3 open slots;
  - the SSE run gives `meta`, then `delta`s, then `done`.

  So the page, retrieval, history, the transcript, the tool (through the
  security-definer function) and streaming all run on the publishable key
  plus a chat token.
- **Admin-key login, run B: `500 "Admin-key login needs
  SUPABASE_SERVICE_ROLE_KEY until auth-rls Phase 6"`.** The one remaining
  use of the master key in the web app is exactly where the comment says
  it is, and it fails with its own message, not a generic one.
- **The admin page renders (200) in run B.** Importing `admin-auth.ts` no
  longer constructs the service client, so pages and routes that only call
  `requireAdmin()` or `readSession()` load without the key.
- **The Phase 4 measurements come from Phase 3's run:**
  - eval 18/19, with verdicts identical to `eval-pre-auth.txt`;
  - isolation 11/11 (and 11/11 `--filters-only`);
  - bookings isolation 12/12;
  - snapshot byte-identical.

  Since then, only `apps/web/lib` has changed. No pipeline or package code
  has.

**Deviation:** removing the key from REQUIRED is a Phase 6 item, done
early. Without it, `assertEnv()` fails every route when the key is missing,
chat included, so Phase 4's own done-when could not pass.

**Traps avoided:**
- **"Unset" means empty, for `next dev`.** The dotenv loader in
  next.config fills any variable that is not already defined from `.env`, so
  `env -u` would have quietly put the key back. `SUPABASE_SERVICE_ROLE_KEY=`
  (empty) counts as defined, and it stays empty.
- **A top-level import is a startup cost.** With `@rag/db/service` imported
  at the top of `admin-auth.ts`, every admin route would construct the
  service client at load, and supabase-js throws on an empty key. The
  import is lazy now.
- **Testing the prompt instead of auth.** The walk's first draft asked a
  question the villa documents do not answer (check-in time), and wrote the
  date in ISO form, which made the model ask "Which date do you mean?"
  instead of calling the tool. Neither was an auth effect. The walk now uses
  the phrasing the passing suites use.

---

## Auth + RLS Phase 5 — staff accounts · done 2026-09-26 (reset email pending)

**What was done:**
- **`@rag/db` `src/staff-auth.ts`:**
  - `signInStaff` (Supabase Auth `signInWithPassword`; the session is revoked
    straight away with `signOut({ scope: 'local' })`);
  - `staffClient(tenantId, userId)`: mints a staff token, then reads the
    membership through it, relying on `memberships_read_own`;
  - `requestPasswordReset`, and `setPasswordWithToken` (a raw
    `PUT /auth/v1/user`).
- **`apps/web/lib/admin-auth.ts` rewritten:**
  - the cookie is now `<slug>.<userId>.<expiry>.<mac>`;
  - `requireAdmin()` is async and returns a staff context;
  - all 9 guarded handlers start with `tenant = await requireAdmin(request,
    tenant)`.
- **Login and reset UI:**
  - `LoginForm` takes email + password, with "Forgot password?";
  - `/t/<slug>/admin/reset` is served by `reset-password.tsx`, which reads
    the token from the #fragment, wipes it from the address bar, and posts it
    once to `…/admin/password`;
  - `…/admin/password-reset` sends the email;
  - 429 now passes through the error map.
- **The member CLI and the operator:**
  - `tools/member.mjs` has add, remove, list and operator;
  - `@rag/db/service` gained `operatorEmail`, `userIdByEmail` and
    `asOperator`;
  - the eval's seeding, rag isolation's probe ingest, and bookings
    isolation's staff work all run as the operator member on staff tokens.
    Bookings isolation also gained `--filters-only`.
- **`tools/staff-cases.mjs`** runs the plan's six cases and more over HTTP.

**Why it mattered:** this replaces one shared key per tenant, which anyone
holding could use and nobody could revoke for just one person, with accounts.
The database checks each account's membership on every write
(`app_is_admin()`), and the app re-checks it on every request. It also
brings back the admin writes that Phases 3–4 had knowingly broken.

**What each observed value proves**
(`plan/baseline/staff-cases-auth-phase5.txt`, and the web process had
`SUPABASE_SERVICE_ROLE_KEY` EMPTY throughout):
- **1: a member's login → 200, and a four-part cookie.**
- **2, 3, 4: a wrong password, an unknown email, and a real account that is a
  member of nothing → 401 each, with byte-identical messages.** The login
  reveals nothing about which emails exist or who belongs where.
- **6: northwind's cookie sent by hand to villa → 401.** The slug inside the
  HMAC is checked, not just the browser's cookie path.
- **5: the member removed mid-session → the SAME cookie gets 401 `"…no longer
  a member of villa"`, and the session endpoint says `admin: false`.**
  Removal takes effect on the next request, not at cookie expiry.
- **A member adds (201) and deletes (200) a document, and books a slot (201)
  and lists it back with its guest name.** Staff tokens read guest data where
  chat tokens cannot. A chat token would also have got `200 []` from the list,
  which is why the check books a real row.
- **All of it runs with no service key in the web process.**
  `grep @rag/db/service` over apps/ and packages/*/src finds no imports:
  Phase 3's one exception is gone.
- **The suites** (`plan/baseline/*-auth-phase5.txt`):
  - verify 47/47;
  - rag isolation 11/11, and 11/11 `--filters-only`;
  - bookings isolation 12/12 on operator staff tokens, and 12/12
    `--filters-only`;
  - eval 18/19 with verdicts identical to the pre-auth baseline, its fixture
    now seeded by a staff token;
  - snapshot byte-identical; unit tests 13 + 14 + 27 + 45.
- **The browser, from the server log:**
  - `member:add` sent an invite to a yopmail.com inbox;
  - the link opened the reset page, and `POST …/admin/password` returned 200;
  - `POST …/admin/session` returned 200, then `DELETE` logged out.

  The invite path works end to end.

**Pending:** the "Forgot password?" email.
- Both attempts got `429 over_email_send_rate_limit`: Supabase's built-in
  sender had used up its hourly cap (R-21).
- The recovery link lands on the same page, with `type=recovery` instead of
  `invite`, and posts to the same route. Retry it once the cap resets.

**Deviations from the plan, with the reasoning:**
1. **The admin-key login is removed in Phase 5, not kept until Phase 6.**
   - A key session has no user, so there is no `sub` to mint a staff token
     for. Keeping it would have meant keeping the service client in the web
     app for the key path.
   - The plan's "way back in" is served better by `member:add`, which runs
     with service_role in a tool and can always create a member.
   - Phase 6 is left with the column drop, deleting `admin-key.ts` and
     `tenant:key`, and the import check.
2. **`requireAdmin()` returns the staff context, and callers reassign
   `tenant`.** The plan says requireAdmin "mints a staff token". Making the
   guard's result the only way to get one means no line after it can use
   the chat token by mistake.
3. **The membership check reads through the staff token** (the
   `memberships_read_own` policy), not with service_role. So the check itself
   is under RLS.
4. **`setPasswordWithToken` is a raw `fetch`**, not supabase-js's
   `updateUser()`. That needs a full session (refresh token included) set on
   a client. The access token from the link is all the call needs, and the
   browser gets no supabase-js at all.

**Traps avoided:**
- **A check that passes for the wrong reason.** "200 and an array" from the
  bookings list is also what a chat token gets. The check books a real row
  and requires its guest name back.
- **One message for two limits.** Supabase has a sign-in limit and an email
  cap. "Wait a few minutes" was wrong for the hourly email cap, so
  `over_email_send_rate_limit` now gets its own message.
- **`process.exit()` on Windows** with a supabase-js keep-alive socket open
  crashes Node (`!(handle->flags & UV_HANDLE_CLOSING)`) and buries the real
  message. `member.mjs` now throws, prints the message alone, and lets Node
  exit by itself.
- **A token in the address bar.** The reset page wipes the `#access_token`
  from history as soon as it has read it.

---

## Auth + RLS Phase 6 — remove the old · done 2026-09-26

**What was done:**
- Deleted `packages/db/src/admin-key.ts` and its three exports.
- Deleted the `tenant:key` script and the key half of `tenant.mjs`.
  `tenant:add` stays, and now points at `member:add` for a new tenant's first
  admin.
- Removed `admin_key_hash` from `database.types.ts`.
- `schema-auth.sql` gained § 7, `alter table tenants drop column if exists
  admin_key_hash`, which the user ran.
- Added `scripts/check-service-imports.mjs`. The root `typecheck` runs it
  before turbo.
- Two items the plan lists here were done early: the service key left the
  REQUIRED list in Phase 4, and the key login was removed in Phase 5.

**Why it mattered:** Rule 2 said `service_role` leaves the request path, and
until now nothing enforced it but a grep someone had to remember to run. A
column that holds nothing still has to be guarded: `select('*')` would fetch
it into whatever object it lands in. Dropped, it cannot be fetched.

**What each observed value proves:**
- **`select admin_key_hash` → `42703 column tenants.admin_key_hash does not
  exist`, and `tenants` now has 8 columns** (`id, slug, business_name,
  assistant_name, logo_url, banner_url, theme, created_at`). The last way to
  a shared admin secret is gone.
- **The guard, planted:**
  - `apps/web/lib/planted-service-import.ts` and `./service.js` inside
    `packages/db/src/index.ts` → exit 1, naming both lines;
  - with them removed → `OK … (6 roots)`, exit 0.

  It catches the package-internal path, not just the public specifier.
- **A fresh `next build` with `SUPABASE_SERVICE_ROLE_KEY` empty passes**:
  `✓ Compiled successfully`, and all four `/t/[tenant]` routes built
  (`plan/baseline/next-build-auth-phase6.txt`). The web app neither builds
  with the master key nor needs it.
- **After the drop:**
  - verify 47/47;
  - rag isolation 11/11 and 11/11 `--filters-only`;
  - bookings isolation 12/12 and 12/12 `--filters-only`;
  - snapshot byte-identical; unit tests 13 + 14 + 27 + 45;
  - staff cases all pass, against a dev server with no service key.

  Nothing still depended on the column.
- **`tenant.mjs key` → `the command is "add" (tenant:key was removed …; use
  member:add)`.** A stale habit gets pointed at the replacement.

**Not re-run:** the eval. This phase changed no pipeline, prompt or
retrieval code, and CLAUDE.md rule 1 ties the eval to `buildPrompt()`
edits. The Phase 5 run (18/19, identical verdicts) stands.

**Trap hit, and caught:**
- To remove the planted import I ran `git checkout --
  packages/db/src/index.ts`. That also reverted an uncommitted edit to the
  same file, so the deleted admin-key export came back.
- The diff check straight after showed it, and the edit was re-applied.
- The lesson: remove a planted line by editing it out, never by checking out
  a file that has other uncommitted work in it.

---

## Auth + RLS Phase 7 — the walk, and the bundle · done 2026-09-26 (email items owed)

**What was done:**
- The user walked steps 1–5 in a real browser as `villa-staff-test@yopmail.com`
  (a member of villa since Phase 5): log in, add and delete a document, book
  and cancel a slot, ask the chat about availability, log out.
- Two fresh production builds were grepped for secrets: one with
  `SUPABASE_SERVICE_ROLE_KEY` empty, and one with the full `.env`.
- The walk's own record is the dev server log. The grep's is
  `plan/baseline/bundle-grep-auth-phase7.txt`.

**Why it mattered:** everything before this was HTTP and scripts. This is the
same path a person takes, through the real screens, on staff and chat
tokens. The grep checks the one thing no server-side test can see: what the
browser downloads.

**What each observed value proves:**
- **The walk, in the log:**
  - `POST …/admin/session 200`;
  - `POST …/documents 201`, then `DELETE …/documents/90 200`;
  - `POST …/bookings 201`, then `DELETE …/bookings/185 200`;
  - two `POST …/chat 200`, with `[tool] villa check_availability … -> 3
    slots, 3 open`;
  - `DELETE …/admin/session 200`.

  Staff writes on staff tokens, and the chatbot's tool on a chat token, both
  work from the real screens.
- **The bundle:**
  - The patterns: `service_role`, `SUPABASE_SECRET`, `SUPABASE_SERVICE_ROLE`,
    `TENANT_SIGNING_JWK`, `guest_phone`, `@rag/db/service`, `admin_key_hash`.
  - The values: the signing key's kid and private `d`, and the values of the
    service-role, secret, OpenAI and cookie-secret keys.
  - Result: **0 files of 36, in both builds.**
  - The values matter on the full-`.env` build, where every secret existed
    at build time and could have been inlined.
  - The positive control finds `Checked availability` (1), `Forgot
    password?` (3) and `access_token` (1, the fragment's key name read by the
    reset page), so the grep does see the bundle.
- **Step 6 (a northwind member at villa → 401)** stands on `staff-cases.mjs`
  case 6, over HTTP: northwind login 200, then villa's documents `401 "Admin
  login required for villa"`.

**Owed, all to R-21's email cap:**
- `member:add -- northwind northwind-staff-test@yopmail.com` got `email rate
  limit exceeded`. No half-made account was left behind (checked).
- Step 6 in the browser, which needs that account.
- The "Forgot password?" email from Phase 5.

**Trap avoided:** a clean grep for a secret's value on a build made WITHOUT
that secret proves nothing, because it could not have been inlined. So the
value checks were repeated on a build with the full `.env`.

**Housekeeping:** booking #185 is a real, cancelled row in villa's history,
from the walk. That is what the admin screen's cancel does, by design (it is
a status change, not a delete).

---

## Auth + RLS Phase 8 — the record · done 2026-09-26 · **auth-rls complete**

**What was done:**
- **CLAUDE.md:**
  - Rule 2 is "no request holds a key that bypasses RLS, and no secret
    reaches the browser", with the import check and the bundle grep (for
    values too).
  - Rule 6 is the two walls, each tested alone, and how to prove each.
  - A new rule 8: the signer is a master key, it mints one shape, and exactly
    two functions are security definer.
  - Traps 11–14:
    - measure RLS as a token;
    - a check that passes on zero rows;
    - `. ./.env` breaks the JWK, and unsetting a key for `next dev` means
      setting it empty;
    - the email cap and the one-standby-key limit.
  - The header, layout, commands and conventions (operator members,
    `tenant_public`, `db` never to a Client Component).
- **decisions.md:**
  - D-038 (two walls), D-040 (Supabase Auth + our cookie + a per-request
    membership check), D-041 (one role) and D-042 (the two definer
    functions), each with what was measured;
  - D-006 marked superseded by D-038/D-039;
  - D-028 marked "key superseded, cookie kept".
- **risks.md:**
  - R-2 is closed for requests; R-11 gains its second wall; R-13 has the key
    gone and Supabase's 30-per-window limit;
  - R-19, the signing key, with the rotation procedure as Phase 3 measured it;
  - R-20, transcripts are readable within a tenant by uuid;
  - R-22, a policy that is too tight looks like a wrong answer.
- **architecture.md:**
  - an "Auth: tenant tokens, policies, memberships" subsection, with the
    per-table policy table;
  - the staff routes in the API table;
  - a rewritten "Admin" paragraph, env section and system overview;
  - updated module rows.
- **flow.md:** the chat-token step in the query sequence diagram, the reset
  and password routes, and a new meaning for "Admin".
- **README.md:**
  - five schema files and ten tables;
  - the new env vars;
  - "Create tenants and their staff" (`member:*`, the operator, the redirect
    URL, SMTP);
  - "The signing key" (generate without printing, import as standby, never
    rotate to active, and rotation);
  - a rewritten security section.
- **plan/auth-rls.md:** a status line naming what is owed.

**Why it mattered:** this plan changed what isolation MEANS. It used to be
"every query remembered its filter", and it is now "Postgres refuses, and the
filter is still there". The docs that told readers the service key was the
server's only key, or that a tenant is administered with a shared key, would
now be wrong in the way that costs most: a new session trusting them.

**Checked, not assumed:**
- A grep over README, architecture, flow and CLAUDE.md for `admin key`,
  `tenant:key` and `admin_key_hash` finds only the historical mentions that
  say they were removed.
- A grep for `service_role` claims in the docs finds none that still says the
  web app holds it.

**What the plan does not fix** (R-13, R-19, R-20, R-21, and plan § 6): no
rate limit on our own endpoints, the signing key as a master key, transcripts
readable by uuid within a tenant, email deliverability, and no guest accounts,
roles, MFA, SSO or audit log.

**Owed** (R-21's email cap): the northwind invite, walk step 6 in the
browser, and the "Forgot password?" email.

---

## Taglish replies (D-043) · done 2026-09-26

**What was done:**
- **`packages/rag/src/language.ts`** (new, pure, no I/O):
  - `languageRequest` / `languagePreference`: an explicit request, the latest
    one winning;
  - `detectLanguage`: Tagalog function words → Tagalog; two English function
    words → English; a date or "okay" → none;
  - `replyLanguage`: the choice;
  - `languageInstructions`: the prompt lines;
  - `requestReply`: the canned acknowledgement for a message that is only a
    request.
- **`prompt.ts`:** `buildPrompt(…, tools, language: string[] = [])`. The lines
  are appended last, and nothing at all for an unrequested English reply.
- **`answer.ts`:**
  - one more tenant-filtered query, the user's last 50 messages, run in
    parallel with the history query and never sent to the model;
  - `replyLanguage()` over them;
  - `requestReply()` beside `greetingReply()` in both answer paths.
- **`constants.ts`:** `LANGUAGE_SCAN_MESSAGES = 50`, a bound, not measured.
- **`language.test.ts`** (new) and `prompt.test.ts`: 103 pipeline tests.
- **`tools/prompt-eval.mjs`:**
  - 10 `lang-*` cases, a third count (`lang x/10`);
  - `mix()`, which judges language by function words and reports the English
    share of every reply.

**Why it mattered:** the prompt had no language rule, so gpt-4o-mini mirrored
the user. Measured before (`plan/baseline/eval-lang-before.txt`):

| Asked | Got |
|---|---|
| "Pwede po bang magdala ng aso?" | "Oo, puwedeng magdala ng maliit at katamtamang laki ng aso…", **0.00** English |
| "How much po yung Day Tour pag weekend?" (Taglish) | "The rate for the Day Tour on weekends is ₱12,000.", plain English |
| "May bakante pa po ba sa 7 October 2026?" | "Yes, the Overnight slot is open on 7 October 2026.", the tools block's English example, verbatim |

After, the same questions:
- "Yes po, you can bring your dog. Small and medium pets are allowed at ₱500
  each… Pero hindi po sila pwede sa pools…" (0.50);
- "Ang Day Tour po natin is ₱12,000 naman on weekends and holidays." (0.43);
- "Yes po, the Overnight slot is open pa sa 7 October 2026." (0.50).

Every fact survived: each `lang-*` case also checks a price or a tool status,
and `lang-absent` (massage, in no document) still returns the exact refusal.

**Trap avoided: a rule in the prompt that the model must both classify and
obey.** The prompt-only version made English questions come back in Taglish
("Ang Overnight rate po natin is ₱20,000 on weekends"). It also read "10
October" as English and switched a Taglish booking conversation to English.
Code now classifies, so an English turn carries no language text at all. That
is also why the northwind snapshot is still byte-identical to
`northwind-prompt-pre-bookings.txt`.

**Trap avoided: a request lost to `MAX_HISTORY`.** `lang-pin-window` asks
"Tagalog lang po." and then four questions, which puts the request 8 messages
back, outside the 6 re-sent. Its last reply is still pure Tagalog, because
the request is found in the stored messages, not the history.

**Checked, not assumed:**
- full battery 26/29: `original 9/10 · tool 9/9 · lang 8/10`;
- `antecedent` is the known D-017 limit;
- `lang-tagalog-2` failed once and passed 4/4 repeats;
- isolation 11/11 on chat tokens and 11/11 filters-only, bookings isolation
  12/12, verify 47/47;
- the plan.md Phase 3 grep: both new `from('messages')` lines carry
  `.eq('tenant_id', tenant.id)`;
- typecheck (with the service-import check), test and build are green.

**Not fixed:**
- `lang-followup`: the reply after a bare date stays Taglish but leans
  Tagalog (0.13 English).
- The refusal is English in every language, on purpose: it is an exact string
  that D-035 and the UI rely on.
- The greeting matcher is still English-only ("kumusta" goes through
  retrieval).
- The word lists are Tagalog and English only.
- The mix is judged by counting words; nobody has listened to it yet.

---

## Unanswered questions screen (S-4) · done 2026-09-27

**What was done:**
- **`packages/rag/src/unanswered.ts`** (new): `listUnanswered(tenant)`. Two
  tenant-filtered queries on `messages`: the newest 200 assistant rows whose
  content is exactly `NO_ANSWER`, then the user rows in those conversations.
  Each refusal is paired with the latest user message before it in the same
  conversation. Returns `{ id, question, askedAt }`, mapped field by field.
- **`GET /api/t/[tenant]/unanswered`**: `withTenantRoute` + `requireAdmin`.
- **S-4** `app/t/[tenant]/admin/unanswered/page.tsx` and
  `components/unanswered-screen.tsx`: same session/login pattern as S-3,
  read-only, with a **Unanswered** link in the knowledge base's header.
- **`tools/isolation.mjs`**: check 12, `listUnanswered per tenant`.

**Why it mattered:** the refusal is the knowledge base telling staff what is
missing, and until now it was only visible by reading SQL.

**Why no new table:** every turn is already saved, refusals included, and a
refusal is always the exact string (D-008 short-circuit, D-035 fallback, the
grounding prompt). A table would have needed its own RLS policy (R-22) and
verify checks for data that already exists.

**Trap avoided: pairing by `id - 1`.** Identity values are per row, so a
concurrent insert could sit between a turn's two rows. The pairing looks for
the latest user row before the refusal instead.

**Trap avoided: a check that passes on zero rows.** Check 12 asserts that
northwind's refusal from check 6 IS on northwind's list (the positive twin)
and is not on villa's, and that the two lists share no ids.

**Checked, not assumed:**
- isolation 12/12 on chat tokens and 12/12 filters-only: northwind 200 (the
  limit), villa 68;
- verify 47/47;
- tests: pipeline 103, bookings 27, openai 14, chunker 13;
- typecheck (with the service-import check) and build green; the build lists
  `ƒ /api/t/[tenant]/unanswered` and `ƒ /t/[tenant]/admin/unanswered`;
- `buildPrompt()` is untouched, so eval was not re-run.

**Not done:**
- Not walked in a browser. Running `pnpm build` beside `pnpm dev` replaced the
  dev server's `.next`, and every page answered 500, so the HTTP check could
  not run.
- Partial answers are not caught, only the exact refusal.
- Northwind's 200 are mostly eval and isolation traffic.

---

## Edit a document (D-044) · done 2026-09-27

**What was done:**
- **`ingest.ts`:** `getDocument(tenant, id)` returns the full original text,
  or `null` for "not yours or not there". `updateDocument()` checks
  ownership, runs `ingestDocument()` on the new text, then
  `deleteDocument()` on the old one.
- **`documents/[id]/route.ts`:** `GET` (the text, for the form) and `PUT`
  (the edit). Both use `requireAdmin`, and `PUT` validates with the add
  form's `createDocumentSchema`.
- **S-2:** a ✎ button on each row. The add form becomes "Edit “title”", with
  **Save changes** and **Cancel**, and the row being edited can't be deleted
  mid-edit.
- **`tools/isolation.mjs`:** checks 13 and 14. The probe document is now
  ingested, edited, and then deleted.

**Why it mattered:** filling a gap from the unanswered screen used to mean
rebuilding the FAQ outside the app. The admin screen shows only overlapping
chunks, and gluing them back together repeats sentences.

**Trap avoided: delete-then-add.** That order leaves the bot without the
document while OpenAI embeds, and for good if the call fails. Ingesting first
means a failure leaves the old version answering.

**Trap avoided: an edit from another tenant creating a document.** Ownership
is checked before `ingestDocument()`, so northwind's attempt on villa's probe
returned `null` and wrote nothing. Check 14 asserts that no `hijack` title
appears in northwind.

**Checked, not assumed:**
- isolation 14/14 on chat tokens (villa's edit on the operator's staff
  token): doc 114 → 115, then 116 → 117 filters-only, the old id gone, the
  new one with 1 chunk and the new word;
- verify 47/47; tests: pipeline 103, bookings 27, openai 14, chunker 13;
  typecheck green;
- over HTTP on `pnpm dev`: `GET` and `PUT /api/t/villa/documents/38` without
  a session → 401; `/api/t/nope/…` → 404; `/t/villa/admin` and
  `/t/villa/admin/unanswered` → 200.

**Not done:**
- The logged-in path in a browser: I have no staff password. The same
  functions ran on a staff token in isolation.
- `pnpm build` not re-run, because it replaces the running dev server's
  `.next`.

---

## Mark unanswered questions resolved (D-045) · done 2026-09-27

**What was done:**
- **`packages/db/sql/schema-unanswered.sql`** (new, applied by the user):
  - a `messages (id, tenant_id)` unique key;
  - the `unanswered_resolutions` table, with a composite FK to that key;
  - staff-only select, insert and delete policies, no update, and anon
    revoked.
- **`unanswered.ts`:** `listUnanswered(tenant, { resolved })` filters in
  Postgres, open by anti-join and resolved by inner join, so resolved ones
  never use up the 200-row limit. It also adds `resolveUnanswered` (checks
  that the id is this tenant's refusal, then an idempotent upsert) and
  `reopenUnanswered`.
- **Routes:** `GET /unanswered?resolved=1`, and `PUT` / `DELETE
  /unanswered/[id]/resolution`, all behind `requireAdmin`.
- **S-4:** Open / Resolved tabs, **Mark resolved** / **Reopen** per row, and
  the resolved date on the Resolved tab.
- **Checks:** verify 48, isolation 15 and 16.

**Why it mattered:** without it, the list only grows. Staff would have to
remember which questions they had already answered in the knowledge base.

**Trap avoided: deleting to resolve.** The list is derived from the
transcripts, so a delete would have destroyed chat history.

**Trap caught: the embed's shape.** PostgREST returns the resolution as an
array of at most one, not an object. The first isolation run failed check 16
with `in resolved false`. The type is now `isOneToOne: false` and the code
reads `[0]`.

**Checked, not assumed:**
- verify 48/48: `chat insert 42501 · staff insert ok · chat reads 0 · staff
  reads 1 · staff deletes 1`. Before the SQL ran, the same check failed with
  "run sql/schema-unanswered.sql", so a missing table can't pass;
- isolation 16/16 on chat and operator staff tokens, and 16/16
  filters-only. Villa question 1870 was resolved, left the open list, showed
  up in the resolved list with a date, was reopened, and came back. Northwind's
  refusal couldn't be resolved or reopened by villa;
- tests: pipeline 103, bookings 27, openai 14, chunker 13; typecheck green;
- over HTTP on `pnpm dev`, with no session: `GET ?resolved=1`, `PUT` and
  `DELETE` → 401, unknown tenant → 404, and the page → 200.

**Not done:** the logged-in browser walk, and `pnpm build`, because it
replaces the running dev server's `.next`.

---

## Relative dates (D-046) · done 2026-09-27

**The root cause:** the model had today's date, since the tools block's
last line was `Today is 2026-09-27 (Sunday), Asia/Manila.`, but it didn't
count from it. The block's "without giving a date, ask which date" rule won.
The questions "Is the resort available tomorrow?", "Available ba kayo
bukas?", "May available room ba bukas?", "sa makalawa", "Paano kung sa
Friday?" and "sa susunod na linggo" all got "Which date do you mean?" / "Anong
date po?" with no tool call (6/6).

**What was done:**
- **`packages/rag/src/dates.ts`** (new, pure):
  - `resolveDates(message, today)`: English, Tagalog and Taglish; named days,
    counted days, weekdays with this/next, weeks, weekends, explicit dates;
  - `planDates()`: on an availability turn, the prompt lines plus the
    `check_availability` arguments; on any other turn, nothing;
  - `dateInstructions()`: the lines, in three shapes: ambiguous (ask), past
    (say so), or checked (answer from the result and name the date).
- **`answer.ts`:** `withDates()` feeds `toolLoop()` a `precheck`, run through
  `executeTool()` before the model's first turn. It works in both the
  streaming and non-streaming paths.
- **`prompt.ts`:** the lines go right after "Today is …".
- **`tools.ts`:** the ask-for-date rule was narrowed to "without giving any
  date or day at all". Reverted with D-047: it bought nothing, and
  `lang-tagalog-2` failed more often with it.
- **Tests:** `dates.test.ts` (98) and `tools.test.ts` (13, with
  `@rag/bookings` mocked).
- **Battery:** 9 `date-*` cases, counted as `date x/9`.
- **`packages/db/tools/verify.mjs`:** checks 30–33 now count in Postgres
  instead of fetching rows. Villa reached 1,236 messages, and PostgREST caps
  a fetch at 1,000, so check 33 failed on data growth, not on RLS.

**Trap avoided: trusting a prompt line.** Stating the resolved date fixed 5
of 6 questions. Adding the exact tool arguments fixed the Tagalog range, but
"Available ba kayo next week?" still asked 3/3, and "sa Friday" asked once.
The up-front check is what makes the date reach the API every time.

**Trap avoided: trap 10.** With only a fact line ("bukas" means …), "What
time is check-in bukas?" called the tool and began "Yes po". On a stash of
the change, the same question got a clean documents answer with no call. So
non-availability turns now get nothing at all.

**Trap avoided: Tagalog double meanings:**
- "Bukas ba ang pool?" means "open", not "tomorrow";
- "sa Linggo" is Sunday, but "sa susunod na linggo" is next week;
- "May 2 rooms ba?" is "there are 2 rooms", not 2 May.

**Checked, not assumed:**
- live, villa, with today 2026-09-27:
  - tomorrow / bukas → `{"date_from":"2026-09-28"}`;
  - sa makalawa → 2026-09-29;
  - sa Friday → 2026-10-02;
  - next week / sa susunod na linggo → 2026-09-28..2026-10-04;
  - "How about overnight?" kept 2026-09-28;
  - "What about the day after tomorrow?" → 2026-09-29;
  - "Available ba kahapon?" → "Ang 26 September 2026 po is in the past…";
- battery 36/38, `original 9/10 · tool 9/9 · lang 9/10 · date 9/9`:
  - `antecedent` is known (D-017);
  - `lang-tagalog-2` failed once, then passed 3/3;
  - `lang-followup` passed in the full run and failed 2 of 3 repeats, on the
    language mix only, with its date correctly checked;
- the northwind prompt snapshot is identical;
- tests 214/27/14/13, typecheck green, isolation 16/16, verify 48/48.

**Not done / limits:**
- A day-of-month alone ("the 12th") and holidays ("Christmas") are left to
  the model.
- The weekday rules are a choice (weeks run Monday to Sunday).
- An availability question phrased without an availability word ("Pwede ba
  kami bukas?") isn't checked up front, so the model gets the unchanged
  prompt.
- Not walked in the browser.

---

## Friendly refusal (D-047) · done 2026-09-27

**What was done:**
- **SQL (`schema-auth.sql`, re-run by the user):** added
  `tenants.fallback_message` (nullable, 1–500 chars); dropped and recreated
  `tenant_public()` to return it. A return type can't be changed in place,
  and the grants are re-applied later in the same file.
- **`refusal.ts`** (new):
  - `DEFAULT_REFUSALS`: English, Taglish and Tagalog;
  - `refusalText()`: the tenant's own message, or the default in the reply's
    language;
  - `isRefusal()` / `displayReply()`;
  - `refusalFilter()`: the stream guard.
- **`answer.ts`:** saves `NO_ANSWER` as before and returns and streams the
  friendly text. `Answer.refused` is new. `getMessages()` swaps stored
  refusals too.
- **`tenant.ts` / `types.ts`:** `TenantContext.fallbackMessage`.
- **`tenant.mjs`:** `tenant:fallback -- <slug> "<message>" | --clear`.
- **Eval, isolation:** a refusal is `last.refused`, and the pure-refusal
  cases also check that the marker never reached the visitor.
- **`verify.mjs`:** check 42's public column list now includes
  `fallback_message`.
- **The Unanswered screen's** explanation no longer quotes the marker.
- **villa's message:** "Pasensya na po, wala pa kaming info tungkol diyan.
  Pwede po kayong mag-message sa amin sa Viber o SMS, 0917-845-2290, para
  matulungan namin kayo." The number and channels come from villa's own
  documents (01, 04), not invented.

**Why it mattered:** the refusal was the one sentence every tenant's
visitors saw that sounded like a system talking about its files.

**Trap avoided: rewording the constant.** It is load-bearing: grounding,
D-008, D-035, the unanswered list and the eval all match it exactly. Swapping
it only at the edge left every measured behaviour alone. The northwind
snapshot is identical.

**Trap avoided: the stream shows the marker before anyone can replace it.**
The filter holds only what is still a prefix of the marker, so a real
answer is delayed by at most the few characters it shares with "I don't
know…".

**Found on the way: D-046's rule edit.** `lang-tagalog-2` failed in every
full run today (en-share 0.84 against a 0.80 limit, facts kept). The only
change that reached its prompt was D-046's narrowed ask-for-date rule, which
bought nothing, so it was reverted:
- with it, 4 of 9 runs failed; without it, 1 of 6 on repeat;
- the date cases still pass 9/9;
- in the full run after the revert, the lang group's one failure was
  `lang-tagalog-2` again, which is within CLAUDE.md's expected lang 9/10.
  Worth watching.

**Checked, not assumed:**
- live, before and after the SQL: Taglish refusal → Taglish default, then
  villa's message; English → English default; northwind → default. JSON and
  stream were identical;
- `tenant:fallback -- nosuch` is refused;
- tests: pipeline 233 (19 new), bookings 27, openai 14, chunker 13;
  typecheck green;
- battery 36/38; verify 48/48; isolation 16/16 both ways; northwind snapshot
  identical.

**Limits:**
- A tenant message is one string for every language.
- A reloaded transcript shows the English default.
- Not walked in the browser.

---

## Per-language fallback messages (D-048) · done 2026-09-27

**What was done:**
- **`schema-auth.sql`** (re-run by the user):
  - `tenants.fallback_messages` jsonb with a shape check;
  - the old single `fallback_message` copied into all three keys, then
    dropped;
  - `tenant_public()` recreated.
- **`refusal.ts`:** `refusalText()` picks the tenant's text for the reply
  language, else that language's default.
- **`tenant.ts`:** `fallbackMessagesOf()` re-checks the jsonb.
- **`tenant.mjs`:** `tenant:fallback -- <slug> <language> "<message>"`,
  `<language> --clear`, `--clear`, or no argument to show all three. An unknown
  language is refused.
- **Tests:** `refusal.test.ts`, 234 in the pipeline.

**Why it mattered:** villa's English-speaking visitors were answered in
Taglish, while northwind, with no custom text, was answered in theirs.

**A mistake, caught and undone:** after the SQL ran, the user had already
set their own English and Taglish wording. My script set English and
Tagalog without reading first, and overwrote their English. The first line
of the script's output showed their text, so it was restored word for word
straight away:
- English: "Sorry, we don't have any information about that yet. You can
  message us on Viber or SMS at 0917-845-2290 so we can assist you.";
- Taglish: untouched;
- Tagalog: the migrated copy of the old Taglish sentence was replaced by a
  real Tagalog line, "Paumanhin po, wala pa kaming impormasyon…". The user was
  offered the old one back.

The lesson: read a tenant's settings before writing them. `tenant:fallback
-- <slug>` shows them.

**Checked, not assumed:**
- live:
  - "Do you offer massage?" → villa's English line;
  - "May massage service po ba kayo?" → its Taglish line;
  - "Tagalog lang po. May masahe po ba kayo?" → its Tagalog line;
  - northwind → the built-in default;
  - `refused` was true each time, and the stream equalled the JSON;
- verify 48/48; isolation 16/16 both ways; typecheck green.

---

## Conversational messages (D-049) · done 2026-09-27

**Before:**
- "Hi" got a long reply about "documents" and "passages";
- "Salamat po" and "okay" got the refusal;
- "Kamusta po?" worked only because retrieval happened to find chunks;
- mixed messages were answered, but "Thanks! Is the resort available
  tomorrow?" ignored the thanks.

**What was done:**
- **`greeting.ts`:**
  - `classifySmallTalk()` covers greeting, thanks, acknowledgment and
    farewell, in English and Tagalog, and matches only whole messages;
  - `smallTalkReply()` gives short replies in English, Taglish or Tagalog;
  - `smallTalkLanguage()` reads the small talk's own Tagalog;
  - `thanksPrefix()` handles the mixed "Thanks! …" message;
  - `greetingReply()` is kept for older callers.
- **`answer.ts`:** `smallTalk()` runs before the pipeline in both paths. It
  does one tenant-filtered read of the conversation, and only when the
  message is small talk. From that read it takes the reply language and
  whether the bot's last message asked a question. The thanks prefix is
  shown and never saved.
- **`greeting.test.ts`:** 41 → 101 tests.

**Trap avoided: swallowing a real question.** Every word must be small talk.
"Hi, what time is check-in?", "Salamat po, may parking ba?" and "sige, bukas
po" all still reach the pipeline, and the tests pin them.

**Trap avoided: swallowing an answer.** "yes", "oo", "opo" and "sure" are not
acknowledgments, and "okay" / "sige" right after a bot question goes to the
pipeline.

**Trap avoided: saving the prefix.** "You're welcome! " + the refusal would
no longer equal `NO_ANSWER`, and the unanswered list would lose the
question. The prefix is added only where the reply leaves the server.

**Checked, not assumed:**
- live on villa:
  - Hi, Hi po, Kamusta po?, Salamat po, Thank you, okay and Salamat, bye each
    got the right short reply in the right language, with 0 sources and 0
    tools;
  - "Please respond in English." then "hi" stayed English;
  - "Magkano po ang Overnight?" then "salamat po" gave a Taglish thanks;
  - "Thanks! Is the resort available tomorrow?" gave "You're welcome! Yes,
    the resort is open on 28 September 2026…", with the same result in the
    stream;
- battery 36/38 (known `antecedent` and `lang-followup`);
- isolation 16/16 both ways; tests 294/27/14/13; typecheck green.

**Limits:** "sige" answering "Which date?" gets the refusal, as it did
before, and the lists are English and Tagalog only.


## Booking types, Phase 0: the baseline · done 2026-09-27

**What:** before any code changes for per-room booking
(`plan/booking-types.md`), saved what "unchanged" has to mean, and created
the fixture tenant `harbor` (tenant 67, "Harbor Inn", assistant Marina) and
its operator member. Plans committed at `e8fc28b`; work continues on
`feat/booking-types`.

**Why it matters:** Rule 1 of the plan is that villa and Northwind see no
change at all. That can only be proven by a diff against something taken
before the first edit.

**Observed, all in `plan/baseline/*-pre-booking-types*`:**
- tests 13 / 14 / 27 / 294, typecheck and build green;
- verify 48/48; pipeline isolation 16/16 and 16/16 (`--filters-only`);
  bookings isolation 12/12 and 12/12;
- Northwind's prompt snapshot is byte-identical to
  `northwind-prompt-pre-bookings.txt`, so nothing since bookings has moved it;
- villa's prompt with its tools block, and villa's tool definitions saved
  separately. The prompt has one dated line ("Today is 2026-09-27 (Sunday),
  Asia/Manila."); the definitions have none, so they diff exactly;
- villa's availability for 2026-09-27..10-10: 42 rows, 42 open;
- battery **37/38**: only `antecedent` failed. `lang-followup` passed, then
  failed 3 of 4 repeats, so this was one lucky run of a known lean (D-043),
  not a change. The baseline is the usual 36/38.

**Trap avoided: a fixture tenant polluting the baseline.** The plan said to
create `harbor` first. The baseline was taken first instead, then verify,
bookings isolation and the Northwind snapshot were re-run after `harbor`
existed. Their only differences are message counts (the battery's own runs)
and the ids of verify's scratch tenants, so "harbor changes nothing" is
measured.

## Booking types, Phase 1: the Storage spike · done 2026-09-27

**What:** before building room photos, asked Supabase Storage the question
auth-rls Phase 0 asked PostgREST: does it accept the tokens we sign, and do
its policies see our claims? `schema-booking-types.sql` § 11 made the
`unit-images` bucket and three policies; `plan/booking-types-phase1-storage.mjs`
ran nine checks.

**Why it mattered:** the whole photo design (upload through our route on the
staff token, isolation by the path's first folder) depends on it. If Storage
had refused our tokens, the only way to upload would have been
`service_role` in a request, which CLAUDE.md rule 2 forbids. So this could
have stopped the plan.

**Observed (`plan/baseline/storage-spike-booking-types-phase1.txt`), 9/9:**
- harbor staff uploaded `67/spike/<uuid>.png`, and the public URL returned
  200 with the identical 70 bytes and no token: the positive twin every
  refusal below leans on;
- `403 new row violates row-level security policy` for harbor staff into
  villa's folder, and for a chat token into either folder, so both the
  tenant check and `app_is_admin()` work inside Storage;
- `415 mime type image/svg+xml is not supported` and `413 The object exceeded
  the maximum allowed size`: the bucket is a second wall behind the route;
- villa staff deleting harbor's photo: **no error, 0 removed**, and the
  object was still there; harbor staff then removed it (1 removed, gone).

**Trap avoided: trusting an error.** Every refusal was confirmed by listing
the bucket as the service client, because an upload can report an error and
still land, and a delete can report success and remove nothing. The second
one happened: a refused delete is silent. So `removeImage()` must check how
many objects were removed, not whether there was an error.

## Booking types, Phase 1: the schema · done 2026-09-27

**What:** `packages/db/sql/schema-booking-types.sql` steps 1–10, run by the
user after schema-auth.sql:
- `booking_type` in the bookings application's config, absent =
  `whole_resort`, read in SQL only by `booking_type_of()`;
- the config trigger now also validates `booking_type`, `weekend_days` and
  `currency`, and refuses a type switch while a booking has not ended, or
  to whole_resort with more than one active unit;
- `units`: `description`, `capacity`, `active`, `sort_order`, and a deferred
  constraint trigger: a whole-resort tenant has exactly one active unit;
- `unit_rates` (weekday/weekend, centavos), `bookings.price` and
  `group_id`, `unit_price()`;
- the insert trigger refuses a foreign or inactive unit (23503), too many
  guests or a missing rate (23514), and sets the price itself, keeping the
  old one when a booking is re-saved without moving;
- `check_availability` skips inactive units; `check_room_availability` is
  new (per_room only, priced active rooms, capacity and price, no guest data);
- RLS and EXECUTE grants for all of it; `unit_images` with the path check,
  6 per room under an advisory lock, and only `sort_order` updatable.

**Why it matters:** the price is now decided in exactly one place, the
database, and no request can override it (plan Rule 2); and nothing a
whole-resort tenant does has changed (Rule 1).

**Observed:**
- verify 69/69; the 21 new checks include: two rooms on one night priced
  350000 and 600000 (Monday) and 450000 (Friday) with a forged `price: 1`
  ignored; a 2-room group with one clash leaving 0 rows; 3 guests in a
  2-guest room 23514, 2 allowed; after a rate edit the stored price stays
  350000 while the quote says 999900; a chat token reads 3 of 3 rates and
  cannot write one; a path into villa's folder 23514; the 7th photo 23514;
  `path` update 42501 while `sort_order` updates;
- villa's 14-day availability, tool definitions and prompt, and Northwind's
  prompt: identical to Phase 0;
- Storage spike 9/9 again; isolation 16/16 and bookings 12/12, both ways;
  tests unchanged.

**Trap found: PostgREST fills a missing key with NULL, not the default.**
The first verify run failed 14 checks from one cause. Four rooms were
inserted in one call, and only the last row said `active: false`. PostgREST
builds one column list for the whole array, so the other three were sent
`active = null`, and `not null` refused the insert (23502). It is a silent
trap for Phase 2 too: `createBooking` with several rooms must give every row
the same keys, or pass `defaultToNull: false`.

**Idempotent, measured:** the user ran the file a second time. verify 69/69
again, villa's availability and tool definitions still identical to Phase 0,
the Storage spike 9/9, and the bucket still `public`, 2097152 bytes,
jpeg/png/webp (`plan/baseline/*-booking-types-phase1-rerun.txt`).

## Booking types, Phase 2: `@rag/bookings` · done 2026-09-27

**What:** the package code for per-room booking, on top of Phase 1's schema.
- `validate.ts`: `parseConfig` (the defaults `whole_resort`, Fri–Sun, PHP,
  in one place), `parseRooms`, `parsePrice` (whole centavos only),
  `positiveInt`, and `sniffImageType` (JPEG/PNG/WebP by magic bytes).
- `bookings.ts`: `createBookings` (one or several rooms, ONE insert, every
  row with every key), `createBooking` unchanged for one unit, `quote` (the
  same `unit_price()` the trigger uses), `checkRoomAvailability` (capped at
  `MAX_AVAILABILITY_ROWS`), `requirePerRoom` (404 for whole-resort), and a
  room filter on `listBookings`. One `writeError()` maps 23P01, 23503 and
  the two 23514s; anything else stays a plain Error.
- `accommodations.ts`: list, get, create, update (incl. deactivate), set
  rates. `images.ts`: add (upload → row → remove the object if the row
  fails), remove (row → object, checking the COUNT), reorder, list.
- `packages/db/src/database.types.ts` gained the new columns, tables and
  functions; `price` is `never` on insert and update, so the compiler refuses
  code that tries to send one.

**Why it matters:** both callers, the admin routes (Phase 3) and the
chatbot's executor (Phase 6), get one set of functions with the same rules,
and neither can put a price in the database.

**Observed:**
- `pnpm --filter @rag/bookings rooms` 15/15, on a staff token minted for a
  real member of a scratch per_room tenant: quote 950000 for Garden + Family
  on a Monday and the group stored at exactly that; Friday 450000; a
  clashing group left only the blocker's row; three kinds of bad room gave
  the identical "No such unit or slot."; the 7th photo refused and its object
  removed (6 objects, 6 rows); remove, then remove again = true, false;
  villa got `PerRoomOnlyError` (404) for rooms and a 400 for two units;
- unit tests 27 → 72 (45 new, pure);
- verify 69/69; isolation 16/16 and bookings isolation 12/12, both ways;
  battery `tool-*` 9/9, seeding through the changed `createBooking`;
- villa's and Northwind's prompts and villa's tool definitions still
  byte-identical to Phase 0.

**Trap avoided: a refused delete that reports success.** `removeImage` checks
how many objects Storage removed, because Phase 1 measured that a refused
delete returns no error and removes 0.

**Deviation:** the plan said `unitIds[]`. It is `rooms: [{ unitId,
guestCount? }]`, because the trigger checks each room's capacity against
that room's own guest count; a single total could not be checked at all.

## Booking types, Phase 3: the routes · done 2026-09-27

**What:** HTTP for Phase 2's functions, under `app/api/t/[tenant]/`:
- `accommodations` GET/POST; `accommodations/[id]` GET/PATCH (no DELETE: a
  room is retired with `active: false`); `…/rates` PUT; `…/images` GET and
  POST (multipart, `file`); `…/images/[imageId]` DELETE/PATCH;
- `bookings/quote` POST; `bookings` GET `?unit=`, POST `rooms` (returns the
  group) beside `unitId` (unchanged); `bookings/setup` adds `bookingType`
  and `currency`;
- every handler: `withTenantRoute` → `requireAdmin` → `requireApplication`,
  then @rag/bookings' `requirePerRoom` (404 for whole_resort);
- zod schemas check shape only; there is no `price` key anywhere, so zod
  strips one;
- the upload route refuses an oversized `Content-Length` before reading the
  body; the package checks the real size and the bytes.

**Why it matters:** the routes are where a stranger, another tenant's staff,
or a forged body arrives. Each of those is now shown to fail.

**Observed (`plan/booking-types-phase3-walk.mjs`, 10/10 against `pnpm dev`):**
- 401 on all seven new endpoints without a cookie; routes-rooms' cookie on
  routes-whole: 401;
- whole_resort: `accommodations` GET 404, POST 404, `quote` 404; `setup`
  says `whole_resort`;
- a booking POST with `price: 1, total: 1` stored 350000 + 600000, total
  950000, exactly the quote;
- another tenant's unit: 400 "No such unit or slot."; a clash: 409;
- `?unit=` another tenant's room: 200 `[]`;
- photo upload 201, public URL 200; an SVG sent as `x.png` / `image/png`:
  400 "A photo must be a JPEG, PNG or WebP image."; 3 MB: 400; another
  tenant's room: 404; delete via the wrong room 404, then 200, then 404,
  and 0 objects left in the folder;
- retiring a room 200 `active: false`; PATCH of another tenant's room 404,
  and that room still active when read as the service client.

**Trap hit: `next build` under a running `next dev`.** A full `pnpm build`
rebuilt `apps/web/.next` while the dev server was serving from it; every
page then returned 500 with `Cannot find module './535.js'` while API routes
kept working. Nothing in the code was wrong. While dev runs, build only the
packages.

## Booking types, Phase 4: the screens · code done 2026-09-27, walk owed

**What:**
- S-5 at `/t/<slug>/admin/accommodations` (404 unless bookings AND
  per_room): add a room; edit name, guests, description; retire it (with a
  warning that counts its bookings in the next 92 days, which stay valid);
  rates per slot, typed in pesos and turned into centavos by splitting the
  string (`lib/money.ts`), never by `× 100`; photos with order and remove.
- `lib/resize-image.ts`: `createImageBitmap` (EXIF rotation applied), a
  canvas scaled to MAX_IMAGE_EDGE, WebP at 0.82 (JPEG if the browser cannot
  encode WebP). Re-encoding keeps only pixels, so EXIF and GPS go.
- The bookings screen, for per_room only: rooms to tick, one guest count
  each; the server's quote (the same `unit_price()` the trigger uses); a
  room filter; room and stored price on each row; a Rooms link. Whole-resort
  tenants render exactly the old screen.
- The photo limits come from `@rag/bookings` in the SERVER page and reach
  the Client Component as props: one copy of each number.

**Observed so far:** typecheck green; villa bookings page 200; accommodations
404 for villa and northwind, 200 for harbor; the user's first photo stored as
a 330×352 WebP, 6560 bytes, chunks VP8X/ICCP/VP8, no EXIF, no GPS.

**Owed:** the rest of the browser walk, and a full-size phone photo to set
MAX_IMAGE_BYTES and MAX_IMAGE_EDGE from a measurement. A second round of walk
steps did not reach the database; the user deferred finding out why.

## Booking types, Phase 5: the operator CLI · done 2026-09-27

**What:** `pnpm --filter @rag/db tenant:booking-type -- <slug>
[whole_resort|per_room]`. It shows the type, active and retired units, and
the timezone; switching writes the config and nothing else.

**Why it matters:** switching a tenant with live bookings could sell the
property twice (plan § 2.4). The rule is the SQL trigger's; the CLI prints
the trigger's own refusal, so there is one rule and not two copies.

**Observed (`plan/booking-types-phase5-cli.mjs`, 6/6):** a tenant without
bookings, a bad type and a missing tenant are refused; the default shows as
`whole_resort (the default: no booking_type in its config)`; per_room →
whole_resort refused with "Tenant 95 has 3 active units"; with one room and
a live booking, refused with "1 live booking(s) that have not ended"; after
cancelling, whole_resort (the key removed from the config), a no-op message,
and per_room again. villa, harbor and northwind read correctly.

## Booking types, Phase 6: the chatbot tool, measured · done 2026-09-27

**What:**
- `packages/rag/src/tools.ts`: a per_room branch, `roomTools()`. Same tool
  name and date arguments, plus optional `slot`, `room` (a name, from an
  enum of this tenant's active rooms) and `guests`. The description names
  the rooms and their capacities; its instruction lines say to list open
  rooms with capacity and price, to quote prices only from the tool, and
  to pass the guest count. executeTool chooses the branch from the
  database, and maps each row field by field with the price as text.
- `@rag/bookings`: `listRooms()` (active rooms, name and capacity only).
- Harbor's fixtures: `fixtures/harbor.json` (a guest guide with an
  out-of-date ₱3,000 brochure rate, a ₱40,000 whole-inn event rate, the Old
  Annex closed for renovation, a unique Wi-Fi password),
  `harbor-units.json` (five rooms, the Old Annex retired but priced) and
  `harbor-bookings.json` (the Sea View Suite, seeded and hard-deleted by
  every battery run). `plan/booking-types-phase6-harbor.mjs` loads the first
  two as harbor's operator, idempotently, keeping the Phase 4 walk's rooms.
- The battery: harbor loaded, its fixture seeded and removed, ten `rt-*`
  cases counted as their own `rooms` group, so the four older groups still
  compare with their baselines.

**Why it matters:** this is where a per_room tenant's guests actually meet
the feature. Every price the cases accept is the TOOL's price for that row,
compared in code, so the battery cannot be satisfied by a plausible number.

**Observed:**
- rt 10/10 on three separate runs. Examples: `rt-price` quoted ₱3,500.00 on a
  Monday and not the brochure's 3,000; `rt-guests` passed `guests: 5` and
  offered only the Family Room at ₱7,500.00; `rt-inactive` said the Old
  Annex "is closed for renovation and cannot be booked"; `rt-taken` said the
  Sea View Suite is taken, with no guest name or phone anywhere;
  `rt-tagalog` answered in Taglish (tl 11, en 5);
- the full battery 47/48: `original 9/10 · tool 9/9 · lang 10/10 · date 9/9
  · rooms 10/10`. The original 38 at 37/38, the same as Phase 0: only
  `antecedent` failed, and `lang-followup` was 2/3 on repeat;
- villa's prompt (apart from its date line) and tool definitions, and
  Northwind's prompt, byte-identical to Phase 0; harbor's saved as the new
  per_room baseline;
- 36.3 tokens a row, from the real tool result sent to the model: 4 rows 150
  tokens, 124 rows 4,500. MAX_AVAILABILITY_ROWS stays 150 (≈ 5,400);
- tests 13/14/72/299, verify 69/69, isolation 16/16 and 12/12 both ways,
  rooms 15/15.

**Trap found: a measurement that measured the resolver.** The first row
probe asked the chatbot "which rooms are free from X to Y?" and read the
token count of its answer. 7, 14 and 31 days all gave 8 rows: D-046's
resolver had checked the two end dates as single days, and the model never
asked for the range. So the probe was rewritten to measure the tool result
itself, and the finding is recorded: ranges do not reach the tool as ranges,
for villa as well. It is pre-existing and not fixed here, because dates.ts is
prompt text and a change to it needs its own battery run.

**Weak, but passing:** asked about harbor's Garden Room, villa answered with
its own whole-property availability instead of saying it has no such room;
asked about villa, harbor listed its own rooms, then said it has no
information about Villa Amihan. Neither leaks anything, which is what the
cases assert.

## Booking types, Phase 7: both walls, and the bundle · done 2026-09-27

**What:**
- `packages/bookings/tools/isolation.mjs` +10: two throwaway per_room
  tenants, A and B, with villa's operator a member of both. A's staff try
  every new function against B's room: list, get, update, set rates, reorder,
  remove and add a photo, quote, a mixed group booking, the room filter;
  room availability on chat tokens for A, B and harbor; every room function
  for villa.
- `packages/rag/tools/isolation.mjs` +4: harbor's document and chunks,
  harbor's Wi-Fi password (answered by harbor, not findable from villa), and
  each tenant's tool result through executeTool.
- `plan/booking-types-phase7-bundle.mjs`: the rule-2 scan, names and values,
  values read from .env and never printed.

**Why it matters:** CLAUDE.md rule 6 wants each wall to hold alone. With RLS
on, the checks run on staff and chat tokens; with `--filters-only`, on the
service client, so only the `.eq('tenant_id', …)` filters stand in the way.
Both runs pass the same checks.

**Observed:** bookings 22/22 and 22/22; pipeline 20/20 and 20/20; B's state
(`{"unit":{"name":"B Room","capacity":2,"active":true},"rate":{"weekday_price":200000},"objects":1,"photo":{"sort_order":0}}`)
identical before and after everything A tried; the mixed group left A with
0 rows; harbor's chat token saw only its four rooms. The bundle: 0 files for
`service_role`, `SUPABASE_SECRET`, `SUPABASE_SERVICE_ROLE`,
`TENANT_SIGNING_JWK`, `guest_phone`, `@rag/db/service`, `admin_key_hash`
and six secret values, on a build with the service key empty and on one
with the full `.env`, 46 static files each.

**Trap avoided: a check that could destroy what it checks.** "A cannot
remove B's photo" is only safe to run when B's photo is disposable. With a
real tenant as B, one regression would have deleted a real photo while
reporting the failure.

**Trap avoided: a scan that scans nothing.** The first positive twin: the
same scan finds `admin/accommodations` (the new screen's fetch path) in 1
file and `image/webp` (resize-image) in 2, so "0 files" is a real zero.

## Booking types, Phase 8: the record · done 2026-09-27

**What:** the plan written into the project's own record, so the next reader
does not need the plan to understand the code:
- `decisions.md` D-050–D-056. D-042 ("exactly two definer functions") is
  amended rather than broken: `check_room_availability` is the third, for
  the reason `check_availability` is definer.
- `risks.md` R-23–R-30; R-17 (price from documents) says per_room is now
  priced by the database and villa, by decision, still is not; R-15 carries
  the date-range finding.
- `CLAUDE.md`: the header, layout and commands; rule 1 now needs three
  tenants and expects 46/48 (`rooms 10/10`); rule 6 lists the new tables and
  the bucket's policies; rule 8 lists three definer functions; traps 15–17
  (PostgREST's NULL for a missing key, `next build` under `next dev`, the
  silent refused delete); the centavos convention.
- `flow.md`: step 11b and the eight new routes.

**Why it matters:** CLAUDE.md is what the next session reads first. A rule
that still said "exactly two definer functions" would have made the third
look like a mistake, or made a fourth look allowed.

**Honest gaps recorded, not hidden:** Phase 4's browser walk; the photo limits
still provisional; `storage-orphans.mjs` planned and not built (R-30); date
ranges reaching the tool as their two end dates (R-15).

## Extra guests, Phase 1: the schema · done 2026-09-27

**What:** `packages/db/sql/schema-extra-guests.sql`: `units.standard_capacity`
and `extra_person_rate` (null = no fee, so no existing room changed price);
`bookings.base_price` and `extra_guest_price` beside `price`; `unit_quote()`,
the ONE price function; the trigger requires a per_room guest count, stores
all three amounts from `unit_quote()`, and reprices a guest-count change;
`check_room_availability` rebuilt with standard capacity, rate, fee and total
(`price` still the base). verify checks 69–74.

**Why it matters:** the request's last requirement, "the chatbot and the
booking management system use the same pricing rules", is met by
construction: there is one function, and both reach it.

**Observed:** verify 75/75; for a standard-2, maximum-4, ₱250 room at ₱3,500:
1–4 guests 350000 / 350000 / 375000 / 400000, 5 refused; a forged breakdown
stored as the database's; 2 → 4 guests repriced to 410000 at an edited rate
while a same-count re-save kept 350000; villa's availability and tools
identical to Phase 0.

**Mistake, mine:** check 65 asserted exactly 3 rates; the new Quad Room is a
fourth. It now compares with the real count, which is what it meant.

## Extra guests, Phase 2: `@rag/bookings` · done 2026-09-28

**What:** the quote calls `unit_quote()` per room with its guest count and
returns base, extra guests, fee and total per room; it refuses a party above
the room's maximum before any booking. `createBookings` maps the trigger's
"needs a guest count" to a 400 and returns the stored breakdown. New rooms
default to standard 2, maximum 4, ₱250 (`DEFAULT_*` constants); a default
standard is lowered to a smaller maximum. `listBookings` and room
availability carry the breakdown and the fee.

**Why it matters:** the arithmetic lives only in SQL; this package passes
guest counts in and reads amounts out, so the staff screen (Phase 3) and the
chatbot (Phase 4) cannot compute a different price.

**Observed:** rooms 19/19; verify 75/75; isolation 22/22 and 20/20, both ways;
the Phase 5 CLI check 6/6; the Phase 3 HTTP walk 10/10 against dev, where a
forged price stored the database's 1000000 (Family Room, 4 guests: +50000).

**Trap avoided: a helpful pre-check that leaks.** Checking "no guest count"
in TypeScript first would answer another tenant's room with the guest-count
message, while a missing room says "No such unit or slot.". The trigger
checks the unit first, so the package leaves the order to it.

## Extra guests, Phase 3: routes and screens · done 2026-09-28 (browser look owed)

**What:** the route schemas accept a guest count on a one-unit quote and the
three room properties (`maxCapacity` = `capacity`); the Rooms screen edits
Included / Max guests / Per extra guest (pesos, sent as centavos) and says in
a sentence what the fee is; the booking form sends each room's guests to the
quote, shows each room's rate, extra guests and room total and then the
total, and keeps Book disabled until every ticked room has a guest count; a
booking row shows "₱3,500.00 + ₱250.00 extra guests = ₱3,750.00".

**Why it matters:** the request's § 3 (show the rate, the extra charge and the
total separately) and § 4 (tell the guest before confirming). Every number on
screen is the server's; the screen adds nothing up.

**Observed:** walk 11/11: 201 with 2 / 4 / 25000 for a room posted with only a
name; a 3-guest quote 350000 + 25000 = 375000; 400 "Quad holds at most 4
guests." for 5 at the quote, 400 at the booking, 400 "Enter the number of
guests for each room." with none, 400 for a standard of 5 over 4.

## Extra guests, Phase 4: the chatbot, measured · done 2026-09-28

**What:** harbor's rooms now cover 2 guests and add ₱250 each (maximums
unchanged: 2, 6, 3, 2). The per_room tool describes the fee; each row carries
`included_guests` and `extra_guest_fee`, and, when the guests are known,
that party's `extra_guest_charge` and `total`, all from unit_quote(). Two
instruction lines: quote the tool's total, naming the charge, "never add up a
total yourself"; a room too small is not in the result, so say so and offer
the ones that fit. Three cases: `rt-extra`, `rt-over`, `rt-standard`.

**Why it matters:** the request's § 5. The chatbot's ₱5,050.00 for the Loft
with 3 guests is unit_quote()'s number, the same one the staff quote shows
and the trigger stores. It was not added up by the model.

**Observed:** full battery 49/51: `original 9/10 · tool 9/9 · lang 9/10 · date
9/9 · rooms 13/13`, the original 48 exactly as expected; rooms 13/13 on two
more runs. Replies, verbatim: "the Loft (3 guests): ₱4,800.00 + ₱250.00 for 1
extra guest = ₱5,050.00"; for 3 people in the Garden Room, the Family Room
and the Loft offered with totals, "Garden Room is not available for 3 guests
as it only accommodates up to 2 guests"; the Family Room for 2 guests
"₱6,000.00", no fee. Villa's and Northwind's prompts and villa's tools
identical; pipeline tests 301; isolation 20/20 both ways.

**Trap found: a missed word looked like a prompt problem.** `rt-tagalog`
passed 3 of 3 before this phase and 1 of 7 after its new lines, and the
failure read like the model ignoring a date ("Anong petsa po…?"). The real
cause was older: `dates.ts` matched "bakante" but not "bakanteng", the same
word with the Tagalog linker "-ng", so D-046's up-front check never ran and
the call was left to the model. The fix is one regex group, pinned by a test
that failed first; because dates.ts is prompt text, the whole battery was
re-run on it. Rewording the prompt until the case passed would have hidden it.

## Extra guests, Phase 5: isolation and the record · done 2026-09-28

**What:** bookings isolation check 23: tenant A's staff try to set B's room to
standard 1, fee 0, maximum 9, and to quote a party of 2 in it. The record:
D-065 (`capacity` stays the maximum), D-066 (`unit_quote()` is the only price
arithmetic), D-067 (the fee is per booking), D-068 (the breakdown is stored;
a guest-count change reprices; the guest count is not pre-checked); R-36 (a
new fee raises future prices), R-37 (a total the model adds up); CLAUDE.md
and flow.md brought up to the new numbers.

**Observed:** 23/23 with RLS and 23/23 with the code filters alone; the update
returned `null`, the quote "No such unit or slot.", and B's room still read
standard 2, maximum 2, 25000 from the service client.

**The plan, whole:** a standard capacity, a maximum and a per-guest fee per
room; one SQL function for every price; the breakdown stored and shown; the
chatbot quoting the database's total. Battery 49/51 (`rooms 13/13`), verify
75/75, rooms 19/19, walk 11/11, isolation 23/23 and 20/20 both ways. Owed:
the browser look, with booking-types' Phase 4 walk.

## Booking types and extra guests: the browser walk · done 2026-09-28

**What the user did, and what the database showed:** villa's bookings screen
unchanged (by eye); a Garden + Family booking stored as one group (#926
350000 + 0, #927 600000 + 50000 for 6 guests at the user's own standard of
4); the same Garden night again refused, no row saved; the Rooms screen's
inputs saved (Garden maximum 2 → 4, Family standard 2 → 4); Family Room
retired, its booking kept; a phone photo uploaded and moved to first place.

**The measurement the walk existed for:** the browser turned a 14,509 KB phone
photo into a 1600×1067 WebP of 88,902 bytes, with no EXIF or GPS (only an
ICCP colour profile). MAX_IMAGE_EDGE 1600 and MAX_IMAGE_BYTES 2 MiB are now
measured values, not guesses: 86.8 KB is 4% of the cap. R-27's egress becomes
concrete too: about 60,000 views of such a photo a month on the Free plan.

## Code review of the merge: three fixes · done 2026-09-28

**What:** the user's review of `e8fc28b..bf62ed4` raised four findings. Each
was re-run against the live system before anything was changed:
1. a room with no maximum (`capacity` null) was dropped from room
   availability whenever a guest count was given, because `null >= n` is
   never true: reproduced ("No Limit" listed with no count, absent for 3);
2. moving a photo right sent the first of three to the END: reproduced
   (p1,p2,p3 → p2,p3,p1), because every upload was stored at order 0;
3. an empty `enum` in the tool schema would make OpenAI refuse it:
   DISPROVED, the API accepted `enum: []`, so nothing was changed for it;
4. re-running schema-booking-types.sql after schema-extra-guests.sql fails
   on the return-type change, after putting the older trigger back:
   confirmed from the files and Postgres's rule (not executable from here).

**Fixed:** 1, `u.capacity is null or u.capacity >= p_guests`, in both files;
2, uploads take the next place and `moveImage` swaps positions then
renumbers, and the screen sends `{ move: ±1 }`; 4, the two superseded
definitions in schema-booking-types.sql run only while `unit_quote()` does
not exist yet.

**Observed:** verify 76/76 after the user ran both files in that order, with
the extra-guests checks unchanged (proof that the re-run undid nothing);
rooms 20/20; walk 11/11; isolation 23/23 and 20/20 both ways.

**Why re-verify first:** one of the four was wrong. Fixing it would have
added code for a failure that does not happen.

## Friendly refusal, fallbacks and small talk: the browser walk · done 2026-09-28

**What:** the user walked D-047–D-049 at `/t/villa`. The four turns were then
read back from villa's `messages`.

**Observed:** the Taglish question the documents can't answer ("may
restaurant po ba sa loob?") was stored as the marker, which is correct:
`messages` and the unanswered list rely on it, and only the visitor sees the
fallback (D-047). "salamat po", "okay" and "hi" each got a short Taglish
reply in code ("Walang anuman po!", "Sige po!", "Hi po! … Ako si Lia"), so
none of them fell through to the refusal (D-049).

Two more conversations followed: "do you have restaurant" and "may baboy po
kayo?", both refused. Running `replyLanguage()` on each conversation's
history gives english and taglish, so the English and Taglish fallbacks
(D-048) were both walked. A Tagalog question gets the TAGLISH line, because
Tagalog in means Taglish out (D-043).

Then "Tagalog please" was acknowledged in Tagalog, and the same question
asked again was refused with `replyLanguage()` giving tagalog (asked), so
the Tagalog line was the one shown. "english please" switched back. All
three fallbacks are now walked, with nothing owed.

**Limit of the evidence:** `messages` stores the marker, so the line shown
is worked out from the language, not read from the database.


## Payments put on hold; booking gets its own page · decided 2026-09-28

**What:** the user put `plan/payments.md` on hold. For the MVP, booking is
separate from the chat: the chatbot explains how to book, and customers book
on a separate page (not planned yet). Payments Phase 0 had started; its
baselines were not kept.

**Why it matters:** the chat stays read-only exactly as today (D-037), with
no quote tool and no "Book this" button in the conversation. Booking becomes
a normal page with a form, so it can be built and tested without touching
`buildPrompt()` or the battery.

**Observed before stopping** (from `2f7cf3c`): tests 13 / 14 / 72 / 301,
verify 76/76, pipeline isolation 20/20 both ways, bookings isolation 23/23
both ways, rooms 20/20, Northwind's snapshot and villa's tool definitions
byte-identical to their baselines. The battery was not run.

## Customer booking, Phase 0: the baseline · done 2026-09-28

**What:** before any change for the booking page, holiday pricing and stays
(`plan/customer-booking.md`), saved what "unchanged" has to mean, on
`feat/customer-booking` from `9bacea7`.

**Why it matters:** Rule 1 of the plan is that the chat does not change.
That can only be proven by a diff against something taken before the first
edit, and § 2.5 changes what "taken" means, so today's availability had to
be on record too.

**Observed, all in `plan/baseline/*-pre-customer-booking*`:**
- tests 13 / 14 / 72 / 301, typecheck green; verify 76/76; pipeline
  isolation 20/20 both ways; bookings isolation 23/23 both ways; rooms 20/20;
- Northwind's snapshot is byte-identical to `northwind-prompt-pre-bookings.txt`
  and villa's tool definitions to `villa-tools-pre-booking-types.txt`;
  villa's prompt differs only in its dated line. Harbor's tool definitions
  are saved new: they no longer match the booking-types Phase 6 copy,
  because extra-guests Phase 4 changed them;
- availability 2026-09-28..10-11: villa 42 of 42 open, harbor 56 of 56
  (4 active rooms × 14 days). There are no `pending` rows anywhere, which
  § 2.5 relies on;
- battery **49/51**, the known two (`antecedent`, D-017; `lang-followup`,
  D-043).

## Customer booking, Phase 1: the schema · done 2026-09-28

**What:** `packages/db/sql/schema-customer-booking.sql`, run by the user:
a per-tenant holiday calendar with a per-date surcharge, an optional
`holiday_price` per rate, `nightly` slots, the columns a web request needs,
`bookings_no_overlap` narrowed to `confirmed`, and `request_booking()`, the
one public write. Then `plan/customer-booking-villa-rates.mjs` gave villa
prices in the database. 16 new verify checks (77–92).

**Why it matters:** the booking page must show the price the booking will be
stored at, for villa too, on holidays too. Every one of those prices still
comes from `unit_quote()`, so the page, the staff quote, the stored booking
and the chat's tool cannot disagree.

**Observed:**
- verify **92/92**. Villa's own 24 Dec example is exactly
  2000000 + 50000 + 400000 = 2450000 (₱24,500); a holiday_price, when set,
  wins over the weekend rate (2950000);
- a 2-night request from a chat token is 2 `pending`, `web` rows, one group,
  one reference (`VER-Q4DHKJ`), priced 1650000 (Thursday) and 2050000
  (Friday), check-out 12:00 Manila on the Saturday;
- a request holds nothing: availability says open and a staff booking of the
  same night lands; confirming the request is then 23P01 and both nights stay
  pending (all or nothing);
- the walls: a chat token's direct insert is 42501, anon cannot call the
  function, another tenant's id is 42501, villa's unit is 23503, and in each
  case nothing is saved;
- villa read back at 32 guests: Overnight 1650000 Monday, 2050000 Saturday;
  its 5 older bookings still `price null`; the script's second run changes
  nothing;
- villa's and harbor's 14-day availability, all three prompts and both tool
  definitions are byte-identical to Phase 0; isolation 20/20 and 23/23 both
  ways; rooms 20/20.

**Trap avoided: a trigger inherits its caller's search_path.** The pricing
trigger named `units`, `slots` and `tenant_applications` bare. Fired by a
staff insert that works; fired from inside `request_booking()`, whose
`search_path` is `''`, it would have been "relation does not exist" on every
web request. Found by reading, before the first run; the trigger now has
`search_path = ''` and qualifies every name.

**Trap avoided: re-running an older file.** This file replaces five
definitions. The two files that made them now skip those steps once
`rate_calendar` exists; without that, re-running `schema-extra-guests.sql`
would fail (`unit_quote` changed its return type) and re-running
`schema-booking-types.sql` would quietly put back a price function with no
holidays and an availability check that counts requests as taken.

## Customer booking, Phase 2: `@rag/bookings` · done 2026-09-28

**What:** the package the routes will call. `requests.ts`: the public page's
reads (`bookingPage`, `quoteRequest`) and its one write (`requestBooking`,
through `request_booking()`), all on a chat token; and for staff,
`listRequests`, `confirmRequest`, `declineRequest`. `calendar.ts`: the
holiday list. The surcharge in every breakdown, `nightly` on slots, a
holiday price on rates, and `BookingLimitError` (429).

**Why it matters:** the page and the staff screen now have one tested set
of functions, with the same errors and messages whichever route calls them,
and none of them adds up a price: quotes come from `unit_quote()`, receipts
from the stored rows.

**Observed:**
- rooms **30/30**, the 10 new ones through a real chat token for everything
  the public page will do: a Thursday + Friday stay quoted 1650000 +
  2050000; a peak Thursday exactly 2450000 (villa's 24 Dec shape); a
  holiday at the weekend rate until a holiday_price is set, then 2500000;
  a receipt of 3700000 equal to its two stored rows;
- a request holds nothing: a second request for the same nights is
  accepted; once the first is confirmed, the second shows `clash`,
  confirming it is a 409 that leaves it pending, and a new request for those
  nights is refused up front with nothing saved;
- the walls: villa's unit id is "No such unit or slot.", the same as a
  missing one; a chat token's confirm and calendar remove are `false`
  (RLS updates nothing), its calendar write an error;
- unit tests 72 → 94: `parseRequest` (today and day 365 accepted, the day
  before and after refused; 14 nights yes, 15 no; 70 room-nights; one unit
  for whole_resort), and the phone and email normalisers;
- verify 92/92, isolation 20/20 and 23/23 both ways; all three prompts and
  both tool definitions byte-identical to Phase 0.

**Trap avoided: an optional column in an upsert.** `setRates` gained
`holidayPrice`. Sent for some rates and not others, PostgREST would send
NULL for the rest (CLAUDE.md trap 15) and silently clear a holiday price.
So it is all or none, and left out entirely an upsert keeps what is stored;
rooms 23 checks both.

## Customer booking, Phase 3: the routes · done 2026-09-28

**What:** the HTTP surface. Two OPEN routes for the booking page,
`POST /api/t/<slug>/book/quote` and `POST /api/t/<slug>/book/request`, on the
chat token like the chat itself; and staff routes beside the existing
bookings ones: `bookings/requests` (list, and confirm or decline a whole
request), `holidays` (list, set, remove, copy). The rates route takes an
optional holiday price.

**Why it matters:** the request route is the first open write in the app.
It has three limits, weakest first: a honeypot field, a per-IP window in
memory, and request_booking()'s per-contact limit in SQL, the one that
holds whoever calls. All three are now observed over HTTP, not assumed.

**Observed** (`plan/customer-booking-phase3-walk.mjs`, **10/10** against
`pnpm dev`):
- every staff route 401 with no cookie, while the open quote answers 200
  (the positive twin); another tenant's staff cookie 401 on our list, and
  404 on our request id; an unknown tenant and Northwind 404 on the open quote;
- a 2-night quote of 625000 + 775000 = 1400000; the request 201 with
  reference `WAL-CDQJWS` and 2 pending web rows; a filled honeypot, a
  landline number and `nights: "two"` all 400 with nothing saved;
- a second request for the same nights accepted, then confirming it after
  the first is 409 and both its nights stay pending; declining it 200; a new
  request for those nights 409 up front, nothing saved;
- a peak day of ₱1,000: the quote is the weekend rate 750000 + 25000 +
  100000, labelled; the other tenant's calendar shows nothing; copied to
  next year; delete 200, then 404;
- limits: per contact 201, 201, 201, 429; per IP ten 400s, then 429 with
  "Too many requests from here" before any database work;
- booking-types' own Phase 3 walk still 11/11; verify 92/92; isolation
  20/20 and 23/23 both ways; rooms 30/30; Northwind's snapshot identical.

**Limit of the evidence:** the per-IP window is per process. `pnpm dev` is
one process, so check 9 proves the code, not the behaviour on Vercel,
where several instances each keep their own count (R-39).

## Customer booking, Phase 4: the screens · code done 2026-09-28, walk owed

**What:** S-6, the public booking page at `/t/<slug>/book`; S-7, the staff
Holidays screen; a Requests section on the Bookings screen; and a **Book**
button in the chat, shown only when the tenant has a page to open
(`hasBookingPage()`, new in `@rag/bookings`).

**Why it matters:** it is the whole of the MVP's new booking flow, and the
chat stays out of it: the button is UI, not a model reply, so no prompt or
tool changed.

**Observed from the running dev server:**
- `/t/villa/book` and `/t/harbor/book` 200; `/t/northwind/book` 404, the
  ordinary "No such workspace"; the Holidays page likewise;
- the chat's Book link on villa and harbor, and none on northwind;
- villa's real data through the open quote route: a 2-night Overnight from
  29 Oct for 32 guests is 1650000 + 2050000, and `available: false`,
  because a real confirmed Day Tour on 30 Oct (#56, 08:00–17:00) overlaps
  the first night (14:00 to 12:00). That is the constraint's own test, seen
  from the page;
- typecheck clean.

**Trap avoided: a quote on every render.** The list of units offered for
the slot was rebuilt on every render; the rooms depended on it, and the
quote effect on the rooms, so the page would have asked the server for a
price in a loop. It is memoised on the slot.

**Limit of the evidence:** nothing here was clicked. The server-rendered
HTML and the routes were checked; the forms, the receipt and the staff
buttons are the user's browser walk (status.md). No `next build` was run,
because dev was running (trap 16).

## Customer booking, Phase 5: the chat, measured · done 2026-09-28

**What:** the chat now tells people to book on the page, and it does so
from the DOCUMENTS, not the prompt. Villa's "How to book" says press the
Book button, that a request is not yet a booking, and that the chat cannot
make, change or confirm one; villa's rates document says the page shows the
exact price; harbor's guide gained a BOOKING section. Re-ingested by
`plan/customer-booking-phase5-docs.mjs`. Five new battery cases, `book-*`.

**Why it matters:** CLAUDE.md rule 1. A prompt edit is how a helpful change
quietly costs a refusal, so this phase changed no prompt text at all, and
proved it by diff: Northwind's, villa's and harbor's prompts and both tool
definitions are byte-identical to Phase 0.

**Observed:**
- full battery **53/56**: `original 9/10 · tool 9/9 · lang 9/10 · date 9/9
  · rooms 13/13 · book 4/5`. Every existing group exactly at Phase 0's
  49/51 (`antecedent`, `lang-followup`, the known two);
- "How do I book?" (villa) and "How can I reserve a room?" (harbor) answer
  with the Book button; "Please book the Overnight … for me" and "Book the
  Garden Room …" each checked availability (1 tool call), said the chat
  cannot book, and pointed to the page. No reply claimed a booking;
- `book-how-tl` ("Paano po mag-book?") named the page and claimed nothing
  in every run, and was pure Tagalog in 3 of 6 (en-share 0.02). The case
  now prints the language mix and judges only the booking part, because the
  lean is D-043's and `lang-*` already counts it. `book-*` 5/5 after;
- pipeline isolation 20/20 both ways and verify 92/92 on the new chunks.

**Trap avoided: a verdict you cannot read.** The failing case's reason was
past the log's 360-character cut. The battery now prints `why:` on its own
line, and the failure was repeated before deciding anything (R-18): the
reason turned out to be the language counter, not the booking answer.

## Customer booking, Phase 6: isolation and the bundle · done 2026-09-28

**What:** six more cross-tenant checks in `packages/bookings/tools/isolation.mjs`
(24–29) for everything this plan added, and the bundle grep with
`guest_email` on its list, run on two fresh builds.

**Why it matters:** CLAUDE.md rule 6 says each wall must hold alone, and the
new tables and the one new write had no cross-tenant check yet. Rule 2 says
no secret reaches the browser, and the page now carries a guest's email.

**Observed:**
- bookings isolation **29/29**, with RLS on operator staff tokens and again
  with `--filters-only` (service client, RLS bypassed): A sees none of B's
  holiday days, cannot remove one (`false`, it stays), and keeps its own
  entry on the same date; that date quotes 100000 in A and 200000 + 50000
  in B; A's page lists A's room and calendar only, and B's room quotes with
  exactly the message a missing room gets; northwind has no page; A's chat
  token requesting B's room is refused with no row in either tenant; A's
  staff see none of B's requests and get `false` on confirming or declining
  B's, the same `false` as a made-up id, while B's stays pending; then B
  confirms its own, and only B's room reads taken;
- pipeline isolation 20/20 both ways;
- two fresh `next build`s, one with `SUPABASE_SERVICE_ROLE_KEY` empty and
  one with the full `.env`: both compiled; both scans of the 55 static files
  found 0 of the eight names (`service_role`, `SUPABASE_SECRET`,
  `SUPABASE_SERVICE_ROLE`, `TENANT_SIGNING_JWK`, `guest_phone`,
  `guest_email`, `@rag/db/service`, `admin_key_hash`) and 0 of the six secret
  values; the positive twin found `admin/holidays` and `book/request`, so the
  scan read the bundle that has the new pages in it.

**Trap avoided, again: `next build` under `next dev`.** The dev server was
stopped first, with the user's OK, and restarted in the background after
both builds (CLAUDE.md trap 16).

## Customer booking, Phase 4: the browser walk · done 2026-09-28 (by the user)

**What:** the user walked S-6, S-7 and the Requests section in the browser.
Read back from the database afterwards, not taken from memory.

**Observed:**
- villa: three requests sent from the page and confirmed on S-3. A Friday
  Overnight for 31 guests stored as 2000000 + 25000 = 2025000 (the weekend
  rate, one guest above the 30 included); a Tuesday Day Tour at 950000; and
  24 Dec, after "Christmas Eve" (+₱4,000) was typed on S-7, stored as
  2000000 + 0 + 400000 = 2400000 for 2 guests: the holiday rate is the
  weekend rate, plus the surcharge, exactly as § 2.3 says;
- harbor: two requests for Garden + Family Room on the same night, then a
  third for the Garden Room alone, confirmed. `listRequests` then reads
  `clash: true` on both earlier ones, and the user saw the 409 on Confirm;
- the user also saw the wrong-phone message on the page, and the Book
  button on villa and harbor with none on northwind;
- cleanup: the 8 web rows were hard-deleted (0 left; villa back to 5
  bookings, harbor to 3), and villa keeps 24 Dec in its calendar.

**Limit of the evidence:** no multi-night stay and no declined request was
clicked; those paths are proven by verify 82–83, rooms 24–26 and the HTTP
walk. The 409, the phone message and the button are the user's report; the
database shows the state that makes the 409 the only possible answer.

**Worth knowing:** once the list reloads, a clashing request's Confirm
button is disabled by `clash`, so the 409 is reachable only from a stale
list (a second tab, or a confirm racing another). That is the case the
constraint exists for: the button is a courtesy, `bookings_no_overlap` is
the guard.

## Customer booking, Phase 7: the record · done 2026-09-28

**What:** the plan's decisions and risks written down where the next
reader will look: D-069 (booking is the page's, the chat explains), D-070
(a request holds nothing), D-071 (`request_booking`, the fourth definer
function), D-072 (the holiday calendar; R-24 closed), D-073 (a stay is N
rows; villa priced); R-38–R-41 (fake requests bounded, the per-IP limit
weak by design, the gap inside a stay, villa's rates in two places).
CLAUDE.md gained the header paragraph, the new files and commands, the
54/56 battery line, `rate_calendar` and `request_booking` in rules 6 and 8,
traps 19–21 and two conventions; flow.md the new node, step 11c and nine
routes.

**Why it matters:** "if someone asks why does this work, the answer must be
in the code, not in a dependency", and for a decision, in these files. The
two that most need to be findable later are D-070 (why a request does not
block a date, which will look like a bug to the first person who sees two
requests for one night) and trap 20 (why the older SQL files skip steps).

**Observed:** nothing new was run in this phase; every number quoted is
from the phase that measured it, and cited by check number.

## R-15, the range half: "from X to Y" is one call · done 2026-09-28

**What:** `packages/rag/src/dates.ts` resolves a range as a range. Two
single dates with only a connector between them ("to", "until", "till",
"through", "hanggang", a dash, "between … and") become one span; a bare
weekday as the second end rolls forward past the first ("Friday to Sunday"
on a Sunday is the Sunday after that Friday); a night count within three
words of a date ("10 October for 2 nights", "dalawang gabi mula 10
October") extends it to the nights slept. `planDates` then runs ONE
`check_availability` with `date_from` and `date_to`.

**Why it matters:** booking-types Phase 6 found "which rooms are free from
X to Y?" checked as two single days, with everything between unasked, and
7, 14 and 31 days all answered from 8 rows. Multi-night stays (D-073) made
that the normal question.

**Observed:**
- 18 new unit tests, every shape above, plus the ones that must NOT join
  ("Friday and Monday" stays two days; out of order stays two; an ambiguous
  "next Friday" never joins; harbor's "Night" slot is not a night count);
- Northwind's, villa's and harbor's prompt snapshots byte-identical: the
  lines exist only on an availability turn, which the snapshot is not;
- battery **57/58**: `date 11/11` with the two new cases. `date-range`
  ("from 9 October to 12 October") made one call, `2026-10-09..2026-10-12`,
  and named both ends; `date-nights` ("12 October for 2 nights") made one
  call, `2026-10-12..2026-10-13`, and answered in Taglish naming the date.
  Every other group at its baseline; `lang-followup` passed (its 1 in 3).

**Trap met: "Friday to Sunday" on a Sunday.** The first test run joined
nothing, because "Sunday" resolved to today, which is before the Friday.
The test's expectation was right and the code was wrong: the second end,
when it is a bare weekday, must be the next one after the first end.

**Trap met: the night count is not always adjacent.** "10 October free for
2 nights" has a word between the date and the count. Up to three words are
skipped on either side; the skipped words are not blanked, only the count.

## R-30: the orphaned-photo sweeper · built and run 2026-09-28

**What:** `packages/bookings/tools/storage-orphans.mjs`, the script
booking-types § 2.8 named and nobody built. It walks the `unit-images`
bucket in its `<tenant>/<unit>/<file>` shape (paged, 1000 a page), matches
every object with `unit_images.path`, and reports objects with no row (by
tenant, naming a deleted tenant as such), rows with no object, and anything
not of that shape. Dry run by default; `-- --remove` deletes the orphans
and compares Storage's count with what was asked.

**Why it matters:** a photo is two things, a row and an object, and only the
row is cascaded. A leftover object shows on no screen, so without a scan it
is unknowable, and the bucket is now customer-facing.

**Observed:**
- the real bucket: 2 objects, 2 rows, 2 matched, 0 orphans, 0 broken rows;
- the positive twin, because a zero on its own proves nothing (trap 12): a
  70-byte PNG planted at `0/0/probe.png` (tenant 0 does not exist) showed up
  as `orphans in 0 (NO SUCH TENANT): 1` with "nothing removed (dry run)";
  `--remove` printed `removed 1 of 1`; the next run was back to 0.

**Limit:** nothing schedules it. It is the command to run after deleting a
tenant, or after a `WARN orphaned photo` line in the log.

## Villa's prices from the tool, one source of truth · done 2026-09-28 (D-074)

**What:** villa's `check_availability` now carries the price for each slot
and date from `unit_quote()`, the included guests, the extra-guest fee and,
with `guests`, the total; the six rates, the ₱250/30-guest fee and the
₱4,000 December surcharge left `02-rates-and-schedules.md`, `05-house-rules.md`
and `08-faq.md`; villa's calendar holds its fixed dates and Holy Week 2027.
`check_room_availability`'s `per_room` gate became "has a rate", the user
re-ran the file, and `checkPricedAvailability()` exposes it for any tenant.

**Why it matters:** the page priced from the database and the chat from
prose, and a rate edit on one side silently changed the other (R-41). Now
every peso a guest sees is one function's.

**Observed:**
- verify 92/92; rooms 30/30; bookings isolation 29/29 both ways; pipeline
  isolation 20/20 both ways, its villa check now asserting the three rows
  are ₱9,500 / ₱16,000 / ₱22,000 on a weekday, from villa's own rates and
  none of harbor's;
- Northwind's and harbor's prompts and harbor's tool definitions
  byte-identical; villa's differ by design and are the new baseline;
- battery **59/61**: `price-villa` quoted the tool's ₱16,000.00 for the
  Overnight on 12 October; `price-villa-guests` the tool's ₱10,000.00 total
  for 32 on a Day Tour, naming the ₱500.00 extra charge; `price-villa-tl`
  resolved "sa Sabado" in code and quoted the tool's ₱20,000.00 for that
  Saturday. Every other group at its baseline; the two known failures.

**Trap met: an up-front check without the party size.** The first full run
was 51/61. "How much is the Loft for 3 guests on …" had become an
availability turn (the new price words), so D-046 ran `check_availability`
before the model's turn, WITHOUT the guests, and the prompt told the model
to answer from that result. It did: rows with no total, and it added one up
itself, on harbor (rt-extra) and on villa (price-villa-guests): R-37 by
another door. `dates.ts` now reads "for 3 guests", "32 kami", "kaming lima"
and the count rides on the call; both cases then quoted the tool's total.

**Trap met: language cases that measured a fact the plan removed.** Five
`lang-*` cases asked villa's rates as their fact. With the figures gone,
two asked for a date in pure Tagalog and two refused; all were right about
prices and wrong as language cases. They now ask the deposit, the
extension and the cook. `lang-taglish`'s first replacement (the corkage)
answered in noun-Taglish the function-word counter reads as Tagalog, 3 of
3; the extension question reads as Taglish 3 of 3 ("Usually po, hindi
puwedeng mag-extend after checkout. Pero kung walang booking sa next
slot…").

**Cost recorded, not hidden:** `lang-tool`'s opening sentence changed from
"Yes po, the Overnight slot is open pa sa …" to "Yes po, may bakante pa sa
…", 3 runs of 3, once the price lines were in villa's block. Both are
Taglish to a reader; the second has one English function word. The case now
asks for Tagalog present and not pure English, and prints the mix. Nothing
in the prompt was reworded to satisfy the counter (trap 10).

**Limit:** `rt-leak-2` failed once on wording ("there is no specific
mention of a Garden Room, but the entire property is available", which the
check read as a claim) and passed 3 of 3 on repeat; unchanged.

## Alteza, the fourth tenant: documents, rooms and calendar by script · done 2026-09-29

**What:** eleven documents under `sample-documents/alteza/`, one per section
of `sample-documents/OWNER-QUESTIONNAIRE.md` (a checklist for the first
meeting with a resort owner, and how guests ask the same things), loaded by
`plan/alteza-load.mjs`; six rooms with Day Use and Overnight rates, an
extra-guest fee and a holiday calendar, loaded by `plan/alteza-rooms.mjs`.
Both scripts run as alteza's operator member on a staff token
(plan/auth-rls.md § 2.7) and are idempotent, so a document edited in the
folder is re-ingested (new id, D-044) and a room edited by staff is kept.

**Why it matters:** it is the first tenant built from the questionnaire
rather than from an existing corpus, so the questionnaire is now tested
against a real set of answers. And it is the last tenant that needs the
command line for its record: `plan/tenant-management.md` puts the tenant
form in the browser. The documents and rooms scripts stay in use (its § 8 q6).

**Observed** (`plan/baseline/alteza-load-2026-09-29.txt`,
`alteza-rooms-2026-09-29.txt`):
- 11 documents ingested, 48 chunks, ids #334–#344, 3 to 6 chunks each;
- rooms: Casa Uno 2/3, Casa Dos 2/3, Familia 4/6, Kubo A 2/4, Kubo B 2/4,
  Loft Suite 2/2; ₱350 per extra guest where included < maximum, none for
  the Loft; Day Use from ₱2,200/₱2,800 to ₱4,500/₱5,500, Overnight from
  ₱3,500/₱4,400 to ₱6,500/₱8,000 (weekday/weekend);
- calendar: 10 days set, +₱1,000 on 24 Dec, 31 Dec and 1 Jan for 2026–2028,
  Holy Week 2027 (25–28 March) marked with no surcharge.

**The rates are invented placeholders.** The documents hold no figures on
purpose (questionnaire rule 2: prices live on the Rooms and Holidays
screens), so the script's numbers exist to make the booking page and the
tool work until the owner sets the real ones. Nothing has to change in the
documents when they do.

## Tenant management, Phase 0: the baseline · done 2026-09-29

**What:** on branch `feat/tenant-management`, every suite on the code the
plan was written against, the three prompt and tool snapshots diffed
against their baselines and saved again, a dry run of every constraint
Phase 1 adds against every live row, and the members of every tenant on
record. Nothing changed but the plan's own text.

**Why it matters:** Rule 3 says the battery must not move, and § 2.5 says a
constraint a live row fails is a migration. Both can only be judged against
something taken before the first edit.

**Observed** (`plan/baseline/*-pre-tenant-management*`,
`tenant-management-shapes-2026-09-29.txt`, `members-2026-09-29.txt`):
- verify 92/92; tests 13 + 14 + 94 + 329; typecheck clean; pipeline
  isolation 20/20 both ways; bookings isolation 29/29 both ways; rooms 30/30;
- northwind's prompt, villa's and harbor's tool definitions byte-identical;
- the dry run 23/23: four tenants, themes of 0, 3, 0 and 0 valid keys, no
  logo or banner anywhere, names within 1–100 and 1–50, no reserved slug,
  no bookings config with the two new keys (so absent → 14 / 365 holds
  for all three);
- seven memberships over four tenants: one operator each, plus one human
  test account for villa, harbor and alteza. Every row becomes `admin` in
  Phase 1 (§ 8 q8);
- battery **57/61**: `original 9/10 · tool 8/9 · lang 9/10 · date 11/11 ·
  rooms 13/13 · book 4/5 · price 3/3`.

**Trap met: the battery moves with the calendar.** Two verdicts flipped on
code that had not changed since the 59/61 of 2026-09-28. Both were
repeated first (R-18) and both trace to FREE being 13 October today:
`tool-leak` because "13" is a full-text token in one northwind chunk, so
the keyword rescue kept a model call the case forbids (the refusal and the
zero tool calls held); `book-for-me-harbor` because the same four chunks
fused in a different order and the model offered to send the request
itself instead of naming the Book button (no booking claimed). Neither is
this plan's to fix, so Rule 3 was reworded to "verdict for verdict against
Phase 0's file", and both are owed a separate look: a date-independent
`tool-leak`, and R-23's new shape for harbor.

## Tenant management, Phase 1: the schema · done 2026-09-29

**What:** `packages/db/sql/schema-roles.sql`: `memberships.role`
(`owner | admin | staff`, every existing row backfilled to `admin`),
`platform_admins`, `app_role()`, `app_is_admin()` redefined as owner or
admin under the thirty policies that name it, `app_is_staff()` for the six
bookings and unanswered policies, `app_is_super()`, `tenants.archived_at`
and the first policy `tenants` has had (super only), `tenant_public()`
hiding archived tenants, the theme, https, name-length and reserved-slug
constraints, super and owner policies on `tenant_applications` and
`memberships`, a no-delete-while-live trigger, a last-owner trigger,
`request_booking()` reading `max_stay_nights` and `max_advance_days` from
the config, and two definer lookups into `auth.users`. Five earlier files
gained trap-20 guards. `@rag/db` gained `mintPlatformToken()`.

**Why it matters:** the database now knows three business roles and one
platform, and refuses on its own what the routes will refuse in Phase 3, so
each wall can be tested alone (plan Rule 2). And a tenant can be created,
edited and archived by a token that reads no tenant's content.

**Observed** (`plan/baseline/verify-tenant-management-phase1.txt`,
`eval-tenant-management-phase1.txt`):
- verify **109/109**, 17 new: a staff token cannot insert a document and an
  admin can; a staff token inserts and reads a booking; a chat token and a
  staff token read 0 `tenants` rows while a platform token with its row
  reads all 5 and 0 documents, chunks and bookings; the same token without
  the row reads 0 tenants; the platform renames and archives a tenant and
  `tenant_public()` returns 0 rows until it is unarchived; five bad shapes
  refused with 23514 and a valid theme accepted; four bad config values
  refused and 7 / 90 accepted; `member_emails()` lists 3 members to a staff
  token and refuses a chat token and another tenant's id;
  `user_id_by_email()` resolves a trimmed, mixed-case address for an
  owner, null for an unknown one, 42501 for staff; a member reads its
  tenant's 3 rows and a chat token 0; an owner promotes staff (1 row) while
  staff and a cross-tenant update touch 0; the last owner cannot leave or
  step down (23514) until a second owner exists; 3 nights accepted and 4
  refused naming 3, 250 days out refused naming 200; switching bookings off
  refused while live, allowed once cancelled;
- pipeline isolation 20/20 both ways; bookings isolation 29/29 both ways;
  rooms 30/30; tests 13 + 14 + 94 + 329; typecheck clean;
- northwind's prompt and both tool baselines byte-identical; battery
  **57/61**, verdict for verdict the same four as Phase 0 (`original 9/10 · tool 8/9 · lang 9/10 · date 11/11 · rooms 13/13 · book 4/5 · price 3/3`);
- seven memberships, all `admin`; `platform_admins` empty.

**Trap met: a write under RLS reaches only what the token can read.** The
owner policies were right and still did nothing: an UPDATE's target rows
are filtered by the SELECT policies first, and an owner could see only its
own row. verify's positive twin (1 row promoted) is what showed it; the
negative checks alone would have passed. The fix, a tenant-wide read
policy, then met the recursion rule: a policy that calls a function that
reads the same table under that policy is "infinite recursion detected",
so `app_role()` became SECURITY DEFINER. It reads the caller's own row and
nothing else, which `memberships_read_own` already showed it.

**Trap met: a column that loses its default breaks every writer at once.**
Nine tool inserts into `memberships` failed with 23502, unreported, and
the symptom was every staff write refused everywhere: no member, no
`app_is_admin()`. Every insert now names its role, and `member.mjs` writes
`admin` until Phase 2 gives it a role argument.

## Tenant management, Phase 2: `@rag/db` and the CLI · done 2026-09-29

**What:** the package half of roles and the platform. `staffClient()` now
returns `{ db, role }`, the role from the very row `app_role()` reads in
every policy, so the code and the database can never disagree about it
(plan Rule 4). `platformClient(userId)` mints the tenant-less token and
reads the caller's own `platform_admins` row through it, the way
`staffClient()` reads the membership. The hand-written types gained
`MemberRole`, `platform_admins`, `archived_at` and the five new
functions. The CLI gained `super:add|remove|list`, a role on `member:add`,
`member:role`, `tenant:archive` and `tenant:remove`, and `@rag/db` gained
its first unit tests, five of them, pinning the two token shapes claim by
claim.

**Why it matters:** Phase 3's `requireAdmin(request, tenant, permission)`
needs the role in hand, and the platform routes need a client that is the
platform and nothing else. And until the browser form exists, the CLI is
how the first super user and the first owners come to be.

**Observed:**
- build and typecheck clean; tests 13 + 14 + 94 + 5 + 329; verify 109/109;
  pipeline isolation 20/20 both ways; bookings isolation 29/29 both ways;
  rooms 30/30: nothing moved;
- the CLI walk on a throwaway tenant (`cli-probe`, id 310): add as staff;
  add again as owner keeps staff and says so; `member:role … owner`;
  `member:role … staff` refused by Postgres, "Tenant 310 would be left
  with no owner"; a bogus role refused by the CLI before any query;
  `tenant:archive` and `loadTenant()` returned null; `--undo`;
  `tenant:remove` without `--yes` printed 13 counts and deleted nothing;
  with `--yes` it cascaded and the sweeper reported 2 objects, 2 rows, no
  orphans; a second `--yes` said "no tenant"; `super:add` on an existing
  account sent no email, `super:list` showed it, `super:remove` took it
  back, and the platform is empty again.

**Worth knowing: vitest needs the same condition as Node.** `server-only`
resolves to a throwing module unless the `react-server` condition is set,
which is why every db script carries `--conditions=react-server` (rule 4).
`packages/db/vitest.config.ts` sets `resolve.conditions` to the same, so a
test can import `tenant-client.ts` directly; the test signs with a
throwaway P-256 key, because the claims are what is under test and the
signature is verify's, live.

## Tenant management, Phase 3: the guards in `apps/web` · done 2026-09-29

**What:** one permission table (`lib/permissions.ts`), a required
`permission` argument on `requireAdmin()` named at all 31 call sites, a 403
that says which role lacks which permission, the platform session
(`lib/platform-auth.ts`: its own cookie, path and payload kind, one HMAC
helper shared with the staff cookie, `requirePlatform()` and
`withPlatformRoute()`), the theme rules moved into a pure module the form
can import, the session GET answering with the role, and the two screens
that had something to hide hiding it: the knowledge base's form and its
Edit and Delete for a role without `documents:write`, and the bookings
screen's Rooms and Holidays tabs for a role without those reads.

**Why it matters:** wall 1 of plan Rule 2. Postgres refuses a staff write
already (Phase 1); now the route refuses it first, with a reason a person
can act on, and the compiler refuses a route that forgot to say what it
needs. The screens hide what the route would refuse, which is a courtesy,
not a guard, and the comments say so.

**Observed:**
- typecheck clean, after the compiler listed every unnamed call;
- `apps/web` tests 17/17: for each of the twelve permissions the roles
  `can()` grants equal the roles the policies let through, listed by hand
  from `schema-roles.sql`; roles only add upward; the colour regex, the
  read-side `themeVars()` and the form's `parseTheme()`;
- staff-cases 13/13 against `pnpm dev`: the session names the role
  (staff → staff, admin → admin); staff POST /documents → 403 "Your role
  (staff) may not do this (documents:write). Ask an owner of "villa" to
  change it."; staff bookings 200, rooms 403, documents read 200; the
  original cases unchanged;
- verify 109/109; every package's tests unchanged; both changed screens 200.

**Worth knowing: a GET needs an honest permission too.** The plan's table
had nine permissions and no read for rooms or holidays; naming
`rooms:write` on a GET would have been a lie the compiler accepts. Three
more permissions (`session`, `rooms:read`, `holidays:read`) let every call
site say what it does, and the test pins each to its policy.

## Tenant management, Phase 4: the platform and members routes · done 2026-09-29

**What:** the HTTP half of tenant management. Two pipeline modules hold the
work: `platform.ts` (list, get, create, edit, archive, applications) on a
`PlatformContext`, and `members.ts` (list with emails, add an existing
account, change a role, remove) on whichever client calls, an owner's staff
token or the platform's. Seven route files put them on the web: the platform
session, tenants, one tenant, archive, applications, any tenant's members,
and a tenant's own members for its owners. One function, `fromPostgrest()`,
turns a PostgREST error code into a status, and the message stays Postgres's,
because the rule that refused is Postgres's.

**Why it matters:** this is where "a super user creates a tenant in the
browser" becomes possible, and where the two tokens are proven to stay in
their lanes over HTTP: a platform cookie at a tenant route is a 401, a tenant
cookie at the platform is a 401, and the platform reads no tenant's content
while managing every tenant's record.

**Observed** (`plan/tenant-management-phase4-walk.mjs`, 11/11 on `pnpm dev`):
- login 200 with a four-part `rag_platform` cookie; a non-super account, a
  wrong password and an unknown email each 401 with one message;
- create: a bad slug 400 in zod's words, `platform` 400 in Postgres's,
  `probe-tm` 201 with 0 members, the same slug again 409;
- edit: the new name and `--accent:#0f766e` in the rendered chat page; a
  bad colour, an http logo and a slug edit each 400;
- applications: no timezone → the trigger's own sentence; on → 200;
  `max_stay_nights: 0` → "a whole number of nights from 1 to 60"; 3 and 60
  stored and returned; an unknown key 400;
- members from the platform: unknown email 404 naming `member:add`, an
  owner 201 (case-insensitive email), a staffer 201 and two listed with
  emails, a duplicate 409, demoting the only owner 409 "Tenant 334 would be
  left with no owner";
- the owner's own route: lists 2, promotes the staffer to admin; that admin
  gets 403 "Your role (admin) may not do this (members:manage)" there and
  200 on the documents list;
- archive: page, admin page and chat route 404; the platform GETs the
  tenant by id with `archivedAt` set; unarchive brings the page back;
- bookings off 200 with no key left, again 404;
- the `platform_admins` row deleted mid-session → 401 on the next request
  and the session GET says `platform: false`;
- typecheck clean, tests unchanged, staff-cases 13/13, verify 109/109.

**Worth knowing: the dev server compiled what `tsc` refused.** The walk
passed 11/11 before the build did: Next's dev compiler let an update row
typed `Record<string, unknown>` through, and `tsc` did not. Typed as the
table's own `Update`, a typo'd column is now a compile error, which is the
point of the hand-written types.

## Tenant management, Phase 5: the screens · code done 2026-09-29 (the browser walk is Phase 7)

**What:** `/platform`: a login form until the session says so, then the
tenant list and one form per tenant. The form creates a tenant from three
fields, and edits everything else: names, logo and banner, the five theme
colours with a live preview, the fallback messages per language, the
bookings application's config as plain fields, the members, and archive.
`/platform/reset` closes the invite detour of Phase 2. `/t/<slug>/admin/members`
is the owners' Members screen, and the knowledge base shows a Members tab to
owners. One members panel serves both the platform and the tenant screen.

**Why it matters:** this is the feature the user asked for, in the browser:
a super user creates and edits tenants, and owners manage their staff's
roles, with no command line. The command line keeps the two things a
request may not do: invite a new account (the service key) and delete a
tenant for good (guest data and photos).

**Observed:**
- typecheck clean; `/platform`, `/platform/reset`, `/t/villa/admin/members`
  and `/t/villa/admin` render 200 on `pnpm dev`;
- the platform's "Forgot password?" answers the generic sentence, as the
  staff one does;
- the Phase 4 walk 12/12 with the new 6b: the platform adds ITSELF as owner
  by user id (201, three listed) and removes itself (200, two left, the
  other owner keeping the trigger quiet); staff-cases 13/13; web tests 17/17.

**Worth knowing: generalise, do not copy.** `LoginForm` and `ResetPassword`
were the staff screens' and took the platform's paths as props (bookings
Phase 4 had already extracted the login form so a second copy could not
drift; this is the same rule one step on). `addMember()` grew a second key,
`userId`, because a browser legitimately knows one id, its own, and
"Make me an owner" (plan § 8 q5) is that id and nothing else. The theme
preview is the page's own mechanism, a `.tenant-root` carrying custom
properties through `style`; there is no `<style>` tag and no new CSS.

## Tenant management, Phase 6: proving the walls · done 2026-09-29

**What:** every suite on the finished code, one new isolation check, and
the tenant-filter grep read line by line.

**Why it matters:** plan Rule 2 says each wall is tested alone, and Rule 5
says both walls for everything new. Phase 1 built the SQL-level checks into
verify as the schema landed; this phase adds the one that only the pipeline
can make (a platform token through the routes' own functions) and re-runs
the lot.

**Observed:**
- pipeline isolation 21/21 on tokens, 20/20 with filters alone: the new
  check, villa's context on a platform token, reads 0 documents, 0 chunks,
  a null document and a null transcript; it does not run under
  `--filters-only`, because there a platform token and villa's are the same
  service client, and the comment says so: that wall is Postgres's alone;
- bookings isolation 29/29 both ways; rooms 30/30; verify 109/109;
  staff-cases 13/13; the Phase 4 walk 12/12;
- battery 56/61: Phase 0's four, plus `leak-2`'s control (below);
- the grep: every pipeline query on the four content tables carries its
  tenant; `listTenants()` alone reads across tenants, on purpose.

**Trap met: an identical prompt, a different answer.** `leak-2` failed 4 of
4, and the half it exists for, northwind refusing villa's Wi-Fi password
with 0 chunks retrieved, held every time. Its control, villa answering the
same question, is what changed: the same five chunks with the same five
scores, the same 1957-token prompt, and `gpt-4o-mini` answering at 11:xx
and 14:xx (27 and 24 output tokens) and refusing at 16:xx (11 tokens, the
marker). The password is whole in the chunk. When retrieval, prompt and
data are byte-for-byte the same and only the reply moves, the cause is the
model, and the record says so rather than rewording anything (Rule 3,
R-18).

**The bundle**, once the user stopped `pnpm dev`: `next build` clean, with the
twelve new routes and three new pages in its table; 68 files under
`apps/web/.next/static/` contain none of nine secret names (the rule 2 list
plus `app_super`, `platform_admins`, `rag_platform`, `ADMIN_COOKIE_SECRET`)
and none of five secret values read from `.env` (the service and secret
keys, the cookie secret, the OpenAI key, the signing key's private `d`);
the positive twin, `members:manage` from the client-side permission table,
is in 4 of them, so the grep looked at the right files.

## Tenant management, Phase 7: the browser walk · done 2026-09-30 (by the user)

**What:** the plan's script, with the real super account: a tenant created
at `/platform`, its theme previewed live, bookings switched on with the
new limits, "Make me an owner", every tab as owner including Members, the
last-owner refusal, villa as staff with the knowledge base read-only and
the Rooms and Holidays tabs gone, archive (chat 404) and unarchive,
`tenant:remove --yes` with the counts and the sweeper. The user's verdict:
"all as described".

**Why it matters:** every earlier phase proved a route or a policy; this is
the feature as a person meets it, and the one check no script makes (the
preview, the hidden tabs, the sentences on screen).

**Observed:** nothing did not match. The villa-as-staff step used the
user's own account (`member:add … staff`, then `member:remove`) because
the test account's password was lost; that path sends no email, which is
the path the plan recommends anyway (§ 8 q3).

## Tenant management, Phase 8: the record · done 2026-09-30

**What:** D-075–D-079 in `decisions.md`, D-041 marked reversed, D-039 and
D-038 marked amended and extended, D-042 amended to ten definer functions
with the reason each one is; R-42–R-44 in `risks.md` and an "after tenant
management" paragraph; CLAUDE.md's header paragraph, layout, commands,
rules 3 and 8, traps 22–24 and the staff convention; flow.md's route table,
"Admin" and a new "Platform" paragraph; the plan's Phases 7 and 8 and its
status line.

**Why it matters:** CLAUDE.md is what the next session reads first, and it
now says that roles exist, that the platform is a second token shape that
reads no content, that a route names its permission or does not compile,
and which three traps this plan met.

## One header nav, by role · done 2026-09-30

**What:** every tenant page (chat, book, knowledge base, unanswered,
bookings, rooms, holidays, members, reset) draws its header links from one
component, `components/tenant-nav.tsx`. The links come from one pure
function, `navItems()` in `lib/nav-items.ts`: Chat and Book for everyone,
then each staff page this role may open by `lib/permissions.ts` and this
tenant has by `lib/nav.ts`, then Log out.

**Why it matters:** before this, each screen hand-picked its own links.
Holidays had no link to the knowledge base, Unanswered had none to
Bookings, and only the knowledge base linked to Members. Now every page
offers the same set for the same person, and a new page is added to the
list in ONE place. The header is still a courtesy. The pages still 404 on a
missing feature and the routes still answer 403 on a missing permission.

**Observed:** web tests 23/23. The six new ones pin the header for a
visitor, staff, admin and owner on harbor-, villa- and northwind-shaped
tenants: staff see `Knowledge base, Unanswered, Bookings`; admin adds
`Rooms, Holidays`; owner adds `Members`. All 27 tenant pages answered as
before against `pnpm dev`.

**Trap avoided:** the features come from the same checks the pages 404 on
(`hasApplication`, `bookingType === 'per_room'`, `hasBookingPage`), so a
button never leads to "No such workspace".

## The booking page says the tenant's max stay up front · done 2026-09-30

**What:** the tenant's `max_stay_nights` now reaches the booking page,
the quote and `parseRequest()` through `parseConfig()` (`maxStayNights`,
default 14). The Nights field says "Up to N nights" before anything is
typed, and turns red as soon as N is passed.

**Why it matters:** before this, only `request_booking()` knew the
tenant's number. A customer found out on submit, after filling in the whole
form, and a tenant who allowed more than 14 nights could never get them.

**Observed:** villa set to 3 for the check showed "Up to 3", and its quote
refused 4 nights with `A stay is at most 3 nights.` Restored afterwards.
Bookings tests 96/96, including the new ones for a tenant's own limit and
for two bad configs refused.

**Then the booking horizon, the same way:** `max_advance_days` (default
365) now sets the page's latest date, the quote's check and
`parseRequest()`'s, counted from the tenant's today like
`request_booking()`. The date field says "Up to <date>". Villa set to 30
days showed "Up to Fri, 30 Oct 2026" and refused 1 December. Restored, it
quoted 1 December again. Bookings tests 97/97.

## Closed dates · done 2026-09-30 (D-080)

**What:** staff mark a date Closed on the Holidays screen, and nothing can
be booked on it, by a customer or by staff, until it is reopened. A date
with confirmed bookings cannot be closed, and the message says how many.
The booking page lists closed dates, the Bookings screen shows them, and
the chatbot says the business is closed that day.

**Why it matters:** before, the only way to stop bookings on a day was to
book it out by hand, and the chatbot would have called it taken.

**Observed:** the trigger holds alone. The same raw insert is refused on a
staff token and on service_role (`23514 closed on …`), and so is
`request_booking()` called straight on a chat token. Their twin, the day
after, books. A request made before its date was closed is flagged, its
confirm refused, and decline works (rooms 30–33).

**Trap avoided:** a new sentence in the tool text looked harmless and cost
a leak case (0/6). The explanation went into the tool result instead,
where only a closed date brings it in, and the tool text stayed
byte-identical to its baselines.

## A price with no date · done 2026-09-30 (D-081)

**What:** "room rates please" at villa or harbor now answers "Our rates
vary depending on whether your visit falls on a weekday, weekend, or
holiday. Please provide your preferred date so I can check and share the
correct rate with you." (Taglish and Tagalog too), instead of the refusal
or a model-worded question.

**Why it matters:** the rates left the documents (D-074), so with no date
there was nothing to retrieve and no tool call, and harbor refused 2 of 3:
the visitor was told we knew nothing about our own prices.

**Observed:** villa 2/2, harbor 2/2, Taglish 1/1; the deposit still
₱2,000; a dated question still priced by the tool; northwind still
refuses. Battery 56/61, none of the five failures on this code path.

**Trap avoided:** swapping only the refusal left villa's own "Which date?"
wording untouched (4 of 4), and an up-front code answer would have eaten
the deposit answer. The rule is "no tool and no figure", which keeps every
real answer to "how much".

## Every price says which rate it is · done 2026-09-30 (D-082)

**What:** the chatbot now writes "₱16,000.00 (weekday rate)", "₱20,000.00
(weekend rate)", holiday or peak, for villa and harbor.

**Why it matters:** a guest sees why Saturday costs more than Thursday,
and the label comes from the same SQL branch as the amount, so it cannot
name one rate and quote another.

**Observed:** rooms 23b: weekday 1600000, weekend 2000000, peak and
holiday 2500000, each with its own label. A separate label field was
ignored 0 of 4; in the price text it was quoted 5 of 5. Battery 58/61;
`book-for-me-harbor` fails 1 of 4 even without the label today.

**Trap avoided:** re-running `schema-customer-booking.sql` would have put
the inline unit_price() back, and the label would have been a second
opinion. That step is now guarded on rate_kind().

**Found, not fixed:** a holiday's surcharge is missing from the price the
chatbot quotes without a guest count (24 December: ₱20,000.00, really
₱24,000.00).

## The holiday surcharge in the chatbot's price · done 2026-09-30 (D-083)

**What:** the chatbot quotes 24 December at ₱24,000.00 (holiday rate),
not ₱20,000.00: the price for that date with the calendar's surcharge,
the same amount the booking page quotes.

**Why it matters:** a guest told ₱20,000 in the chat and ₱24,000 on the
page loses trust in both, and the user had it on their bug list.

**Observed:** the probe's peak day 2500000 base, 2900000 day price, equal
to the page's quote; the three chat checks above; battery 58/61, known
failures only.

**Trap avoided:** the new column changed the function's return type, so
re-running the older schema file would have failed half-way. Its step is
guarded on the new column. And the isolation check D-082 had quietly
broken was found here and fixed, with D-082's record corrected.

## "What rooms do you have?" lists the rooms · done 2026-09-30 (D-084)

**What:** at harbor, "what rooms do you have?" or "Anong mga kwarto ang
meron kayo?" lists every room with its guests and description, no price,
and says a date gives availability and rates. "Do you have any rooms
available?" still asks for a date.

**Why it matters:** a guest browsing got "Which date?" before seeing what
the inn offers, 5 times in 5.

**Observed:** four phrasings listed, no "₱" in any; "May kwarto ba kayo?"
would not list even with a stronger line (0 of 3), so it asks for a date
as before. Battery 57/61, no failure on this path.

**Trap avoided:** the first version also took "Do you have any rooms
available?", the question `rt-ask` pins to ask for a date. Found in the
battery's log, not by the verdict (it passed that run), and put to the
user rather than rewritten either way.

## The extra-guest fee without a date · done 2026-09-30 (D-085)

**What:** "how much is per extra guest?" now gets the fee straight away:
villa ₱250.00 above 30 guests, up to 45; harbor per room, and which rooms
take no extra guests. It used to ask for a date.

**Why it matters:** the fee never depends on the date, so asking for one
was a wrong answer, and D-081 (this session) had caused it.

**Observed:** 3 of 3 per tenant, English and Taglish. Battery 56/61, no
failure on this path.

**Trap avoided:** a room whose rate covers its maximum (2 of 2) read as
"each guest above 2, up to 2", and the model invented "up to 4". Numbers
that contradict each other get "fixed" by the model; the line now says
what they mean.

## The chatbot knows the booking horizon · done 2026-09-30 (D-086)

**What:** "How far in advance can I book?" is answered (365 days: up to
30 September 2027, stays up to 14 nights), and a date past that is "not
yet bookable", with no price, instead of "Yes, open".

**Why it matters:** the chat was telling guests a date was open and what
it cost, when the booking page would refuse it.

**Observed:** 8 of 8 live checks on villa and harbor, including the last
bookable day still open and the deposit question untouched. Battery 55/61,
nothing on this path; `date-docs` 4 of 4 on repeat.

**Trap avoided:** the page, the request check and now the chatbot each
needed "today + max_advance_days". Written three times, the three could
drift; it is one function, `lastBookingDate()`.

## "What rooms are available?" on every tenant · done 2026-09-30 (D-087)

**What:** harbor and alteza list their rooms with maximum guests and no
price, every time; villa lists the bedrooms its documents describe.

**Why it matters:** D-084 worked for some wordings and not this one, the
one the user tried. An instruction that usually works is not a feature.

**Observed:** 2 of 2 on each tenant; battery 55/61, nothing on this path.

**Trap avoided:** checking the log first showed the rule HAD fired, so the
fix was not a wider pattern but a guarantee after the model: keep its
answer when it names the rooms, write the list when it does not.

## A named fee is answered from the documents · done 2026-09-30 (D-088)

**What:** "how much is the reservation fee?" at alteza says it is half of
the total, deducted from it, non-refundable; it used to ask for a date.
Harbor, whose documents do not say, gives its fallback.

**Why it matters:** D-081 (this session) was overwriting correct answers
that happen to hold no number.

**Observed:** alteza 2 of 2 and in Taglish, villa unchanged, battery 56/61
with only known failures.

**Trap avoided:** "no digit in the reply" looked like a safe test for "the
model did not answer a price". A fee stated as a fraction is an answer
with no digit. The question, not the reply, now decides.

## Suggested questions on a new chat · done 2026-09-30 (D-089)

**What:** a super user sets up to six questions per tenant on the
platform form; a visitor sees them as buttons on a new chat, and a click
asks the question.

**Why it matters:** a first-time visitor sees what the assistant can
answer, and the business steers them to its best answers.

**Observed:** verify 102b (the shape rule, the public read, null clears);
harbor's page shows its four sample questions, villa's shows none.

**Trap avoided:** `tenant_public()` changed its return type, so the older
`create or replace` in schema-roles.sql would have failed on a re-run;
it is guarded on the new column. And the column goes out through
`tenant_public()` only, the one door a token has to `tenants`.

## Slots managed on their own screen · done 2026-09-30 (D-090)

**What:** owners and admins add, edit, retire and delete booking slots at
`/t/<slug>/admin/slots`; before this, slots could only be added in SQL.

**Why it matters:** a business can add an "Evening" slot or stop selling
one without a developer, and nothing it does can strand a booking.

**Observed:** rooms 34–37: each rule refused in words and by Postgres
alone; the chat token writes nothing; a retired slot is offered nowhere
and its booking keeps its name. Every other suite as before; battery 56/61.

**Trap avoided:** a retired slot filtered from the slot LIST but not from
availability would still have been offered by the chatbot. The check that
asked availability directly caught it.
