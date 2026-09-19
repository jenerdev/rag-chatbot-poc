# BUILD — RAG Chatbot POC

> **You are the Claude in the new repo.** This is your brief. Read this file
> first, then [`architecture.md`](./architecture.md) for the design,
> [`mvp.md`](./mvp.md) for scope and build order, [`screens.md`](./screens.md)
> for the UI, and [`decisions.md`](./decisions.md) for why things are the way
> they are. Everything you need is in this folder — do not go looking for
> external context.

## What you are building

A **retrieval-augmented chatbot** that answers questions from documents the user
pastes in. One Node/Express server, two static HTML pages, Supabase Postgres
with `pgvector` for storage and search, OpenAI for embeddings and chat.

```
paste document → chunk → embed → store in pgvector
ask question   → embed → vector search → paste chunks into prompt → answer
```

Runs on `http://localhost:3000`. Roughly 500–700 lines total.

## The thing you must understand before you write anything

**This is a learning project, and that is a functional requirement, not
flavour text.** The user's stated goal is *"I want to fully understand how it
works."*

Concretely, this changes how you should build:

- **Do not reach for a library that does a pipeline step.** No LangChain, no
  LlamaIndex, no `openai` SDK, no Supabase AI helpers. Chunking, the two HTTP
  calls, retrieval and prompt assembly are all hand-written. See D-001, D-002.
- **Favour explicit, linear, readable code over clever code.** `rag.js` should
  read top-to-bottom like the flowcharts in `architecture.md` § 3.
- **Comment the *why*, especially at the non-obvious steps** — why overlap
  exists, why distance is sorted ascending, why the same embedding model must be
  used on both sides.
- **If the user asks "why does this work?", the answer must be in the code, not
  in a dependency.**

A version of this that works but cannot be explained has failed.

## The rules you will be tempted to break

1. **No framework creep.** If you find yourself adding a fourth npm dependency,
   stop and ask what pipeline step it is taking over.
2. **No calling OpenAI from the browser.** Ever. The key stays server-side.
   This is the single security rule the POC enforces (`risks.md` § R-1).
3. **No building anything on the Out-of-scope list** in `mvp.md`. It is long and
   specific on purpose. Auth, streaming, PDF upload and deployment are all on it.
4. **Do not skip Phase 5.** It is not polish; it is the deliverable.

## Stack (settled — do not re-litigate)

- **Node.js 20+**, plain **JavaScript**, ES modules (`"type": "module"`). No
  TypeScript (D-014), no build step, no bundler.
- **Express 4** (not 5 — D-009).
- **Native `fetch`** for OpenAI. No SDK (D-002).
- **`@supabase/supabase-js` v2** for the database.
- **`dotenv`** for config.
- **Supabase Postgres + `pgvector`**, `vector(1536)` column (D-003, D-004).
- **OpenAI `text-embedding-3-small`** for embeddings, **`gpt-4o-mini`** for chat,
  both via env vars (D-004, D-005).
- **Native HTML/CSS/JS** in the browser. No framework, no npm packages, no build.

**Total dependencies: three.**

> Before Phase 0, check the current OpenAI model list and pricing at
> <https://platform.openai.com/docs/models>. These docs were written 2026-09-20
> (D-005, R-8). The chat model is trivially swappable; the embedding model is
> not, so confirm that one first.

## Repo layout to create

```
repo-root/
├── .env                  # gitignored — create from .env.example
├── .env.example          # committed, empty values
├── .gitignore            # node_modules, .env, scratch/
├── package.json          # "type": "module", 3 deps
├── schema.sql            # architecture.md § 4, verbatim and runnable
├── server.js             # Express app: routes + static + error mapping
├── src/
│   ├── openai.js         # embed(texts) + chat(messages) — raw fetch
│   ├── supabase.js       # the configured client
│   ├── chunker.js        # chunkText() — pure, no I/O, no imports
│   └── rag.js            # ingestDocument() + answerQuestion()
├── public/
│   ├── index.html        # S-1 chat
│   ├── admin.html        # S-2 knowledge base
│   ├── app.js
│   ├── admin.js
│   └── style.css
├── notes.md              # Phase 5 findings — the user writes this
└── README.md             # setup steps + how to run
```

Module responsibilities and what each file must *not* contain are in
`architecture.md` § 7. Respect the split — `chunker.js` being pure and
dependency-free is what makes it readable in isolation.

## Order of work

Build in this order. Each phase ends working before the next starts. Full detail
per step is in `mvp.md` § Roadmap.

| Phase | Deliverable | Done when |
|---|---|---|
| **0 — Setup** | OpenAI credits + key, Supabase project, `schema.sql` run, npm init | `select * from pg_extension where extname='vector'` returns a row |
| **1 — Prove the API calls** | Two throwaway scripts in `scratch/` | An embedding prints length **1536**, and a vector round-trips through Supabase as numbers, not a string |
| **2 — Ingest** | `chunker.js`, `openai.js`, `supabase.js`, `rag.ingestDocument`, document routes | `curl -X POST /api/documents` creates chunks with populated embeddings; DELETE cascades |
| **3 — Query** | `match_chunks` via `.rpc()`, prompt assembly, `POST /api/chat` | A grounded answer + sources via curl; an off-topic question returns the refusal **without** calling OpenAI |
| **4 — UI** | Both pages, sources panel, all states from `screens.md` | The success criterion passes entirely in the browser |
| **5 — Experiments** | Chunk size, threshold, prompt ablation; write `notes.md` | The user can explain the pipeline unprompted |

**Do not build ahead.** Phase 1 exists specifically so that when the full
pipeline misbehaves, the two external calls are already known-good.

## Definition of done

From `mvp.md`, the one criterion that matters:

> Paste in a document containing a fact the model cannot know. Ask about it. Get
> the right answer **plus the source chunk**. Delete the document, ask again —
> it must say it doesn't know.

Plus: the user can open any file and explain every line.

## Traps specific to this build

These are the ones that will actually cost you time. All are expanded in
`risks.md`.

1. **Same embedding model on both sides.** Question and documents must use the
   identical model. Mismatched models produce plausible similarity scores that
   are meaningless, and *nothing errors*. The #1 silent RAG bug (D-004, R-3).
2. **Sort by distance ascending, not similarity descending.** `order by
   embedding <=> query_embedding` is what lets Postgres use the HNSW index.
   Reversed, results are still correct and the index silently goes unused.
3. **`vector(1536)` is coupled to the model.** Changing the embedding model
   means a schema change *and* re-embedding every chunk. Old vectors are not
   convertible.
4. **Use HNSW, not ivfflat.** HNSW builds on an empty table; ivfflat needs rows
   to train on first.
5. **Check the embedding round-trips as numbers.** A vector accidentally stored
   as text makes search behave strangely with no clear error. Phase 1.2 exists
   for this.
6. **Clean up after a failed ingest.** If embedding fails after the `documents`
   row is inserted, delete that row in the `catch`. Otherwise you get a document
   with zero chunks that can never be retrieved (R-7).
7. **Short-circuit the empty retrieval.** When nothing clears the similarity
   threshold, return the "I don't know" string directly — do not call OpenAI
   (D-008).
8. **Cap the conversation history at ~6 messages.** The whole history is re-sent
   and re-billed every turn (D-011).

## Tools that must not be deleted

`scratch/` is gitignored; these two live in `tools/` **because they are needed
again later**, not just during the build:

| Command | File | What it is for |
|---|---|---|
| `npm run scores` | `tools/score-probe.js` | Prints real similarity scores with the threshold off. How `MIN_SIMILARITY` gets set from evidence rather than guessed. |
| `npm run eval` | `tools/prompt-eval.js` | A six-case battery checking that real questions are answered **and** absent facts are still refused. |

**Re-run `npm run eval` after any edit to `buildPrompt()`.** That prompt is the
only thing separating a grounded answer from a confident invention (Phase 5.5
measured exactly that), and a change that makes the bot more helpful can quietly
make it answer from training data instead.

**Before any production use**, both commands must be re-run against the real
corpus, and `npm run eval` is also how the chat model gets chosen. The full list
is in `README.md` § "Before you put this in production".

## Keeping the record (do this every step, not at the end)

When **any** step from `mvp.md` § Roadmap finishes, update **both** files in the
same turn before moving on. This is not bookkeeping — `whats-done.md` is the
"I fully understand how it works" deliverable accumulating as you go.

| File | Answers | What to add |
|---|---|---|
| `status.md` | *What do I do next?* | Tick the checkbox, bump progress %, rewrite "▶ Next up", append to the session log |
| `whats-done.md` | *What did I just do, and why did it matter?* | A section for the step: what was done, why, what each observed value proves, what trap it avoided |

Rules:

- **Record real observed values** — token counts, similarity scores, versions,
  error text. Never predicted ones.
- **Record deviations with their reasoning.** If a step contradicts a logged
  decision, amend `decisions.md` (and `risks.md` if relevant) too. The RLS
  amendment to D-006 is the worked example.
- **Verify the effect, not the exit code.** "The command succeeded" is not
  "the effect happened" — that lesson cost a round trip in Phase 0.5.

## Conventions

- ES modules, `async`/`await`, no callbacks.
- Named exports; one clear responsibility per module.
- Constants (`CHUNK_SIZE`, `CHUNK_OVERLAP`, `MATCH_COUNT`, `MIN_SIMILARITY`,
  `MAX_HISTORY`) at the top of their module in `SCREAMING_SNAKE_CASE`, so the
  tunable knobs are all findable. Phase 5 depends on this.
- Validate at the route boundary, throw in the pipeline, map errors to status
  codes in one place in `server.js`.
- Errors surface the real message. No swallowing, no generic "something went
  wrong", no retry loops (`architecture.md` § 9).
- Frontend: `textContent`, never `innerHTML`, for anything from the server or
  the model. No markdown rendering in the MVP.
- No `console.log` left in the committed frontend; `console.log` in the server
  pipeline during Phases 2–3 is expected and useful — it is how you see the
  chunks and scores.

## First thing to do in the new repo

1. Read `architecture.md` end to end. It is the design; this file is only the brief.
2. Walk the user through Phase 0 — **the OpenAI billing step is the one that
   blocks everything**, and it is the step most likely to confuse (a ChatGPT
   subscription does not grant API access; see `costs.md`).
3. Write `schema.sql` from `architecture.md` § 4 and have them run it.
4. Then Phase 1. Do not start Phase 2 until an embedding has printed `1536`.
