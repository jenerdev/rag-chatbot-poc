# MVP & Roadmap — RAG Chatbot POC

## What the MVP is

**A chatbot that answers questions from documents you paste in, running on
`localhost:3000`, with every step of the pipeline written by hand and visible.**

One Express server. Two static HTML pages. Seven routes. Four database tables.
Three npm dependencies. No build step.

## The success criterion (the only one that matters)

> Paste in a document containing a fact the model cannot possibly know — an
> internal policy, a made-up product spec, your own notes. Ask about it. Get the
> correct answer **plus the chunk it came from**. Then delete the document and
> ask the same question — the bot must say it doesn't know.

That round trip proves all four hard parts at once: ingestion worked, embeddings
are in the same space, retrieval found the right chunk, and the prompt grounded
the answer instead of letting the model improvise.

**Secondary criterion, equally real for this project:** you can open any file in
the repo and explain what every line does and why it is there. This is a
learning project — code you cannot explain is a failed deliverable even if it
runs.

---

## MVP feature list

Each of these is required. Nothing here is optional.

| # | Feature | Done when |
|---|---|---|
| **F-1** | Add a document by pasting title + text | A row appears in `documents` and N rows in `chunks`, each with a non-null embedding |
| **F-2** | Automatic chunking with overlap | A 5,000-character document produces multiple chunks, and text at a boundary appears in two of them |
| **F-3** | Batched embedding via OpenAI | One `/v1/embeddings` call per document, not one per chunk |
| **F-4** | List documents with chunk counts | Admin page shows every document and how many chunks it became |
| **F-5** | Delete a document | Document and all its chunks disappear (cascade), and it stops appearing in answers |
| **F-6** | Vector similarity search | `match_chunks` returns chunks ordered most-similar-first with a similarity score |
| **F-7** | Grounded chat answer | Answer uses retrieved context; says "I don't know" when nothing is retrieved |
| **F-8** | Sources shown in the UI | Every answer displays the chunks used, with their similarity scores |
| **F-9** | Conversation memory within a session | A follow-up like "what about the second one?" resolves against earlier turns |
| **F-10** | Readable errors | Missing key, no credits, empty input each produce a specific message |

---

## Explicitly OUT of the MVP

This list exists to protect the project. The failure mode for a learning POC is
not "it doesn't work" — it is quietly turning into a product and never finishing.

**Not building:**

- **User accounts / login / auth of any kind.** Single user, localhost only.
- **Deployment or hosting.** No Vercel, no Render, no Docker, no domain.
- **File upload** (PDF, DOCX, Markdown, CSV). Paste text only. PDF parsing is an
  entire unrelated problem and teaches nothing about RAG.
- **Web scraping / URL ingestion.**
- **Streaming responses** (SSE / token-by-token). A spinner is fine. Streaming
  would complicate the one route you most want to read clearly.
- **Semantic / recursive / token-aware chunking.** Fixed-size with overlap only.
- **Re-ranking, hybrid search, query rewriting, HyDE, multi-query.** These are
  the *next* things to learn, and they only make sense once the naive version is
  understood and its limits felt. See post-MVP.
- **Multiple knowledge bases / collections / tenancy.**
- **Editing a document in place.** Delete and re-add.
- **Persisting conversations across browser restarts.** They are in the database;
  the UI just does not list old ones.
- **Rate limiting, caching, retries, queues, background jobs.**
- **Automated tests.** Manual verification against the checklist below.
- **Markdown rendering in the chat bubble.** Plain text via `textContent`.
- **Mobile-optimised design.** Should not be broken on a phone, but is not a goal.

**The rule:** if a feature does not teach you something about retrieval-augmented
generation, it is not in the MVP.

---

## Roadmap

### Phase 0 — Setup (no code)

External accounts and keys first, because both have a step that can stall you.

| Step | Detail |
|---|---|
| 0.1 | Create an OpenAI **platform** account at <https://platform.openai.com> and **add prepaid credits** (minimum top-up is typically $5). This is *not* a ChatGPT Plus subscription — a Plus subscription grants no API access at all. |
| 0.2 | Create an API key. Copy it once; it is never shown again. |
| 0.3 | Create a free Supabase project. Note the region and **save the database password.** |
| 0.4 | Supabase → Project Settings → API → copy `URL` and the **`service_role`** key. |
| 0.5 | SQL Editor → run `schema.sql` (all of `architecture.md` § 4, including the `match_chunks` function). |
| 0.6 | Verify: `select * from pg_extension where extname = 'vector';` returns one row. |
| 0.7 | `npm init -y`, set `"type": "module"`, install the three dependencies, create `.env` and `.gitignore`. |

**Phase 0 is done when:** `node -e "console.log(typeof fetch)"` prints `function`,
and a one-off script can insert and read back a row in `documents`.

### Phase 1 — Prove the two API calls in isolation

Before any Express, before any UI. Two throwaway scripts.

| Step | Detail |
|---|---|
| 1.1 | `scratch/embed-test.js` — embed the string "hello world", print `vector.length`. **Expect exactly 1536.** |
| 1.2 | Store that vector in a `chunks` row by hand. Confirm it round-trips: read it back and check the length is still 1536, not a string. |
| 1.3 | `scratch/chat-test.js` — one `/v1/chat/completions` call, print the reply. |

**Done when:** you have seen a real embedding array and a real completion, and
you know what both request bodies look like. Delete the scratch files afterwards
(or keep them — they are useful for debugging later).

> This phase exists because when the full pipeline misbehaves, you want to
> already know that the two external calls work.

### Phase 2 — Ingest pipeline

| Step | Detail |
|---|---|
| 2.1 | `src/chunker.js` — pure `chunkText(text, size, overlap)`. Test it on a string with `console.log` until the overlap is visibly correct. |
| 2.2 | `src/openai.js` — `embed(texts[])` returning `number[][]`, batched in one call. |
| 2.3 | `src/supabase.js` — the client. |
| 2.4 | `src/rag.js` → `ingestDocument({ title, source, content })`. |
| 2.5 | `server.js` — Express, `POST /api/documents`, `GET /api/documents`, `DELETE /api/documents/:id`. |
| 2.6 | Test with `curl` or the Supabase table viewer — no UI yet. |

**Done when:** `curl -X POST localhost:3000/api/documents` with a real document
produces chunk rows with populated embeddings, and DELETE removes them all.

### Phase 3 — Query pipeline

| Step | Detail |
|---|---|
| 3.1 | Call `match_chunks` from Node via `.rpc()`. Log the chunks and their similarity scores for a test question. **Read the scores** — get a feel for what a good match scores versus a bad one. |
| 3.2 | Tune `min_similarity` based on what you just saw. The 0.3 default is a starting guess, not a law. |
| 3.3 | `buildPrompt(chunks, history, question)` — exactly as in `architecture.md` § 6. |
| 3.4 | `answerQuestion()` wiring it together; `POST /api/chat`. |
| 3.5 | Save user and assistant messages; create the conversation on first message. |
| 3.6 | The no-results short circuit: return "I don't know" **without** calling OpenAI. |

**Done when:** `curl -X POST localhost:3000/api/chat` returns a grounded answer
plus its sources, and an off-topic question returns the refusal.

### Phase 4 — The UI

| Step | Detail |
|---|---|
| 4.1 | `public/admin.html` + `admin.js` — add form, document list, delete buttons. |
| 4.2 | `public/index.html` + `app.js` — message list, input, send. |
| 4.3 | Sources panel under each answer: chunk text (truncated) + similarity, expandable. |
| 4.4 | `conversationId` held in a JS variable, sent with each message. |
| 4.5 | Loading and error states (see `screens.md`). |
| 4.6 | `style.css` — readable, plain, hand-written. |

**Done when:** the full success criterion at the top of this file passes entirely
through the browser, with no `curl`.

### Phase 5 — Understand it (the actual deliverable)

**Do not skip this phase. It is the reason the project exists.**

| Step | Detail |
|---|---|
| 5.1 | Change chunk size to 300, re-ingest, ask the same questions. Note what got worse and why. |
| 5.2 | Change it to 4000. Note what got worse *differently*. |
| 5.3 | Set `min_similarity` to 0 and ask a totally unrelated question. Watch it retrieve nonsense with a straight face — this is why the threshold exists. |
| 5.4 | Set `match_count` to 1, then 20. Observe the cost and quality tradeoff. |
| 5.5 | Remove the "use ONLY the context" line from the system prompt. Ask something not in your documents. Watch it answer anyway. Put the line back. |
| 5.6 | Check OpenAI usage — see what the whole build actually cost. Compare with `costs.md`. |
| 5.7 | Write your findings into `notes.md` in the repo. |

**Done when:** you can explain, without looking, why the question and the
documents must use the same embedding model, and what happens if they do not.

---

## Post-MVP (only after Phase 5)

Roughly in order of how much each teaches per hour spent:

1. **Streaming responses** — SSE from Express, incremental render. Big perceived
   quality jump, moderate effort.
2. **Hybrid search** — add Postgres full-text search alongside vectors and merge
   the two result lists. Directly shows what vectors are bad at (exact names,
   IDs, acronyms).
3. **Re-ranking** — retrieve 20, use a cheap model call to pick the best 5.
4. **File upload** — start with `.md` and `.txt`; PDF is its own rabbit hole.
5. **Inline citations** — make the model emit `[1]`, `[2]` and link them to sources.
6. **Chunk-boundary improvement** — split on paragraphs/headings first, then size.
7. **Auth + multi-user** — the point at which this stops being a POC. If you get
   here, see `../shared-auth-layer` in the ideas folder rather than rolling it.
8. **Deployment** — and at that moment `risks.md` § R-2 (RLS) stops being a note
   and becomes a blocker.

---

## Time estimate

| Phase | Estimate |
|---|---|
| 0 — Setup | 45 min (mostly account and billing screens) |
| 1 — API calls | 30 min |
| 2 — Ingest | 2 h |
| 3 — Query | 2 h |
| 4 — UI | 2–3 h |
| 5 — Experiments | 1–2 h |
| **Total** | **~8–10 hours**, comfortably a long weekend or three evenings |
