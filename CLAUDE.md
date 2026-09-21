# CLAUDE.md — RAG Chatbot

> **You are working in a finished, working project.** Read this file, then
> [`flow.md`](./flow.md) for what the pipeline actually does, and
> [`decisions.md`](./decisions.md) for why. `notes.md` is the measured
> behaviour of every knob. Everything you need is in this repo.
>
> This file replaces the original build brief, which described a single Express
> server and forbade both TypeScript and frameworks. That brief did its job and
> is in git history (`BUILD.md`, removed 2026-09-22). The migration that
> replaced it is `plan/steps.md`.

## What this is

A **retrieval-augmented chatbot** that answers questions from documents you
paste in. Hybrid retrieval (vector + full-text, fused with RRF), a grounding
prompt that refuses rather than invents, and a sources panel that shows the
exact chunks every answer was built from.

```
paste document → chunk → embed → store in pgvector
ask question   → rewrite → embed → vector + keyword search → fuse → prompt → stream
```

## The thing to understand before changing anything

**This project was built to be understood, and that is still a functional
requirement.** Every number in it was measured, not chosen, and the measurements
are in `notes.md`.

- **No library does a pipeline step.** No LangChain, no LlamaIndex, no `openai`
  SDK. Chunking, both HTTP calls, retrieval and prompt assembly are hand-written
  (D-001, D-002). That has not changed and should not.
- **Comment the *why*, especially at the non-obvious steps** — why overlap
  exists, why distance sorts ascending, why the same embedding model must be
  used on both sides.
- **If someone asks "why does this work?", the answer must be in the code, not
  in a dependency.**

## Layout

```
apps/web/              Next.js 15, App Router — both screens and all six routes
  app/page.tsx           S-1 chat
  app/admin/page.tsx     S-2 knowledge base
  app/api/**/route.ts    the six endpoints; chat/ does JSON and SSE
  lib/route.ts           withRoute(): validation + the ONE error→status map
  lib/env.ts             fail-fast config (D-023)
  lib/limits.ts          MAX_CONTENT_LENGTH — importable by the browser
packages/
  chunker/             @rag/chunker — pure, isomorphic, ZERO dependencies
  openai/              @rag/openai — embed, chat, chatStream over raw fetch
  db/                  @rag/db — the client, the types, sql/, and server-only
  rag/                 @rag/pipeline — ingest, retrieve, prompt, answer
  tsconfig/            shared base config
fixtures/northwind.json  the corpus the eval battery asserts against
sample-documents/        a second corpus, for testing by hand
plan/                    the migration plan and its evidence
```

## Commands

```sh
pnpm dev                        # http://localhost:3000
pnpm build · typecheck · test
pnpm --filter @rag/db verify    # 10 checks, no API key needed
pnpm eval                       # the prompt battery  ⚠ see below
pnpm scores                     # real similarity scores, threshold off
```

## The rules you will be tempted to break

1. **Re-run `pnpm eval` after ANY edit to `buildPrompt()`.** Phase 5.5 measured
   that this prompt, not the similarity threshold, is what stops the model
   inventing answers. A change that makes the bot more helpful can quietly make
   it answer from training data instead. The battery checks both directions at
   once: real questions answered, absent facts still refused.
   **It needs `fixtures/northwind.json` loaded and nothing else** — a second
   corpus changes the verdicts (the Villa documents describe parking, which the
   `absent-2` case exists to have refused).
2. **The service-role key never reaches the browser.** `@rag/db` imports
   `server-only`, so a Client Component importing it is a build error. Before
   shipping: `grep -ri "service_role" apps/web/.next/static/` must return
   nothing.
3. **Every Route Handler is wrapped in `withRoute()`.** Nothing enforces it. An
   unwrapped handler answers with a generic 500 instead of the real reason.
4. **Any Node script that touches `@rag/db` needs `--conditions=react-server`.**
   That is the cost of rule 2. `pnpm eval` and `pnpm scores` carry it already.
5. **`@rag/chunker` has no dependencies and no I/O.** That is what lets the same
   code run in Node and the browser, and what keeps the file readable alone.

## Traps that will actually cost you time

All are expanded in `risks.md`.

1. **The same embedding model on both sides.** Question and documents must use
   the identical model. Mismatched models produce plausible similarity scores
   that are meaningless, and *nothing errors*. The #1 silent RAG bug (D-004).
2. **Sort by distance ascending, not similarity descending.** `order by
   embedding <=> query_embedding` is what lets Postgres use the HNSW index.
   Reversed, results are still correct and the index silently goes unused.
3. **`vector(1536)` is coupled to the model.** Changing the embedding model
   means a schema change *and* re-embedding every chunk.
4. **A `vector` column comes back from PostgREST as a string.** It is a real
   vector; that is only the JSON serialisation. `parseStoredVector()` is the one
   correct way to read one back. Typing it `number[]` is a lie the compiler
   accepts.
5. **Clean up after a failed ingest.** If embedding fails after the `documents`
   row is inserted, delete that row in the `catch`, or you get a document with
   zero chunks that can never be retrieved (R-7).
6. **Short-circuit the empty retrieval.** When nothing clears the threshold,
   return the refusal string directly — do not call OpenAI (D-008).
7. **Changing the chunker does not re-chunk stored documents.** Delete and
   re-add them, or they keep their old boundaries.

## Conventions

- ES modules, `async`/`await`, named exports, one responsibility per module.
- Tunable constants in `packages/rag/src/constants.ts`, SCREAMING_SNAKE_CASE.
- Validate at the route boundary, throw in the pipeline, map errors to status
  codes in exactly one place (`apps/web/lib/route.ts`).
- Errors surface the real message. No swallowing, no generic "something went
  wrong", no retry loops (`architecture.md` § 9).
- Frontend: never `dangerouslySetInnerHTML` for anything from the server or the
  model. React escapes children, which is what makes this free — adding
  markdown rendering is what would take it away.
- `console.log` in the pipeline is deliberate: `[ingest]`, `[retrieve]`,
  `[query]` and `[openai]` are how you see chunks, scores and cost. Leave them.

## Keeping the record

When any meaningful step finishes, update **both** files in the same turn:

| File | Answers | What to add |
|---|---|---|
| `status.md` | *What do I do next?* | Tick it, rewrite "▶ Next up", append to the session log |
| `whats-done.md` | *What did I just do, and why did it matter?* | What was done, why, what each observed value proves, what trap it avoided |

- **Record real observed values** — token counts, similarity scores, versions,
  error text. Never predicted ones.
- **Record deviations with their reasoning.** If a step contradicts a logged
  decision, amend `decisions.md` too. D-014's reversal is the worked example.
- **Verify the effect, not the exit code.** "The command succeeded" is not "the
  effect happened".
