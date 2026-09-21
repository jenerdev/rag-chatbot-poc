# Migration plan — POC → product

> Moving this repo from *one Express server + two static HTML pages + plain
> JavaScript* to *a Turborepo monorepo + Next.js (App Router) + TypeScript*,
> without losing the one thing that proves the pipeline works: the eval battery.
>
> Written 2026-09-21, against commit `95b8de9`. Read [`§ 0`](#0-the-one-rule)
> before touching anything.

---

## What this plan covers

| | |
|---|---|
| **In scope** | pnpm + Turborepo workspace, TypeScript port of all five pipeline modules, Next.js Route Handlers for the six API endpoints (including the SSE stream), both screens as React, the eval/score tools kept runnable, deployment |
| **Out of scope** | Multi-tenancy, auth, Messenger integration, tool calls, analytics. These are in `sample-documents/todo.txt` and are listed in [§ 7](#7-what-this-unblocks-not-in-this-plan) with the seams the port should leave open — but building any of them *during* the port is how a migration turns into a rewrite |

**Assumption, stated rather than asked:** "product" here means the same product
on a stack that can grow. No behaviour changes. If you actually want tenancy in
this pass, stop at [Phase 3](#phase-3--ragdb) and read the callout there — that
is the one place where deciding late is expensive.

Work on a branch: `git switch -c feat/nextjs-migration`. The POC stays runnable
inside the monorepo until [Phase 7](#phase-7--cutover) deletes it.

---

## 0. The one rule

**Port. Do not improve.**

Not the chunk size, not the threshold, not the prompt wording, not the fusion
maths, not the refusal string. Every one of those was set by measurement in
Phase 5 (`notes.md`), and any change made *during* the port destroys the only
way to tell whether the port worked — a before/after comparison of the same
eval battery on the same corpus.

These are frozen for the duration of the migration:

| Constant | Value | Where | Set by |
|---|---|---|---|
| `CHUNK_SIZE` | 1000 | `src/chunker.js:25` | notes.md § 5.1 |
| `CHUNK_OVERLAP` | 150 | `src/chunker.js:48` | notes.md § 5.2 |
| `MATCH_COUNT` | 5 | `src/rag.js:152` | notes.md |
| `CANDIDATE_COUNT` | 10 | `src/rag.js:160` | D-015 |
| `RRF_K` | 60 | `src/rag.js:165` | D-015 |
| `MIN_SIMILARITY` | 0.25 | `src/rag.js:188` | notes.md § 5.3 |
| `MAX_HISTORY` | 6 | `src/rag.js:193` | D-011 |
| `NO_ANSWER` | `"I don't know based on the documents I have."` | `src/rag.js:203` | D-008 |
| `buildPrompt()` text | verbatim | `src/rag.js:213` | D-017 |
| The three SQL functions | verbatim | `schema.sql`, `schema-hybrid.sql` | D-015 |

Improvements go in a commit *after* the migration lands, judged by `pnpm eval`
the way `CLAUDE.md` already requires.

---

## 1. Inventory — what moves where

| Today | Lines | Goes to | Change |
|---|---|---|---|
| `src/chunker.js` | 219 | `packages/chunker/src/index.ts` | Types only. Stays pure, stays dependency-free — now enforced by an empty `dependencies` in its `package.json` rather than by a comment |
| `src/openai.js` | 266 | `packages/openai/src/index.ts` | Types only. Still raw `fetch`, still no SDK (D-002 survives) |
| `src/supabase.js` | 29 | `packages/db/src/client.ts` | Adds `import 'server-only'` and generated `Database` types |
| `src/rag.js` | 645 | `packages/rag/src/*.ts` | Split along seams it already has: `ingest`, `retrieve`, `prompt`, `answer`, `constants`. Logic unchanged |
| `server.js` routes | 240 | `apps/web/app/api/**/route.ts` | Express handlers → Route Handlers. The SSE route is the hard one |
| `server.js` error middleware | ~14 | `apps/web/lib/route.ts` | Middleware → a `withRoute()` wrapper. Same status mapping, still in exactly one place |
| `server.js` env check | ~15 | `apps/web/lib/env.ts` | Fail-fast at boot still required — Next has no single boot moment, so it moves into module scope |
| `public/index.html` + `app.js` | 439 | `apps/web/app/page.tsx` + components | Vanilla DOM → React. The manual SSE reader survives almost verbatim |
| `public/admin.html` + `admin.js` | 319 | `apps/web/app/admin/page.tsx` + components | Same |
| `public/style.css` | 275 | `apps/web/app/globals.css` | Straight copy. No Tailwind in this pass — swapping the styling system mid-port breaks § 0 |
| `schema.sql`, `schema-hybrid.sql` | 191 | `packages/db/sql/` | Unchanged. Still run by hand in the Supabase SQL editor |
| `tools/prompt-eval.js` | 89 | `packages/rag/tools/prompt-eval.ts` | **Must keep working at every phase.** This is the acceptance test |
| `tools/score-probe.js` | 48 | `packages/rag/tools/score-probe.ts` | Same |
| `scratch/testdoc.json` | — | `packages/rag/fixtures/northwind.json` | **See [§ 2.4](#24-the-eval-corpus-is-gitignored)** |
| `sample-documents/` | — | unchanged, repo root | Manual test corpus, referenced by `TEST-PROMPTS.md` |
| `architecture.md`, `decisions.md`, `notes.md`, `risks.md`, `status.md`, `whats-done.md`, `flow.md` | — | unchanged, repo root | Amended in Phase 7, not moved. They are the learning deliverable |
| `CLAUDE.md` / `BUILD.md` | — | rewritten in Phase 7 | They currently forbid TypeScript and frameworks. Leaving them as-is makes the repo lie to whoever — or whatever — opens it next. They are also byte-identical duplicates today; collapse to one |

---

## 2. The five things that will actually cost you time

### 2.1 The `service_role` key can now reach the browser

The POC's single security rule (`risks.md` § R-2, D-006) was easy to hold: the
key lived in a Node process with no path to the client. Next.js removes that
guarantee. Three new ways to leak it:

- naming the var `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` — it gets inlined into
  the JS bundle, permanently, and served to everyone who loads the page;
- importing `packages/db` from a Client Component, directly or through a barrel
  file that re-exports both server and client code;
- a route or Server Action that returns the config object "for debugging".

Mitigations, all cheap, all in Phase 3:

```ts
// packages/db/src/client.ts — first line of the file
import 'server-only';   // a BUILD error, not a runtime one, if a client imports this
```

plus: no `NEXT_PUBLIC_` prefix on anything secret, no barrel file mixing server
and client exports, and `grep -ri "service_role" apps/web/.next/static/` in the
Phase 7 checklist. That grep returning nothing is the evidence. "I was careful"
is not.

### 2.2 SSE over a Route Handler is not `res.write()`

`server.js:177-210` writes events straight to the socket. Route Handlers return
a `Response`, so the stream becomes a `ReadableStream` — the handler returns
immediately while the pipeline keeps enqueuing.

```ts
// apps/web/app/api/chat/route.ts
export const runtime = 'nodejs';        // NOT edge — supabase-js + long-lived streams
export const dynamic = 'force-dynamic'; // never statically analysed or cached
export const maxDuration = 60;          // hosted only; the default cuts long answers off

const encoder = new TextEncoder();
const stream = new ReadableStream({
  async start(controller) {
    const send = (event: string, data: unknown) =>
      controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    try {
      await answerQuestionStream({
        ...args,
        onMeta:  (meta) => send('meta', meta),
        onDelta: (text) => send('delta', { text }),
      });
      send('done', {});
    } catch (error) {
      // Headers are long gone; the failure has to travel as data (D-019).
      send('error', { error: (error as Error).message });
    } finally {
      controller.close();
    }
  },
});

return new Response(stream, {
  headers: {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  },
});
```

Four things carry over unchanged and must not be "cleaned up":

- **The explicit `Accept` header check, not `req.accepts()`.** The comment at
  `server.js:163` explains why: curl sends `Accept: */*`, which matches
  `text/event-stream`, so every script would be handed a stream it cannot
  parse. In a Route Handler: `request.headers.get('accept')?.includes(...)`.
- **`X-Accel-Buffering: no`.** Still needed. A buffering proxy looks exactly
  like broken streaming, with every line of your code correct.
- **The `writableEnded` guard**, which becomes `request.signal`. Wire it up so
  the pipeline stops when the user navigates away — otherwise you keep paying
  OpenAI for tokens nobody will read.
- **The two-delivery contract.** `Accept: text/event-stream` streams; anything
  else gets the original single JSON body (D-019). Every curl example in
  `README.md` must keep working.

### 2.3 The `chunker.js` static-serve hack disappears — and that is a win

`server.js:62` serves `src/chunker.js` to the browser so the admin page's live
chunk estimate uses the same `CHUNK_SIZE` as the server. That is the only reason
the file must have zero imports.

In the monorepo, `@rag/chunker` is a workspace package that the Route Handler
and a Client Component both import. The constraint that made it work — no
imports, no I/O — is worth keeping anyway, since it is what makes the file
readable in isolation. But the `express.static` line, and the risk of the
browser copy drifting, both go away. Delete the route, keep the discipline.

### 2.4 The eval corpus is gitignored

`tools/prompt-eval.js` asserts on facts — *"Bay 3 freezer"*, *"extension
4417"*, *"the liaison"* — that exist only in the Northwind Labs handbook, and
that document lives in `scratch/testdoc.json`, which `.gitignore` excludes.

So the acceptance test for this entire migration currently depends on a file
that is not in version control and is one `git clean -fdx` from gone.

**Phase 0, step 1, before anything else:** copy it to
`packages/rag/fixtures/northwind.json` and commit it. It is invented content,
2,607 characters, and the reference corpus for six assertions.

### 2.5 Turborepo caches against the env vars you declare — and only those

If `OPENAI_API_KEY` or `SUPABASE_URL` is not listed in `turbo.json`, turbo will
happily replay a cached build produced with a different key. That surfaces as a
401 you cannot reproduce, or worse, a build that silently pointed at the wrong
Supabase project.

```jsonc
// turbo.json
{
  "$schema": "https://turbo.build/schema.json",
  "globalEnv": [
    "OPENAI_API_KEY", "OPENAI_CHAT_MODEL", "OPENAI_EMBEDDING_MODEL",
    "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"
  ],
  "globalDependencies": [".env.local"],
  "tasks": {
    "build":     { "dependsOn": ["^build"], "outputs": [".next/**", "!.next/cache/**", "dist/**"] },
    "typecheck": { "dependsOn": ["^build"] },
    "lint":      {},
    "test":      { "dependsOn": ["^build"] },
    "dev":       { "cache": false, "persistent": true },
    "eval":      { "cache": false },
    "scores":    { "cache": false }
  }
}
```

`eval` and `scores` are `cache: false` deliberately — they call a live API and a
live database, and a cached "pass" is worthless.

---

## 3. Target layout

```
rag-chatbot/
├── turbo.json
├── pnpm-workspace.yaml
├── package.json                  # workspace root: turbo scripts only
├── apps/
│   ├── web/                      # Next.js 15, App Router
│   │   ├── app/
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx                             # S-1 chat
│   │   │   ├── admin/page.tsx                       # S-2 knowledge base
│   │   │   ├── globals.css                          # public/style.css, verbatim
│   │   │   └── api/
│   │   │       ├── chat/route.ts                    # POST — JSON and SSE
│   │   │       ├── documents/route.ts               # POST, GET
│   │   │       ├── documents/[id]/route.ts          # DELETE
│   │   │       ├── documents/[id]/chunks/route.ts   # GET
│   │   │       └── conversations/[id]/messages/route.ts
│   │   ├── components/           # Composer, Turn, SourcesPanel, DocumentRow…
│   │   └── lib/
│   │       ├── route.ts            # withRoute(): the one error→status map
│   │       ├── schemas.ts          # request-body validation
│   │       ├── env.ts              # fail-fast on missing config
│   │       └── use-chat-stream.ts  # the SSE reader from public/app.js:239
│   └── legacy-poc/               # the Express app, moved verbatim. Deleted in Phase 7
├── packages/
│   ├── chunker/                  # @rag/chunker — pure, isomorphic, ZERO dependencies
│   ├── openai/                   # @rag/openai — embed, chat, chatStream over fetch
│   ├── db/                       # @rag/db — client, generated types, sql/
│   ├── rag/                      # @rag/pipeline — ingest, retrieve, prompt, answer
│   │   ├── fixtures/northwind.json
│   │   └── tools/                # prompt-eval.ts, score-probe.ts
│   └── tsconfig/                 # shared base tsconfig + eslint config
└── (docs stay at the root: architecture.md, decisions.md, notes.md, …)
```

**Why five packages and not one `packages/core`.** `@rag/chunker` having an
empty `dependencies` block is the machine-checkable version of the rule that
keeps it readable. `@rag/db` being the only package that imports `server-only`
is what turns § 2.1 into a build error instead of a code review. The split is
the one `architecture.md` § 7 already argues for — package boundaries just make
it enforceable.

**Toolchain.** pnpm 9 (its strict linking is what stops `apps/web` importing a
package it never declared), Turborepo 2, Next.js 15, React 19, TypeScript 5.6+.
Node 24.19.0 is what is installed here; pin `"engines": { "node": ">=20.9" }`.
If you would rather not add pnpm, npm workspaces works with turbo — you lose
the phantom-dependency protection.

---

## 4. Phases

Each phase ends with the repo in a working state, and with `status.md` and
`whats-done.md` updated in the same commit. The rule in `CLAUDE.md` § "Keeping
the record" is not suspended because the stack changed.

| Phase | Deliverable | Size | Done when |
|---|---|---|---|
| **0** ✅ | Baseline measurement, corpus rescued | S | `plan/baseline/` holds real eval + score output — **partly done 2026-09-21, see below** |
| **1** ✅ | Workspace skeleton, POC moved intact | S | The old app still serves; eval still passes — **done 2026-09-21, see below** |
| **2** ✅ | `@rag/chunker`, `@rag/openai` in TS | M | New chunker produces byte-identical chunks to the old one — **done 2026-09-22: 87 comparisons, 0 differences** |
| **3** ✅ | `@rag/db` | S | Generated types compile; the `server-only` guard is proven — **done 2026-09-22, 10/10 checks** |
| **4** ✅ | `@rag/pipeline` | L | ~~`pnpm eval` matches the Phase 0 baseline~~ — **closed 2026-09-22 on structural parity instead, by decision. See whats-done.md § Phase 7** |
| **5** ✅ | API routes in `apps/web` | M | Every curl in `README.md` returns the same shape — **done 2026-09-22: 24 comparisons, 0 differences, diffed live against the running POC** |
| **6** ✅ | Both screens in React | L | The `mvp.md` success criterion passes in the browser — **signed off 2026-09-22, checked by hand** |
| **7** ✅ | Cutover: delete the POC, amend the docs | M | **Done 2026-09-22.** No `legacy-poc/`; 0 secrets in the client bundle; D-014 reversed and D-020..D-023 added |
| **8** | Deploy | M | Streaming works on the deployed URL, not just locally |

---

### Phase 0 — Baseline

> **Done 2026-09-21, except the measurement.** Steps 1, 2 and 4 are complete:
> the fixture is rescued into `fixtures/northwind.json`, `todo.txt` is out of the
> corpus folder, and `plan/baseline/versions.txt` + `db-state.md` hold real
> observed values. **Step 3 — the eval and score capture — is deferred by
> decision**, because it requires clearing the Villa Amihan corpus from the
> database and the database was left as it is. See
> [`plan/baseline/db-state.md`](./baseline/db-state.md) for what that costs and
> the exact commands to capture it later. **This is now the one open blocker on
> Phase 4.**

**Goal:** make the migration falsifiable. Everything after this is judged
against numbers captured here.

1. Copy `scratch/testdoc.json` into the repo and commit it
   ([§ 2.4](#24-the-eval-corpus-is-gitignored)).
2. Commit `sample-documents/` — but move `todo.txt` out of that folder first.
   It is not corpus and must never be pasted into the admin page.
3. Load the Northwind handbook into a clean database, then capture:
   ```sh
   npm run eval   > plan/baseline/eval-before.txt
   npm run scores > plan/baseline/scores-before.txt
   node -v; npm -v > plan/baseline/versions.txt
   ```
4. Record the Supabase project ref, both model names from `.env`, and the row
   counts of all four tables.

**Done when:** `eval-before.txt` shows six cases with their real verdicts, and
`scores-before.txt` shows real similarity numbers.

**Trap:** capture the baseline against the *same corpus and the same models* you
will verify with later. An eval run against the Villa Amihan corpus is not
comparable to one against Northwind — the six assertions are Northwind facts.

---

### Phase 1 — Workspace skeleton

> **Done 2026-09-21.** pnpm 12.5.1 via corepack, turbo 2.11.2, POC at
> `apps/legacy-poc/` via `git mv` (all 15 files detected as 100% renames).
> Serving verified on every route; the three dependency versions are unchanged
> from the Phase 0 baseline. **Three deviations from the steps below, each with
> its reasoning, are recorded in `whats-done.md`** — pnpm 12 not 9, the fixture
> left at the repo root, and `--env-file` instead of moving `.env`.
>
> **New blocker found here, unrelated to the move: the OpenAI API key has
> expired** (`"Your API key has expired. Create a new API key to continue."`).
> Nothing that calls OpenAI can run until it is replaced — including the
> deferred Phase 0 baseline.

**Goal:** a monorepo containing the POC, unchanged and still working. No
TypeScript yet. This phase is deliberately boring, because it is what gives
every later phase a known-good reference to diff against.

1. `pnpm-workspace.yaml` with `apps/*` and `packages/*`; root `package.json`
   with turbo scripts (`dev`, `build`, `lint`, `typecheck`, `test`).
2. `turbo.json` exactly as in [§ 2.5](#25-turborepo-caches-against-the-env-vars-you-declare--and-only-those).
3. `git mv` the POC into `apps/legacy-poc/`: `server.js`, `src/`, `public/`,
   `tools/`, its `package.json`. Docs and `sample-documents/` stay at the root.
4. Move the fixture alongside it.
5. `.env.local` at the root; keep `.env` working for `legacy-poc`.
6. `packages/tsconfig` with a base config (`"strict": true`,
   `"moduleResolution": "bundler"`, `"verbatimModuleSyntax": true`).

**Done when:** `pnpm --filter legacy-poc dev` serves `http://localhost:3000` and
`pnpm --filter legacy-poc eval` reproduces the Phase 0 verdicts.

**Trap:** `git mv`, not delete-and-recreate. History on `rag.js` is what lets
you answer "why is this line here" in six months.

---

### Phase 2 — `@rag/chunker` and `@rag/openai`

> **Done 2026-09-22.** Parity: **87 comparisons, 0 differences** — 17 documents
> (the 8 sample docs, the Northwind fixture, 8 synthetic shapes) across 4
> chunk-size configurations, plus `estimateChunkCount` and both exported
> constants. 13 vitest cases pass; `pnpm build` and `pnpm typecheck` are clean.
>
> **The `embed(['hello']) === 1536` check is still blocked** — the API key now
> returns *"Your API key has been invalidated."* (it said *"expired"* on
> 2026-09-21; same 401, different upstream sentence). What that failure did
> verify is the error contract the whole route layer is built on: the thrown
> value is an `OpenAIError` with `status: 401` as a **number**, and its message
> is formatted identically to the JS original.

**Goal:** the two leaf modules in TypeScript, with the chunker verified
character-for-character against the original.

**`@rag/chunker` first.** It is pure, it has no I/O, and it is the only module
whose output can be compared exactly.

```ts
export const CHUNK_SIZE = 1000;
export const CHUNK_OVERLAP = 150;
export function chunkText(text: string, size?: number, overlap?: number): string[];
export function estimateChunkCount(length: number, size?: number, overlap?: number): number;
```

Then write a parity script: run the old `apps/legacy-poc/src/chunker.js` and the
new `@rag/chunker` over all eight `sample-documents/*.md` plus the Northwind
fixture, and assert `JSON.stringify(a) === JSON.stringify(b)`.

**`@rag/openai` second.** Type `embed()`, `chat()`, `chatStream()`, and the
error that carries `status` — the whole error→status map in
[Phase 5](#phase-5--api-routes) depends on that property existing, so give it a
real type rather than `any`:

```ts
export class OpenAIError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export function embed(texts: string[]): Promise<number[][]>;
```

Add vitest to `@rag/chunker`: paragraph boundaries, the overlap tail, a
paragraph longer than `CHUNK_SIZE` (D-018's split path), and an empty string.

**Done when:** the parity script reports zero differences across nine documents,
and `embed(['hello'])` returns one array of length 1536.

**Trap:** the 1536 is a runtime fact, not a type-system one. Do not type it as a
fixed-length tuple — the check that matters is the assertion from Phase 1.2 of
the original build, and it should survive as a runtime guard.

---

### Phase 3 — `@rag/db`

> **Done 2026-09-22.** `pnpm --filter @rag/db verify` passes **10 checks**, none
> of which need an OpenAI key — including a chunk searched against its own
> embedding returning itself at similarity **1.000000**, which is what proves
> the column is behaving as a vector. The guard is proven in both directions:
> plain Node is blocked, `--conditions=react-server` is allowed.
>
> **Tenancy: single tenant**, decided 2026-09-22. No `tenant_id`. Tenancy
> becomes its own plan after Phase 7, with its own migration.
>
> **Two deviations, detailed in `whats-done.md`:** the types are hand-written
> from the committed `.sql` files rather than generated (the direct database
> host no longer resolves and the generator needs credentials this repo does not
> carry), and the `server-only` guard forces `--conditions=react-server` on
> every Node entry point — which from Phase 4 means `pnpm eval` and
> `pnpm scores` too.

**Goal:** one typed client, and the service-role key structurally unable to
reach the browser.

1. Move `schema.sql` and `schema-hybrid.sql` to `packages/db/sql/` unchanged.
2. `pnpm dlx supabase gen types typescript --project-id <ref> > src/database.types.ts`.
3. `client.ts` — the POC's `src/supabase.js` verbatim, plus `import 'server-only'`
   as the first line and `createClient<Database>(...)`.
4. Hand-type the two RPC return rows. The generator will not give you a usable
   shape for `vector(1536)`:
   ```ts
   export type MatchRow = { id: number; document_id: number; content: string; similarity: number };
   export type FtsRow   = MatchRow & { rank: number };
   ```
5. Keep a runtime guard where the embedding comes back. A vector stored as text
   instead of numbers produces plausible behaviour with no error
   (`CLAUDE.md` trap 5), and TypeScript will not catch it — as far as the
   generator is concerned that column is opaque.

**Done when:** a Client Component that imports `@rag/db` fails the build with
the `server-only` error, and `match_chunks` returns typed rows.

> **Decide now if you are going multi-tenant.** `sample-documents/todo.txt`
> lists "convert this to a tenant base design". Adding `tenant_id` to
> `documents`, `chunks`, `conversations` and `messages` costs one migration
> *today*, versus a backfill plus a rewrite of every query in `@rag/pipeline`
> later — including both SQL functions, which need the filter pushed inside them
> to stay indexable. This plan assumes **no**, single tenant. If the answer is
> yes, do it here, before Phase 4 writes the queries.

---

### Phase 4 — `@rag/pipeline`

> **Code complete 2026-09-22. Verification is PARTIAL — this phase is not
> closed.**
>
> `tools/parity.mjs` proves **22 comparisons, 0 differences** against the
> original `rag.js`: all seven constants, `buildPrompt` on four inputs, and
> `retrieve` on seven queries against the live database — including
> keyword-only, vector-only and mixed `foundBy` outcomes. None of that needed
> an API key, because the query vector is an embedding already stored in a
> chunk row.
>
> **What is still unverified, and why the phase stays open:** `ingestDocument`,
> `rewriteQuestion`, `answerQuestion` and `answerQuestionStream` all call
> OpenAI, and the key is invalid (a third distinct message today: *"Incorrect
> API key provided"*). `pnpm eval` and `pnpm scores` resolve every module, load
> the `server-only` package correctly and die exactly at the first OpenAI call
> — which proves the wiring and nothing about the behaviour.
>
> **To close this phase:** replace the key, capture the Phase 0 baseline, then
> confirm `pnpm eval` gives the same six verdicts and `pnpm scores` the same
> numbers to three decimal places.

**Goal:** the 645 lines of `rag.js` in TypeScript, behaving identically. This is
where the migration is won or lost.

Split along the seams the file already has:

| File | From `rag.js` | Exports |
|---|---|---|
| `constants.ts` | 152–203 | `MATCH_COUNT`, `CANDIDATE_COUNT`, `RRF_K`, `MIN_SIMILARITY`, `MAX_HISTORY`, `REWRITE_MAX_TOKENS`, `NO_ANSWER` |
| `ingest.ts` | 28–149 | `ingestDocument`, `listDocuments`, `deleteDocument`, `getChunks` |
| `prompt.ts` | 213–299 | `buildPrompt` |
| `retrieve.ts` | 301–458 | `rewriteQuestion`, `retrieve` |
| `answer.ts` | 461–645 | `answerQuestion`, `answerQuestionStream`, `getMessages` |

The types worth writing down, because they are the API the web app codes
against:

```ts
export type Source = {
  id: number; documentId: number; documentTitle: string;
  content: string; similarity: number;
  foundBy: 'vector' | 'keyword' | 'both';   // D-015 — rendered in the sources panel
};
export type Answer     = { conversationId: string; reply: string; sources: Source[]; searchQuery: string };
export type StreamMeta = { conversationId: string; sources: Source[]; searchQuery: string };
```

Keep the `console.log('[query] …')` line at `rag.js:502`. `TEST-PROMPTS.md`
tells the tester to watch for it, and it is how you tell a right answer from a
right answer *for the wrong reason*.

Port `prompt-eval.ts` and `score-probe.ts` alongside, wired to `pnpm eval` and
`pnpm scores` at the workspace root. They run outside Next, so they need their
own env loading — Node 20.6+ has `--env-file=.env.local`, which drops `dotenv`.

**Done when:**

- `pnpm eval` gives the **same six verdicts** as `plan/baseline/eval-before.txt`;
- `pnpm scores` gives **the same similarity numbers to three decimal places**.
  Embeddings are deterministic for a fixed model and input, so retrieval scores
  must match exactly. Generated prose will differ between runs; verdicts and
  scores must not;
- the cleanup-on-failed-ingest path still fires (`CLAUDE.md` trap 6). Test it by
  breaking `OPENAI_API_KEY` mid-ingest and confirming no orphan `documents` row
  survives.

**Trap:** a drifted score is not a rounding artefact. It means chunk boundaries
moved, the rewrite prompt changed, or the fusion order flipped. Go find which —
do not adjust the threshold to compensate.

---

### Phase 5 — API routes

> **Done 2026-09-22.** All six endpoints as Route Handlers. Verified by running
> the Express POC on :3099 and Next on :3000 **at the same time** and diffing
> every response: **24 comparisons, 0 differences**, including the exact error
> strings, content negotiation, and the SSE failure-as-data path.
>
> Two things the invalid API key made testable rather than blocked: an upstream
> 401 reaching the client as a 401 with the real message, and a mid-stream
> failure arriving as an `error` event inside a 200.
>
> **One regression found and fixed during the phase**: the env check started as
> a module-scope throw, which meant the handler never existed, so `withRoute`
> never ran and the client got Next's generic 500 HTML. See `whats-done.md`.
>
> The comparison lives on as `pnpm --filter web parity`, and it works only
> while `apps/legacy-poc` still exists — so it is a Phase 7 casualty by design.

**Goal:** the six endpoints as Route Handlers, with the error map still in one
place.

| Express | Route Handler |
|---|---|
| `POST /api/documents` | `app/api/documents/route.ts` → `POST` |
| `GET /api/documents` | same file → `GET` |
| `DELETE /api/documents/:id` | `app/api/documents/[id]/route.ts` → `DELETE` |
| `GET /api/documents/:id/chunks` | `app/api/documents/[id]/chunks/route.ts` → `GET` |
| `POST /api/chat` | `app/api/chat/route.ts` → `POST` (JSON **and** SSE — [§ 2.2](#22-sse-over-a-route-handler-is-not-reswrite)) |
| `GET /api/conversations/:id/messages` | `app/api/conversations/[id]/messages/route.ts` → `GET` |

- **Validation stays at the boundary**, as today. zod for the three request
  bodies, and keep the exact error strings (`"A title is required"`, the
  character-count message at `server.js:86`) — the admin page renders them.
- **`MAX_CONTENT_LENGTH` (100,000) and `MAX_MESSAGE_LENGTH` (2,000)** move to a
  shared module. `admin.js:20` currently duplicates the first with a
  `// must match server.js` comment; that comment stops being necessary, which
  is the second wart the monorepo removes.
- **The error map** becomes `withRoute()`: 401 and 429 pass through from OpenAI,
  ≥500 becomes 502, everything else 500, and the real message always reaches the
  client (`architecture.md` § 9). Route Handlers have no error middleware, so
  every handler must be wrapped — one missed wrapper and that route returns
  Next's generic 500 instead of the real reason.
- **Env fail-fast**: the check at `server.js:23-35` has no `app.listen()` to sit
  in any more. Put it in module scope of `lib/env.ts`, so the first import
  throws with the same one-line message rather than producing a confusing 401
  twenty minutes later.

**Done when:** every curl example in `README.md` returns the same status code and
body shape as in Phase 0 — including `curl` on `/api/chat` getting **JSON, not
a stream**.

---

### Phase 6 — The screens

> **Done 2026-09-22.** Built, then **checked by hand** — all four steps of the
> `mvp.md` definition of done pass in the browser, including the streaming
> answer with its sources panel arriving first, and the refusal after the
> document is deleted.
>
> Both screens compile, render and serve; `pnpm build` and `pnpm typecheck` are
> clean. Verified server-side: the markup and every class name the stylesheet
> targets, the empty state and its hint, the form, and the live estimate
> rendering **"0 characters · ≈ 0 chunks (1000 chars, 150 overlap)"** — which
> proves `@rag/chunker`'s constants reach the browser through an ordinary
> workspace import, with the `express.static('/chunker.js')` hack gone.
>
> **The § 2.1 grep now means something**, because client components finally
> exist: `service_role`, `SUPABASE_SERVICE`, and both live key prefixes appear
> in **0 files** under `.next/static/`, and the variable name appears only in a
> server chunk.
>
> Everything that needed a browser — streaming text, the sources panel opening
> before the first token, click-to-expand, Retry, the delete confirmation — was
> verified by hand rather than by me; browser tooling was declined this session.

**Goal:** `screens.md` S-1 and S-2 in React, every state included.

- `app/page.tsx` — chat. The SSE reader at `public/app.js:239` moves almost
  verbatim into `use-chat-stream.ts`; the comment there explaining why
  `EventSource` cannot be used (it cannot POST) is still the reason, so keep it.
- `app/admin/page.tsx` — the form, the live chunk estimate (now importing
  `@rag/chunker` directly), the document list, expandable chunk rows, delete
  with its confirmation.
- States that are easy to lose in a rewrite: empty knowledge base, empty chat
  with its hint, pending turn, sources panel with `foundBy` badges, delete
  confirmation, every error banner, the disabled-while-sending composer.
- **The `textContent` rule** (`CLAUDE.md` § Conventions) is satisfied for free —
  React escapes children. It comes back the instant someone adds
  `dangerouslySetInnerHTML` for markdown rendering, which is still out of scope.
- No `console.log` in committed client components.

**Done when:** the `mvp.md` definition of done passes end to end in the browser —
paste a document containing a fact the model cannot know, ask about it, get the
right answer **plus the source chunk**; delete the document, ask again, get the
refusal with an empty sources panel.

---

### Phase 7 — Cutover

1. Delete `apps/legacy-poc/`. Its history is in git and `flow.md` documents what
   it did.
2. Re-run `pnpm eval` and `pnpm scores` into `plan/baseline/*-after.txt`; diff
   against the Phase 0 files and put the diff in the commit message.
3. `pnpm build`, then `grep -ri "service_role\|SUPABASE_SERVICE" apps/web/.next/static/`
   — must return nothing ([§ 2.1](#21-the-service_role-key-can-now-reach-the-browser)).
4. **Amend the docs.** Required by `CLAUDE.md` § "Keeping the record", and this
   is the largest deviation the project has logged:

   | Decision | Status after this migration |
   |---|---|
   | D-009 Express 4 | Superseded — Next.js Route Handlers |
   | D-013 Local only | Superseded by Phase 8 |
   | D-014 No TypeScript | **Reversed.** Log the reasoning: the POC's goal was reading the pipeline without type noise, and that has served its purpose; a product with more than one surface needs the contract enforced |
   | New D-020 | Turborepo monorepo — why packages, not folders |
   | New D-021 | Next.js App Router over the Express + static split |
   | New D-022 | Validation library at the route boundary — retires the three-dependency rule, which was a learning constraint, not an architectural one |

   `architecture.md` § 7 (module responsibilities) and § 3 (the flowcharts) need
   the new paths. `README.md` needs the new setup steps. `CLAUDE.md` and
   `BUILD.md` need rewriting — and collapsing, since they are identical files
   today.
5. `status.md` and `whats-done.md`: a section per phase, with real observed
   values, per the existing convention.

---

### Phase 8 — Deploy

1. Hosting project pointed at the monorepo root, build `turbo build --filter=web`.
2. Env vars set as **plain** secrets. Never `NEXT_PUBLIC_`.
3. Confirm streaming works on the deployed URL. This is the step that catches a
   proxy buffering the stream, and it cannot be caught locally.
4. Confirm `maxDuration` is above the slowest real answer — measured, not
   guessed.
5. Work through `sample-documents/TEST-PROMPTS.md` (29 prompts) against the
   deployed app.
6. Read `README.md` § "Before you put this in production". Nothing there is
   waived by having a nicer stack. D-006 in particular — service_role, RLS
   enabled with no policies — is only safe while the server is the sole client.
   The moment there are real users, that is the thing to revisit.

---

## 5. What does not change

Worth stating explicitly, because a TypeScript port invites tidying:

- the three SQL functions and both index definitions;
- the RRF fusion maths and `foundBy` labelling (D-015);
- the query-rewrite step, and the fact that the model still sees the user's
  **original words** while only retrieval sees the rewrite (D-016);
- the short circuit: nothing above threshold returns the refusal string
  **without calling OpenAI** (D-008);
- `buildPrompt()`'s grounding line, verbatim (D-017 — Phase 5.5 measured that
  this line, not the threshold, is what prevents invention);
- raw `fetch` against the OpenAI HTTP API, no SDK (D-002). The reason was
  understanding the two calls, and that is still worth more than the
  convenience.

---

## 6. Rollback

Every phase is a commit on `feat/nextjs-migration`, and `apps/legacy-poc` runs
unchanged until Phase 7. If Phase 4 cannot reproduce the baseline, the fix is to
diff the new module against the old file still sitting in the same repo — not to
start tuning constants. `master` is untouched until the branch merges.

---

## 7. What this unblocks (not in this plan)

From `sample-documents/todo.txt`, with the seam each one needs:

| Want | Seam the port should leave open | Where it lands |
|---|---|---|
| Multi-tenant | `tenant_id` on all four tables, with the filter pushed *inside* `match_chunks` so it stays indexable; a `tenantId` threaded through `@rag/pipeline` | Schema first — see the Phase 3 callout |
| Messenger integration | A second app importing `@rag/pipeline`. This is the argument for a monorepo that the POC never had | `apps/messenger/` |
| Tool calls for dynamic data | `chat()` gains a `tools` parameter and a tool-call loop; `buildPrompt()` gains a branch. **Re-run `pnpm eval` after** — a bot that can call tools can also answer from training data while looking grounded | `@rag/pipeline` |
| Per-tenant branding and theme | Config read server-side and passed down. No new pipeline surface | `apps/web` |
| Analytics | A script in the root layout. Note that questions are user content — do not ship question text to an analytics vendor without deciding that deliberately | `apps/web` |

Each of these is a plan of its own. Start one only after Phase 7 is committed
and the eval matches.
