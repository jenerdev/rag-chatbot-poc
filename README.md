# RAG Chatbot POC

> **Status:** ✅ **Built and working.** Migrated to Next.js + TypeScript on a
> Turborepo monorepo, 2026-09-22 — see [`plan/steps.md`](./plan/steps.md).
> **Multi-tenant** since 2026-09-23: one deployment, many businesses, each with
> its own documents, name, assistant and look — see [`plan.md`](./plan.md).
> **Type:** Learning project · **Builder:** Solo
> **Findings:** [`notes.md`](./notes.md) · **Build log:** [`whats-done.md`](./whats-done.md)

## Pitch

A **chatbot that answers from your own documents**, built from scratch with no
RAG framework and no AI SDK — so that every step of the pipeline is code you
wrote and can explain.

```
paste document → chunk → embed → store in pgvector
ask question   → rewrite → embed → vector + keyword search → fuse (RRF)
               → paste chunks into prompt → stream the answer
```

Next.js (App Router) and React, Supabase Postgres with `pgvector`, OpenAI for
embeddings and chat — reached with raw `fetch`, because the two HTTP calls are
the most instructive part and an SDK would hide them (D-002). Runs on
`localhost:3000`.

Each business is a **tenant** with its own address, `/t/<slug>`. Tenants share
one database; every query is filtered by `tenant_id`, and the eval battery
proves one tenant cannot read another's documents (D-025).

## Setup

**Prerequisites:** Node.js 20+, an OpenAI **platform** account with prepaid
credits, and a free Supabase project.

⚠️ A ChatGPT Plus subscription grants **no** API access — see [`costs.md`](./costs.md).

### 1. Install and configure

```bash
pnpm install          # pnpm 9+; `corepack enable pnpm` if you do not have it
cp .env.example .env
```

Fill in `.env`:

| Variable | Where it comes from |
|---|---|
| `OPENAI_API_KEY` | platform.openai.com → API keys |
| `OPENAI_CHAT_MODEL` | `gpt-4o-mini` |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` — **must match `vector(1536)`** |
| `SUPABASE_URL` | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | same page — the **`service_role`** key, not `anon` |
| `ADMIN_COOKIE_SECRET` | 32+ random characters that sign admin sessions: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Changing it logs every admin out |

### 2. Create the schema — three files, in order

Paste each into the Supabase SQL editor and run it, one after the other:

1. [`packages/db/sql/schema.sql`](./packages/db/sql/schema.sql) — the `vector`
   extension, `documents`, `chunks`, `conversations`, `messages`, the HNSW
   index, RLS on every table, `match_chunks`.
2. [`schema-hybrid.sql`](./packages/db/sql/schema-hybrid.sql) — full-text
   search: the GIN index and `match_chunks_fts` (D-015).
3. [`schema-tenancy.sql`](./packages/db/sql/schema-tenancy.sql) — the
   `tenants` table (so **five tables** in all), `tenant_id` on the other four,
   the composite foreign keys, and tenant-scoped versions of both search
   functions. It also seeds one tenant, `northwind`, with no admin key yet.

All three are idempotent. Verify:

```sql
select * from pg_extension where extname = 'vector';          -- one row
select tablename, rowsecurity from pg_tables
  where schemaname = 'public';                                -- five rows, all true
select slug from tenants;                                     -- northwind
```

> If the SQL editor warns about missing Row Level Security, the `alter table …
> enable row level security` statements are already in the files — run them as
> written. Then check `rowsecurity` actually flipped; a stale paste in the
> editor will silently skip them.

Then, with no OpenAI key needed:

```bash
pnpm --filter @rag/db verify     # 14 checks, including cross-tenant ones
```

### 3. Create tenants and their admin keys — before adding any document

A tenant's knowledge base can only be edited with its admin key. Keys are
printed **once** and only their scrypt hash is stored; there is no way to read
one back.

```bash
# northwind already exists (schema-tenancy.sql seeded it) — give it a key:
pnpm --filter @rag/db tenant:key -- northwind

# every other tenant: slug, business name, assistant name
pnpm --filter @rag/db tenant:add -- villa "Villa Amihan Private Resort" "Lia"
```

Store each key as it is printed. A lost key is replaced by running
`tenant:key -- <slug>` again, which invalidates the old one. A slug is 3–32
characters of lower-case letters, digits and hyphens; the database rejects
anything else.

## Running it

```bash
pnpm dev        # http://localhost:3000, with hot reload
pnpm build      # then: pnpm --filter web start
```

| Page | What to do |
|---|---|
| `/t/<slug>/admin` | Log in with that tenant's admin key. Paste a document, watch the live chunk estimate, then add it. |
| `/t/<slug>` | Ask a question. Expand the sources under the answer. |
| `/` | A static page. It does not list tenants or redirect to one — each tenant is reached by its own address. |

An unknown slug is a 404 ("No such workspace").

**To prove it works:** paste a document containing a fact no model could know,
ask about it, get the answer plus the source chunk — then delete the document
and ask again. It must say it doesn't know. Then ask the *other* tenant the same
question: it must say it doesn't know either.

### Loading the two eval tenants

The eval battery (`pnpm eval`) asserts against **both** fixture tenants, each
holding its own corpus:

| Tenant | Corpus |
|---|---|
| `northwind` | `fixtures/northwind.json` — one document |
| `villa` | `sample-documents/01-…md` to `08-…md` — eight documents (not the README or TEST-PROMPTS) |

Paste them through `/t/<slug>/admin`, or load them over the API with a session.
With `pnpm dev` running (the session cookie is marked `Secure` outside
development, so use `dev` for this):

```bash
# northwind — the fixture is already {title, source, content}
curl -c nw.jar -X POST localhost:3000/api/t/northwind/admin/session \
  -H 'content-type: application/json' -d '{"key":"<northwind key>"}'
curl -b nw.jar -X POST localhost:3000/api/t/northwind/documents \
  -H 'content-type: application/json' -d @fixtures/northwind.json

# villa — each file's first "# " heading is its title
curl -c villa.jar -X POST localhost:3000/api/t/villa/admin/session \
  -H 'content-type: application/json' -d '{"key":"<villa key>"}'
for f in sample-documents/0*.md; do
  node -e "const c=require('fs').readFileSync(process.argv[1],'utf8');
    console.log(JSON.stringify({title:c.match(/^#\s+(.+)$/m)[1].trim(),source:process.argv[1],content:c}))" "$f" |
  curl -b villa.jar -X POST localhost:3000/api/t/villa/documents \
    -H 'content-type: application/json' -d @-
done
rm nw.jar villa.jar
```

Then:

```bash
pnpm eval                               # 10 cases; expect 9/10
pnpm --filter @rag/pipeline isolation   # 11 cross-tenant checks; expect all PASS
```

The one expected eval failure is `antecedent` — a `gpt-4o-mini` model limit
(it quotes the auditor exception instead of the general rule), recorded in D-017.
The four newest cases, `leak-1`, `leak-2`, `leak-3` and `persona`, are the
cross-tenant ones: each asks one tenant for something only the other has.

**Stopping the server on Windows** (`pkill` will not do it):

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force }
```

## The five knobs

All named constants at the top of their module, so they are easy to find and
change. [`notes.md`](./notes.md) records what happens when you do.

| Constant | Value | File |
|---|---|---|
| `CHUNK_SIZE` | 1000 | `packages/chunker/src/index.ts` |
| `CHUNK_OVERLAP` | 150 | `packages/chunker/src/index.ts` |
| `MATCH_COUNT` | 5 | `packages/rag/src/constants.ts` |
| `MIN_SIMILARITY` | 0.25 *(measured, not guessed)* | `packages/rag/src/constants.ts` |
| `MAX_HISTORY` | 6 | `packages/rag/src/constants.ts` |

**Changing the chunker does not touch chunks already stored.** Delete the
document and re-add it.

## How it works end to end

[`flow.md`](./flow.md) has the diagrams: the big picture, the ingest pipeline,
the query pipeline step by step, and a map of which stage to suspect when an
answer comes out wrong.

## Where the code lives

| File | Responsibility |
|---|---|
| `packages/chunker` | `chunkText()` — pure, **zero dependencies**. Runs in Node **and** the browser |
| `packages/openai` | `embed()`, `chat()`, `chatStream()` — raw `fetch`, no SDK |
| `packages/db` | One configured client, the schema (three SQL files), the `server-only` guard, admin-key hashing, and the `verify` / `tenant:add` / `tenant:key` tools |
| `packages/rag` | Both pipelines — `ingestDocument()` and `answerQuestion()` — every one taking a required `tenant`; plus the `eval`, `scores` and `isolation` tools |
| `apps/web/app/api/t/[tenant]` | Six Route Handlers, all behind `withTenantRoute()`; `lib/route.ts` holds the one error → status map |
| `apps/web/app/t/[tenant]` | The two pages as Server Components that resolve the tenant; the screens themselves are in `apps/web/components` |
| `apps/web/lib` | `tenant.ts` (slug → tenant), `admin-auth.ts` (signed session cookie), `branding.ts` (the theme allowlist) |

## ⚠️ Before you put this in production

**This POC is local-only by design (D-013).** Everything below is off by default
and has to be decided deliberately. Work down the list; nothing here is optional
once there is a real user on the other end.

### 1. Re-measure against YOUR documents — do this first

Every tuned number in this repo was measured on one invented 2,607-character
test document. **None of them transfer.** Load your real corpus, then:

```bash
pnpm scores        # what do real questions actually score?
pnpm eval          # does it answer AND refuse correctly?
```

- **`pnpm scores`** prints similarity scores with the threshold disabled, so
  you can see the whole range. Set `MIN_SIMILARITY` in
  `packages/rag/src/constants.ts` from the gap
  between your real questions and your off-topic ones. The shipped 0.25 came
  from a three-chunk corpus and is a starting point, not an answer.
- **`pnpm eval`** runs a fixed battery that checks **both** directions:
  questions that should be answered, and absent facts that must still be
  refused. **Edit the cases in `packages/rag/tools/prompt-eval.mjs` to use your
  own documents' facts** — the shipped ones are about a fictional laboratory
  (tenant `northwind`) and a fictional resort (tenant `villa`). The cross-tenant
  `leak-*` cases need two tenants with different corpora; keep that shape when
  you replace them.

### 2. Decide the chat model from that battery — do not guess

`OPENAI_CHAT_MODEL` is one env var (D-005), and the difference is real but
narrow. Measured here: `gpt-4o-mini` scored **5/6**, `gpt-4o` scored **6/6** on
an identical prompt, at roughly **16× the input cost**.

The single case that separated them: applying a **general rule** when the
document also states an **exception**. `gpt-4o-mini` quoted the exception.

**So:** if your documents contain rules with carve-outs — pricing tiers, policy
exceptions, eligibility bands, "except for…" clauses — run the battery on both
models and read the difference. If they do not, `gpt-4o-mini` is very likely
fine and far cheaper. See D-017.

### 3. Security — both become real the moment there is a URL

- **R-1 — the OpenAI key.** It stays server-side. It is already only in `.env`
  and `.env` is gitignored; keep it that way, and set a spending limit.
- **R-2 — RLS has no policies.** RLS is enabled on all four tables but the
  server uses the `service_role` key, which bypasses it entirely. That is safe
  for one trusted local server and **is not safe once the database is reachable
  from anywhere else**. Write policies and move browser-facing reads to the
  `anon` key before deploying. See `decisions.md` D-006.
- **R-11 — tenant isolation is application code.** Because `service_role`
  bypasses RLS, the only thing between two tenants' data is a `tenant_id`
  filter in every query. The composite foreign keys protect writes; reads are
  protected only by filters someone remembered. `pnpm eval`'s `leak-*` cases
  and `pnpm --filter @rag/pipeline isolation` are what catch a regression —
  RLS policies are what would make it impossible.
- **R-13 — no rate limit on admin logins.** A 32-byte key cannot be guessed,
  but nothing throttles or logs failed attempts. Add both before a public URL.

### 4. Re-run the battery after ANY prompt edit

`buildPrompt()` in `packages/rag/src/prompt.ts` is the only thing standing between a grounded
answer and a confident invention — Phase 5.5 measured exactly that. A change
that makes the bot more helpful can silently make it answer from training data.

```bash
pnpm eval          # must still refuse every absent-fact case
```

### 5. Also out of scope, and worth knowing you do not have it

No user accounts (admin access is one key per tenant), no rate limiting, no
retries, no caching, no tenant self-signup or per-tenant spend caps, and
conversations are not listed in the UI. All deliberate (`mvp.md`), all things a
production deployment normally wants.

## Why it exists

Not to solve a market problem. To answer a question:

> *"I want to fully understand how it works."*

RAG chatbots are normally assembled from LangChain, LlamaIndex or the Vercel AI
SDK — libraries that exist to hide chunking, embedding, vector search and prompt
assembly. You can ship one without knowing what any of it does. This project
removes the libraries so that the mechanism is the only thing left.

**That goal is a functional requirement, not a preamble.** Every decision in
this folder resolves toward the more transparent option, even when it means more
code. A version that works but cannot be explained has failed.

## What it does

| Page | What happens |
|---|---|
| **Knowledge base** (`/t/<slug>/admin`) | Log in with the tenant's admin key, then paste a document. The server splits it into ~1000-character chunks with overlap, gets an embedding for each from OpenAI in one batched call, and stores chunk + vector in Supabase. |
| **Chat** (`/t/<slug>`) | Ask a question. The server embeds it, finds the nearest chunks by cosine distance in Postgres, pastes them into the prompt as context, and asks OpenAI to answer **using only that context** — showing you which chunks it used and how well they matched. Only that tenant's chunks are ever searched, and the assistant introduces itself by the tenant's assistant name. |

## The success criterion

> Paste in a document containing a fact the model cannot possibly know. Ask
> about it. Get the right answer **plus the chunk it came from**. Then delete
> the document and ask again — the bot must say it doesn't know.

That round trip proves all four hard parts at once: ingestion, matched embedding
spaces, retrieval, and grounding.

## Settled decisions

| Decision | Choice | |
|---|---|---|
| **RAG framework** | **None.** Hand-written chunking, retrieval, prompting | D-001 |
| **OpenAI client** | **Raw `fetch`.** No `openai` SDK | D-002 |
| **Vector store** | **pgvector inside Supabase** — not Pinecone/Chroma | D-003 |
| **Embeddings** | `text-embedding-3-small`, `vector(1536)` | D-004 |
| **Chat model** | `gpt-4o-mini`, set by env var | D-005 |
| **Chunking** | Fixed 1000 chars, 150 overlap — deliberately naive | D-007 |
| **Retrieval gate** | Similarity threshold + skip OpenAI when nothing matches | D-008 |
| **Language** | TypeScript in a Turborepo monorepo (reversed plain JS) | D-020, was D-014 |
| **Web framework** | Next.js App Router, replacing Express and the static pages | D-021 |
| **Tenancy** | Shared tables with `tenant_id`, filtered inside both SQL functions | D-025 |
| **Tenant address** | A path segment, `/t/<slug>` — not a subdomain | D-026 |
| **Tenant in code** | A required parameter everywhere; no default tenant | D-027 |
| **Admin auth** | One scrypt-hashed key per tenant, behind a signed cookie; hand-rolled | D-028 |
| **Persona** | One line above the unchanged grounding prompt, gated on the battery | D-029 |
| **Branding** | CSS custom properties via React's `style` prop, from an allowlist | D-030 |
| **Hosting** | **None.** Localhost only; RLS policies still unwritten | D-006, D-013 |

## Cost

**One paid thing: OpenAI prepaid credits — $5 minimum top-up, and the whole
project uses well under $1 of it.** Supabase's free tier covers everything else;
nothing is hosted.

⚠️ **A ChatGPT Plus subscription does not include API access.** They are
separate products. See [`costs.md`](./costs.md).

## Scope — the one rule

**If a feature does not teach you something about retrieval-augmented
generation, it is not in the MVP.**

| In | Out |
|---|---|
| paste-text ingestion · chunking · embedding | file upload (PDF/DOCX) · web scraping |
| vector search · grounded answers · visible sources | streaming · re-ranking · hybrid search |
| single-session conversation memory | auth · multi-user · deployment |
| readable errors | tests · retries · caching · rate limiting |

The full out-of-scope list is in [`mvp.md`](./mvp.md) — it is long and specific
because scope creep is this project's most likely failure mode
([`risks.md`](./risks.md) § R-4).

## The trap worth knowing up front

**The question and the documents must be embedded by the same model.** Vectors
from different models live in unrelated coordinate spaces; comparing them
produces plausible-looking similarity scores that mean nothing — and nothing
errors. It is the classic silent RAG bug, and it is why the sources panel is a
required feature rather than a debug toggle.

## Effort

**~8–10 hours** across 6 phases — a long weekend or three evenings.
Phase 5 (deliberately breaking things to see what each knob does) **is the
deliverable**, not optional polish.

## The docs

| File | What's in it |
|---|---|
| [`idea-intake.md`](./idea-intake.md) | The raw capture — the original Q&A, with assumptions marked |
| [`flow.md`](./flow.md) | **The flow as built.** Diagrams of every step from the browser to OpenAI and back, with the file and function behind each one |
| [`architecture.md`](./architecture.md) | **The original design.** What RAG is, both pipelines, the complete SQL schema, `match_chunks`, prompt assembly, file layout, error handling |
| [`mvp.md`](./mvp.md) | MVP scope, the explicit out-of-scope list, and the 6-phase roadmap |
| [`screens.md`](./screens.md) | Both screens, per role, with every state; route map |
| [`techstack.md`](./techstack.md) | Every choice and its justification; what was avoided and why |
| [`decisions.md`](./decisions.md) | Every decision, D-001 onwards, with what would reverse it; open questions |
| [`risks.md`](./risks.md) | What actually goes wrong, ordered by likelihood |
| [`costs.md`](./costs.md) | The OpenAI cost model, real estimates, how to not overspend |
| [`plan.md`](./plan.md) | **The tenancy plan.** Phases 0–8, each with a measured "done when" |
| [`CLAUDE.md`](./CLAUDE.md) | The rules for changing this repo. The original `BUILD.md` brief is in git history |
| [`whats-done.md`](./whats-done.md) | **The build log.** Every phase and step, what was done and why it mattered |
| [`notes.md`](./notes.md) | **Phase 5 findings.** What each knob does, measured |
| [`status.md`](./status.md) | Live dev log — read this first when resuming |

## Next step

The MVP is done. The post-MVP list is in [`mvp.md`](./mvp.md); the two things
the experiments made the strongest case for are **hybrid search** (vector search
scored an exact identifier below a vague paraphrase) and **query rewriting**
(retrieval never sees the conversation history). Both are explained in
[`notes.md`](./notes.md).
