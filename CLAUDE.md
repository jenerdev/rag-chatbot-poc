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
>
> **It is multi-tenant** since 2026-09-23 ([`plan.md`](./plan.md), Phases 0–8,
> all done): one database, many businesses, each at `/t/<slug>` with its own
> documents, assistant name, theme and admin key. Read `plan.md` § 0 before
> touching any query.

## What this is

A **retrieval-augmented chatbot** that answers questions from documents you
paste in — per tenant: each business sees only its own documents. Hybrid
retrieval (vector + full-text, fused with RRF), a grounding prompt that refuses
rather than invents, and a sources panel that shows the exact chunks every
answer was built from.

```
resolve tenant → (every step below is scoped to it)
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
apps/web/              Next.js 15, App Router
  app/page.tsx                   static root — no tenant list, no redirect
  app/t/[tenant]/layout.tsx      tenant theme (style prop) + tab title
  app/t/[tenant]/page.tsx        S-1 chat — Server Component, resolves the tenant
  app/t/[tenant]/admin/page.tsx  S-2 knowledge base — same
  app/t/[tenant]/admin/bookings/page.tsx  S-3 bookings — 404 unless the tenant has the application
  app/t/[tenant]/not-found.tsx   "No such workspace"
  app/api/t/[tenant]/**/route.ts the endpoints + admin/session; chat/ does JSON and SSE
  components/                    chat-screen, admin-screen, bookings-screen, admin-login (Client), brand-header, sources-panel
  lib/route.ts           withRoute(): validation + the ONE error→status map
  lib/tenant.ts          getTenant() + withTenantRoute(): slug → TenantContext, 404 on a miss
  lib/admin-auth.ts      signed session cookie, requireAdmin()
  lib/applications.ts    requireApplication(): 404 unless the tenant has it switched on
  lib/branding.ts        the five-key theme allowlist, https-only image URLs
  lib/env.ts             fail-fast config (D-023)
  lib/limits.ts          MAX_CONTENT_LENGTH — importable by the browser
packages/
  chunker/             @rag/chunker — pure, isomorphic, ZERO dependencies
  openai/              @rag/openai — embed, chat, chatStream over raw fetch; tool calls in, never run
  db/                  @rag/db — the client, the types, sql/ (4 files), and server-only
    src/admin-key.ts     scrypt hashAdminKey / verifyAdminKey
    tools/verify.mjs     28 checks, no API key
    tools/tenant.mjs     tenant:add / tenant:key — prints a key once
  bookings/            @rag/bookings — availability, bookings; admin routes AND the chatbot tool call it
    tools/isolation.mjs    13 cross-tenant checks, no API key
  rag/                 @rag/pipeline — ingest, retrieve, prompt, answer, tenant, applications, tools
    tools/prompt-eval.mjs  the battery, 19 cases (10 + 9 tool-*), both tenants; seeds its own bookings
    tools/isolation.mjs    11 cross-tenant checks through the pipeline
  tsconfig/            shared base config
fixtures/northwind.json  tenant northwind's corpus, for the eval battery
sample-documents/        tenant villa's corpus (01–08 only), for the battery too
plan/                    the migration plan and its evidence; plan.md is tenancy
```

## Commands

```sh
pnpm dev                        # http://localhost:3000
pnpm build · typecheck · test
pnpm --filter @rag/db verify    # 28 checks, no API key needed
pnpm eval                       # the prompt battery, 19 cases  ⚠ see below
pnpm scores                     # real similarity scores for northwind, threshold off
pnpm --filter @rag/pipeline isolation   # 11 cross-tenant checks  ⚠ rule 6
pnpm --filter @rag/bookings isolation   # 13 cross-tenant booking checks, no API key
pnpm --filter @rag/db tenant:add -- <slug> "<business>" "<assistant>"   # key printed ONCE
pnpm --filter @rag/db tenant:key -- <slug>                              # new key; old one dies
```

## The rules you will be tempted to break

1. **Re-run `pnpm eval` after ANY edit to `buildPrompt()`.** Phase 5.5 measured
   that this prompt, not the similarity threshold, is what stops the model
   inventing answers. A change that makes the bot more helpful can quietly make
   it answer from training data instead. The battery checks both directions at
   once: real questions answered, absent facts still refused.
   **It needs BOTH tenants loaded:** `northwind` holding `fixtures/northwind.json`
   and nothing else, `villa` holding `sample-documents/01–08`. It used to demand
   northwind *alone*, because Villa describes parking and `absent-2` must refuse
   parking. Tenancy turned that fragile precondition into the feature (plan.md
   § 2.5): `leak-1`/`leak-2`/`leak-3` now assert that a fact in the database,
   but in the other tenant, is unreachable. Expect **18/19**, printed as
   `original 9/10 · tool 9/9`: `antecedent` is the known model limit (D-017).
   A different number means something moved. The nine `tool-*` cases seed
   `fixtures/villa-bookings.json` into villa themselves and hard-delete it
   afterwards (plan/bookings.md Phase 6). Tools also mean a second prompt
   check: `pnpm --silent --filter @rag/pipeline prompt-snapshot` must match
   `plan/baseline/northwind-prompt-pre-bookings.txt` (`diff --strip-trailing-cr`).
2. **The service-role key never reaches the browser.** `@rag/db` imports
   `server-only`, so a Client Component importing it is a build error. Before
   shipping: `grep -ri "service_role" apps/web/.next/static/` must return
   nothing.
3. **Every Route Handler is wrapped in `withTenantRoute()`**, which resolves the
   slug (404 on a miss, never a fallback) and wraps `withRoute()`. Nothing
   enforces it. An unwrapped handler answers with a generic 500 instead of the
   real reason — or, worse, runs without knowing its tenant.
4. **Any Node script that touches `@rag/db` needs `--conditions=react-server`.**
   That is the cost of rule 2. Every script in `package.json` carries it already.
5. **`@rag/chunker` has no dependencies and no I/O.** That is what lets the same
   code run in Node and the browser, and what keeps the file readable alone.
6. **The only thing between two tenants is a `tenant_id` filter.** `service_role`
   bypasses RLS (D-006, R-2, R-11), so isolation is application code. Every
   query on `documents`, `chunks`, `conversations` or `messages` filters on
   `tenant_id`, every insert sets it, every search `.rpc()` sends `p_tenant_id`.
   `tenant` is a **required** parameter with **no default** — no ambient
   "current tenant", no fallback slug (D-027); a forgotten one should be a
   compile error, not a silent read. The composite FKs stop cross-tenant
   *writes*; nothing but your filter stops a cross-tenant *read*. After any
   change to a query, run `pnpm --filter @rag/pipeline isolation` and
   `pnpm eval` — the `leak-*` cases must stay green — and re-run plan.md
   Phase 3's grep: every line it prints must carry a tenant.

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
- Every Route Handler lives under `app/api/t/[tenant]/` and is wrapped in
  `withTenantRoute()` (which wraps `withRoute()`). Admin-only handlers call
  `requireAdmin(request, tenant)` first. The chat route stays open.
- Every tenant-owned query carries `.eq('tenant_id', tenant.id)` — rule 6.
  "Not yours" and "not there" must look identical (`[]`, `null`, 404), or ids
  can be enumerated across tenants.
- Select `tenants` columns **explicitly**, never `select('*')`: that is how
  `admin_key_hash` ends up in a `TenantContext`, a prop, or a response.
  `TenantContext` has no hash field on purpose.
- Errors surface the real message. No swallowing, no generic "something went
  wrong", no retry loops (`architecture.md` § 9).
- Frontend: never `dangerouslySetInnerHTML` for anything from the server or the
  model. React escapes children, which is what makes this free — adding
  markdown rendering is what would take it away. Tenant branding follows the
  same rule: theme colours reach the page as CSS custom properties through the
  `style` prop, from the allowlist in `lib/branding.ts` (D-030).
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
