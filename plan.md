# Tenancy plan — one chatbot, many businesses

> Turning this repo from *one knowledge base with one identity* into *N isolated
> tenants, each with its own documents, its own name, and its own look*, without
> losing the thing that proves the pipeline works: the eval battery.
>
> Written 2026-09-22, against commit `d01302a` on `feat/nextjs-migration`.
> This is the plan [`plan/steps.md`](./plan/steps.md) § 7 deferred and the
> Phase 3 callout warned would cost a migration if decided late. It is being
> decided late. Read [`§ 0`](#0-the-two-rules) before touching anything.

---

## What this plan covers

| | |
|---|---|
| **In scope** | A `tenants` table; `tenant_id` on all four existing tables with the filter pushed *inside* both SQL functions; a required `tenant` parameter through `@rag/pipeline`; routes under `/api/t/<slug>/…`; screens under `/t/<slug>` and `/t/<slug>/admin`; per-tenant business name, assistant name, logo, banner and theme; a per-tenant admin key behind a signed cookie; a tenant-aware eval battery with cross-tenant leakage cases |
| **Out of scope** | Supabase Auth and RLS policies (R-2 stays open, and [§ 6](#6-what-this-does-not-fix) says so out loud), tenant self-signup, per-tenant OpenAI keys or usage metering, Messenger, tool calls, analytics, Tagalog greetings. Each is listed in [§ 7](#7-what-this-unblocks) with the seam this plan leaves for it |

**Three decisions, asked and answered before writing this** (they are the
expensive ones, and all three are recorded in [§ 5](#5-decisions-to-log)):

1. **A tenant is a path segment**, `/t/<slug>` — not a subdomain. Identical on
   localhost and hosted, no wildcard DNS, no wildcard cert, and the slug is in
   every URL and every log line. Resolution happens in one function, so
   subdomains later are a change in one file.
2. **Admin gets a per-tenant key behind a signed cookie**, hand-rolled on
   `node:crypto`. No NextAuth, no Supabase Auth — D-001/D-002 ("no library does
   a step") still holds, and this stays readable.
3. **Persona is in scope**, which means `buildPrompt()` changes, which means
   `CLAUDE.md` rule 1 applies and [Phase 0](#phase-0--capture-the-baseline-that-was-never-captured)
   is not optional.

---

## 0. The two rules

### Rule 1 — Port the numbers, do not retune them

Same rule as the migration's § 0, same reason. Frozen for the duration:

| Constant | Value | Set by |
|---|---|---|
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | 1000 / 150 | notes.md § 5.1–5.2 |
| `MATCH_COUNT` · `CANDIDATE_COUNT` · `RRF_K` | 5 · 10 · 60 | notes.md, D-015 |
| `MIN_SIMILARITY` | 0.25 | notes.md § 5.3 |
| `MAX_HISTORY` | 6 | D-011 |
| `NO_ANSWER` | `"I don't know based on the documents I have."` | D-008 |
| The grounding block of `buildPrompt()` | **byte-identical** | D-017 |

Tenancy adds a persona *line above* the grounding block. It does not reword one
character of the block itself. Phase 4 measures whether even that much costs a
refusal.

### Rule 2 — Isolation is proven by a test, not by reading the code

`service_role` bypasses RLS. After this plan, **the only thing standing between
tenant A and tenant B is a `where tenant_id = …` in application code and inside
two SQL functions.** One missing filter is a data breach that throws no error,
logs nothing, and returns plausible answers.

So the acceptance test is not "I checked every query". It is: two tenants
loaded, ask each one a question only the *other* can answer, and both must
refuse. That case (`leak-1`) is written in Phase 4 and must stay green forever.

---

## 1. The data model

### 1.1 The new table

```sql
create table tenants (
  id              bigint generated always as identity primary key,
  slug            text        not null unique,   -- the /t/<slug> segment
  business_name   text        not null,          -- "Northwind Labs"
  assistant_name  text        not null,          -- "Nora"
  logo_url        text,                          -- https only, validated on write
  banner_url      text,
  theme           jsonb       not null default '{}'::jsonb,
  admin_key_hash  text,                          -- scrypt; null = nobody can admin it
  created_at      timestamptz not null default now(),

  -- The slug is in a URL, so constrain it in the database rather than trusting
  -- whatever created the row. Lower-case, no dots, no slashes, no leading or
  -- trailing hyphen, 3-32 chars.
  constraint tenants_slug_shape check (slug ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$'),
  -- Slugs that would collide with a route or read as a system page.
  constraint tenants_slug_reserved check (
    slug not in ('api','admin','t','_next','static','new','login','health')
  )
);
```

`theme` is deliberately `jsonb` and deliberately *not* free-form at the point of
use: Phase 7 reads an **allowlist** of keys out of it and ignores everything
else. A theme column that can set any CSS property is a stylesheet the tenant
writes into your page.

### 1.2 `tenant_id` on the four existing tables

```sql
alter table documents     add column tenant_id bigint references tenants(id) on delete cascade;
alter table chunks        add column tenant_id bigint references tenants(id) on delete cascade;
alter table conversations add column tenant_id bigint references tenants(id) on delete cascade;
alter table messages      add column tenant_id bigint references tenants(id) on delete cascade;
```

Then backfill to a single tenant, then `set not null`. **Nullable `tenant_id` is
not an acceptable end state** — `where tenant_id = 3` silently skips every NULL
row, so a forgotten backfill looks like an empty knowledge base rather than an
error.

**Why `chunks` carries it too, when it could join to `documents`.** Both SQL
functions scan `chunks` alone; that is the entire reason they are fast. Joining
to `documents` to discover the tenant of every candidate row defeats the index
before the filter can help. So it is denormalised on purpose — and the
denormalisation is *enforced*, not trusted:

```sql
-- A document is uniquely identified by (id, tenant_id) as well as by id …
alter table documents     add constraint documents_id_tenant_key     unique (id, tenant_id);
alter table conversations add constraint conversations_id_tenant_key unique (id, tenant_id);

-- … which lets the child point at both columns at once. A chunk whose
-- tenant_id disagrees with its document's tenant_id is now IMPOSSIBLE — the
-- insert fails. This is the one guard that does not depend on remembering.
alter table chunks   add constraint chunks_document_tenant_fk
  foreign key (document_id, tenant_id)
  references documents (id, tenant_id) on delete cascade;
alter table messages add constraint messages_conversation_tenant_fk
  foreign key (conversation_id, tenant_id)
  references conversations (id, tenant_id) on delete cascade;
```

That composite foreign key is the most valuable four lines in this plan. Every
other isolation guarantee here is a filter someone has to remember to write;
this one is Postgres refusing.

### 1.3 Indexes

```sql
-- Tenant-scoped lookups.
create index documents_tenant_idx     on documents (tenant_id, created_at desc);
create index chunks_tenant_idx        on chunks (tenant_id);
create index messages_tenant_conv_idx on messages (tenant_id, conversation_id, id);

-- The vector index: UNCHANGED, global, one HNSW graph over all tenants.
-- Phase 2 is entirely about whether that is still the right shape.
```

### 1.4 The two SQL functions

The filter goes **inside**, as `plan/steps.md` § 7 specified:

```sql
create or replace function match_chunks (
  query_embedding vector(1536),
  p_tenant_id     bigint,                  -- no default. See D-027.
  match_count     int   default 5,
  min_similarity  float default 0.3
) ...
  where c.tenant_id = p_tenant_id
    and 1 - (c.embedding <=> query_embedding) >= min_similarity
  order by c.embedding <=> query_embedding  -- still ascending distance. Still the index.
  limit match_count;
```

`p_tenant_id` is second, not last, and has **no default** — a defaulted tenant
parameter is a function that happily searches the wrong tenant when a caller
forgets an argument. Note that Supabase's `.rpc()` passes arguments by name, so
the position is documentation rather than a safety net; the missing default is
the safety net.

`match_chunks_fts` gets the same `and c.tenant_id = p_tenant_id`, and the GIN
index may need to become composite:

```sql
create extension if not exists btree_gin;
create index chunks_tenant_fts_idx
  on chunks using gin (tenant_id, to_tsvector('english', content));
```

Whether that beats the existing single-expression index plus a heap recheck is
a Phase 2 measurement, not a guess. At two tenants it will not matter; the point
of measuring is to know which way it breaks at fifty.

---

## 2. The traps that will actually cost you time

### 2.1 HNSW + a tenant filter is a *post*-filter, and it loses recall silently

This is the one genuinely new failure mode in this plan, and it is the R-3
pattern again: **plausible results, no error.**

An HNSW index has no idea what a tenant is. Postgres walks the graph in distance
order, pulls candidates, *then* throws away the ones failing
`tenant_id = 3`. The graph walk stops after a bounded number of candidates
(`hnsw.ef_search`, default 40). With two tenants that is fine. With fifty, a
question from a small tenant can walk 40 neighbours that all belong to other
tenants and return **zero rows** — which the pipeline faithfully reports as
`[retrieve] vector:0`, the short circuit fires (D-008), and the bot refuses a
question it could answer. Nothing anywhere says "the index gave up".

Three ways out, in order of preference, all measured in Phase 2:

1. **Iterative index scans** (pgvector ≥ 0.8.0): the scan resumes instead of
   giving up. Set it on the function so it cannot be forgotten:
   ```sql
   ... language sql stable set hnsw.iterative_scan = 'relaxed_order';
   ```
   Check what is actually installed first —
   `select extversion from pg_extension where extname = 'vector';`
2. **Raise `hnsw.ef_search`** the same way (`set hnsw.ef_search = '100'`). Buys
   headroom, does not fix the shape, costs latency on every query.
3. **A partial index per tenant.** Perfect recall, and unmanageable past a few
   dozen tenants — every new tenant needs DDL.

**The measurement that decides it**, in Phase 2, with both corpora loaded:
`explain analyze` on `match_chunks` must show `Index Scan using
chunks_embedding_idx` and **not** `Seq Scan on chunks`, and the five chunk ids
it returns for a Phase 0 question must be the same five ids Phase 0 recorded.
Same ids, index still used — otherwise pick option 1 and measure again.

### 2.2 A client-supplied `conversationId` is an unauthenticated read of someone else's transcript

`ensureConversation()` (`packages/rag/src/answer.ts:18`) does this today:

```ts
if (conversationId) return conversationId;   // trusted, unverified
```

Harmless in a single-tenant app. The moment tenants exist it is two holes:

- **History injection.** Post tenant A's conversation uuid to tenant B's chat
  endpoint and A's last six messages are loaded as history and pasted into B's
  prompt. The retrieved chunks are correctly B's; the conversation is not.
- **Transcript read.** `getMessages()` (`packages/rag/src/answer.ts:259`) has no
  tenant filter at all. Any uuid returns its full transcript.

The fix is in Phase 3 and it is not optional: `ensureConversation` must
`select id from conversations where id = ? and tenant_id = ?` and treat a miss
as "start a new conversation" (not as an error — a stale id in a browser tab is
normal), and `getMessages` takes a tenant and filters on it, returning 404 for a
miss. Both get a case in the leakage battery.

### 2.3 `tenant_id` is an argument, not ambient state

There is no request context in `@rag/pipeline` and there must not be one. Every
exported function gains a **required** `tenant` parameter, so that every call
site that forgets is a *compile* error rather than a query against the wrong
rows. Specifically: no `AsyncLocalStorage`, no module-level "current tenant", no
`tenantId = 1` default anywhere in the codebase. `plan/steps.md` § 2.1 made the
`service_role` key structurally unable to reach the browser; this is the same
move applied to the tenant.

### 2.4 Branding is server data becoming markup — and `CLAUDE.md` forbids the obvious way

The instinct for a per-tenant theme is
`<style dangerouslySetInnerHTML={{__html: ':root{--accent:' + theme.accent + '}'}}/>`.
That is CSS injection from a database column, and it is exactly the rule
`CLAUDE.md` § Conventions writes down.

The way that needs no exception: CSS custom properties can be set through
React's ordinary `style` prop, which React escapes for free.

```tsx
// apps/web/app/t/[tenant]/layout.tsx  — no dangerouslySetInnerHTML anywhere
<div className="tenant-root" style={themeVars(tenant.theme)}>{children}</div>
```

`themeVars()` reads an **allowlist** of five keys (`accent`, `accentSoft`, `bg`,
`panel`, `ink`) out of the `jsonb`, validates each against a strict colour regex
with zod, and drops anything that fails. `logo_url` and `banner_url` are
validated as `https:` URLs on write *and* on read — an unvalidated URL in an
`<img src>` is the same class of hole wearing different clothes.

### 2.5 The eval battery's fragile precondition becomes the feature

`CLAUDE.md` rule 1 currently says: load `fixtures/northwind.json` **and nothing
else**, because the Villa documents describe parking and the `absent-2` case
exists to have parking refused. That constraint is a liability — it means the
one test that protects the prompt cannot be run on a database that has real
content in it.

Tenancy deletes the constraint and turns it inside out: load Northwind as tenant
`northwind`, the Villa corpus as tenant `villa`, and `absent-2` now asserts
something far stronger than "parking is absent". It asserts **parking is present
in this database and still unreachable from this tenant.** Amend rule 1 in
Phase 8.

### 2.6 A persona is an invitation to be helpful, and helpful is how refusals die

Phase 5.5 measured that the grounding block, not the threshold, is what stops
invention. Adding *"You are Nora, the assistant for Northwind Labs"* above it
gives the model an identity with a motive: assistants help. The failure will not
look like a hallucination; it will look like a *slightly warmer* answer to
`absent` that quietly includes something the context never said.

Which is why persona lands in its own phase, after the baseline exists, and is
gated on the six Northwind verdicts matching Phase 0 exactly. If persona costs a
refusal, the persona line moves or shrinks — the grounding block does not.

---

## 3. The phases

Nine phases, numbered 0–8. Phases 0–2 touch no application code; if you stop after Phase 2
you have lost nothing and learned whether the index survives.

### Phase 0 — Capture the baseline that was never captured

`status.md` records that Phase 4 of the migration closed on structural parity
because the eval baseline **was never taken**. That was acceptable for a port
that changed no prompt. This plan changes the prompt, so the debt comes due
here, first, before one line of tenancy.

1. Load `fixtures/northwind.json` and nothing else (last time this rule applies).
2. `pnpm eval baseline-pre-tenancy | tee plan/baseline/eval-pre-tenancy.txt`
3. `pnpm scores | tee plan/baseline/scores-pre-tenancy.txt`
4. Record, by hand in the same directory: the five chunk ids `match_chunks`
   returns for two of the eval questions, and the pgvector version.

**Done when:** those three files are committed. The verdict count and the
per-question similarity scores in them are what every later phase is compared
against.

> If the battery does not pass 5/6 today, **stop and find out why before
> starting**. D-017 recorded 5/6 with the sixth being a model limit, not a bug.
> A different number means something already drifted, and diagnosing it
> underneath four tenancy phases is a bad afternoon.

### Phase 1 — Schema and migration

**Goal:** the data model of [§ 1](#1-the-data-model), applied, with existing
data intact and reachable.

1. `packages/db/sql/schema-tenancy.sql` — new file, idempotent, run once in the
   Supabase SQL editor, exactly like its two predecessors. Do **not** edit
   `schema.sql`; it is the record of what the POC was, and `architecture.md` § 4
   cites it.
2. Order matters: `tenants` → seed one row → add nullable columns → backfill →
   `set not null` → unique constraints → composite FKs → indexes → replace the
   two functions.
3. The seed tenant takes the current content: slug `northwind`, business name
   `Northwind Labs`, an assistant name of your choice, no `admin_key_hash` yet.
4. Backfill:
   ```sql
   update documents set tenant_id = (select id from tenants where slug = 'northwind')
     where tenant_id is null;
   -- chunks, conversations and messages likewise
   ```
5. Extend `packages/db/tools/verify.mjs` from 10 checks to 14, all still
   without an OpenAI key:
   - every table has a `tenant_id` and **zero NULLs** in it;
   - the composite FK rejects a mismatched insert (inside a transaction, insert
     a chunk whose `document_id` belongs to another tenant and assert it fails —
     this is the test of § 1.2, and it must *fail* to pass);
   - `match_chunks(<a chunk's own embedding>, <that chunk's tenant>)` still
     returns that chunk at similarity `1.000000`, which was check 8 of the
     existing ten;
   - `match_chunks(<the same embedding>, <a different tenant's id>)` returns
     **zero rows**. That is leakage, caught in SQL, with no API key and no
     model — the cheapest possible version of Rule 2.

**Done when:** `pnpm --filter @rag/db verify` passes 14 checks, and
`select count(*) from chunks where tenant_id is null` is 0.

### Phase 2 — Measure the index before trusting it

**Goal:** know, with `explain analyze` output pasted into `notes.md`, that
retrieval is still indexed and still finds the same chunks.

1. Create tenant `villa` and ingest `sample-documents/` into it, so the database
   holds two corpora with overlapping vocabulary. This is also the fixture every
   later leakage test needs.
2. `select extversion from pg_extension where extname = 'vector';` — record it.
3. `explain analyze select * from match_chunks(<stored embedding>, <northwind id>, 5, 0.25);`
   Look for `Index Scan using chunks_embedding_idx`. A `Seq Scan` here means the
   filter defeated the index and every answer just got slower in a way no test
   would have shown.
4. Compare the five returned chunk ids against Phase 0's recorded ids. Same ids
   = the tenant filter cost nothing at this size.
5. Read § 2.1 and decide: plain post-filter, `hnsw.iterative_scan`, or
   `ef_search`. Apply it inside the function, re-run 3 and 4, and **write down
   the numbers from both runs** — `notes.md` records measured behaviour, and "we
   turned on iterative scan" without a before and after is not a measurement.
6. Same treatment for `match_chunks_fts` and the composite GIN index question.

**Done when:** `notes.md` has a new section with both plans, both id lists, the
pgvector version, and one sentence saying which option was chosen and why.

### Phase 3 — Thread the tenant through `@rag/pipeline`

**Goal:** every database call in the pipeline is tenant-scoped, and no call site
can compile without saying which tenant.

1. New type in `packages/rag/src/types.ts` — the pipeline's view of a tenant,
   which is narrower than the table:
   ```ts
   /** What the pipeline needs to know about a tenant. Never the admin hash. */
   export interface TenantContext {
     id: number;
     slug: string;
     businessName: string;
     assistantName: string;
   }
   ```
   It is a *value object*, not a row: `admin_key_hash` must not be in a type the
   pipeline hands around, so it cannot end up in a JSON response by accident.
2. Signatures, all with `tenant` **required and first**:
   `ingestDocument({ tenant, title, source, content })`, `listDocuments(tenant)`,
   `deleteDocument(tenant, id)`, `getChunks(tenant, documentId)`,
   `retrieve(tenant, question, questionVector)`,
   `answerQuestion({ tenant, conversationId, message })`,
   `answerQuestionStream({ tenant, … })`, `getMessages(tenant, conversationId)`.
3. Every `supabase.from(...)` in `ingest.ts` and `answer.ts` gains
   `.eq('tenant_id', tenant.id)` — including the two writes, which need
   `tenant_id` in the inserted row, and including the document-title lookup in
   `prepareAnswer` step 7 (a title is not a secret, but a *title from another
   tenant* rendered in the sources panel is).
4. Both `.rpc()` calls pass `p_tenant_id: tenant.id`.
5. Fix § 2.2: `ensureConversation(tenant, conversationId)` verifies ownership and
   falls back to creating a new row on a miss; `getMessages` filters and
   distinguishes "no messages" from "not your conversation".
6. `deleteDocument` returning false must mean "not yours **or** not there" —
   deliberately indistinguishable, because a 404 that means "exists but belongs
   to someone else" is an enumeration oracle.
7. Re-run `tools/parity.mjs` with `tenant` bound to `northwind`. All 22
   comparisons must still hold: tenancy is a filter, not a behaviour change.

**Done when:** `pnpm typecheck` is clean, `pnpm test` passes, parity is 22/0
against Phase 0, and
`grep -n "from('chunks')\|from('documents')\|from('messages')\|from('conversations')\|rpc(" packages/rag/src/*.ts`
shows a tenant filter on **every** line it prints. Do that grep and read it. It
is thirteen lines and it is the whole of Rule 2 in code form.

### Phase 4 — Persona, then measure

**Goal:** the bot introduces itself as the tenant's assistant, and the six
Northwind verdicts are unchanged.

1. `buildPrompt(tenant, chunks, history, question)` — one block **above** the
   existing system content, which is not touched:
   ```
   You are {assistantName}, the assistant for {businessName}.
   ```
   Plus, optionally, one sentence tying the persona to the refusal rather than
   against it — something like *"Answer only from the context below, even when a
   more helpful answer seems obvious."* Whether that sentence earns its place is
   what the next step measures; if the verdicts are identical without it, leave
   it out.
2. `greetingReply(message, tenant)` — still pure, still no I/O. The canned reply
   names the assistant and the business, and keeps the part that tells a
   first-time user what the thing is *for* (D-024's actual point).
3. Rewrite the battery, `packages/rag/tools/prompt-eval.mjs`:
   - each case gains a `tenant` field;
   - the six existing cases run against `northwind`, unchanged in wording;
   - **new `leak-1`**: ask `northwind` *"How many parking spaces does the
     building have?"* with the Villa corpus loaded in `villa`. Must refuse. This
     is `absent-2` promoted from "the fact is absent" to "the fact is in this
     database and unreachable";
   - **new `leak-2`**: a Villa-specific identifier (a rate, a booking code)
     asked of `northwind`. Must refuse. Keyword search is the path vector search
     would not have found, so this case exercises `match_chunks_fts`
     specifically — the function most likely to have been fixed second;
   - **new `leak-3`**: `getMessages` for a `villa` conversation id, asked as
     `northwind`. Must return nothing. Not a prompt test, but it belongs with
     the others because it is the same assertion;
   - **new `persona`**: greet `villa` and assert the reply contains that
     tenant's assistant name and not the other's.
4. `pnpm eval after-persona | tee plan/baseline/eval-post-persona.txt` and
   **diff it against Phase 0 verdict by verdict.**

**Done when:** the six original cases return the same verdicts as
`plan/baseline/eval-pre-tenancy.txt` — same passes, same refusals — and the four
new cases pass. A single flipped verdict means the persona wording is wrong, not
that the battery is too strict. Fix the persona.

### Phase 5 — Routes

**Goal:** the six endpoints become tenant-scoped, and an unknown tenant is a
404 rather than a default.

1. `apps/web/lib/tenant.ts`, `server-only`:
   ```ts
   /** The tenant for a slug, or null. Wrapped in React cache() so one request
    *  that needs it three times costs one query. */
   export const getTenant = cache(async (slug: string): Promise<TenantContext | null> => …);
   ```
   It selects the pipeline's four fields **explicitly**. Never `select('*')` —
   that is how `admin_key_hash` gets into a response.
2. Move the routes to `app/api/t/[tenant]/…`: `chat`, `documents`,
   `documents/[id]`, `documents/[id]/chunks`, `conversations/[id]/messages`, and
   the new `admin/session` from Phase 6.
3. `withRoute()` is unchanged — but every handler now starts with the same three
   lines, and the cheapest way to not forget them is a small wrapper beside it:
   ```ts
   export const POST = withTenantRoute(async (request, { tenant }) => …);
   ```
   `withTenantRoute` resolves the slug, 404s on a miss, and hands the handler a
   `TenantContext`. Same argument as `withRoute` itself: nothing enforces it, so
   it has to be trivial to apply and obvious when absent.
4. **No default tenant, and no redirect from the old paths.** `/api/chat` 404s.
   A compatibility shim that picks a tenant when the URL does not name one is
   the exact mechanism by which tenant A's question gets answered from tenant
   B's documents, and it would be enabled by default.
5. Update the `curl` examples in `README.md` in the same commit. They are the
   documented contract and they all just changed.

**Done when:** `curl localhost:3000/api/t/northwind/documents` lists only
Northwind's documents, `/api/t/villa/documents` only Villa's, and
`/api/t/nope/documents` is a 404 with a real message.

### Phase 6 — Admin auth

**Goal:** editing a tenant's knowledge base requires that tenant's key, and the
key is never stored in plaintext or logged.

1. `.env` gains `ADMIN_COOKIE_SECRET` and it joins the `REQUIRED` list in
   `apps/web/lib/env.ts`, which gives it the D-023 treatment for free: one clear
   sentence at import, thrown per request.
2. `apps/web/lib/admin-auth.ts`, `server-only`, `node:crypto` only:
   - `hashAdminKey(key)` → `scrypt` with a random 16-byte salt, stored as
     `scrypt$<N>$<salt-b64>$<hash-b64>` so the parameters travel with the hash
     and can be raised later without a migration;
   - `verifyAdminKey(key, stored)` → `timingSafeEqual`, never `===`;
   - `signSession(slug, expiresAt)` → `<slug>.<expiry>.<hmac-sha256>` over
     `ADMIN_COOKIE_SECRET`;
   - `readSession(request, tenant)` → verifies the HMAC **and** that the slug in
     the cookie matches the tenant in the URL. A valid cookie for another tenant
     is not a valid cookie.
3. The cookie: `httpOnly`, `sameSite: 'lax'`, `secure` outside development,
   **`path: '/t/<slug>'`**. That path is not cosmetic — the browser will not
   send this cookie to another tenant's pages at all, which makes the mistake in
   step 2's last bullet impossible for a whole class of requests.
4. `POST /api/t/[tenant]/admin/session` logs in, `DELETE` logs out.
   `requireAdmin(request, tenant)` guards `POST`/`GET /documents`,
   `DELETE /documents/[id]` and `GET /documents/[id]/chunks` — a 401 with a real
   message, via the existing error map.
   **The chat route stays open.** It is the product.
5. `admin_key_hash is null` means **no admin access**, not open access. A tenant
   created without a key has a knowledge base nobody can edit until a key is
   set. Default-deny, because the other default is one forgotten column away
   from an open admin panel.
6. `packages/db/tools/tenant.mjs` (`pnpm --filter @rag/db tenant:add`), carrying
   `--conditions=react-server` like every other script that touches `@rag/db`
   (rule 4). It creates a tenant, generates a 32-byte key,
   **prints it exactly once**, and stores only the hash. A "recover the key"
   feature is a "read the key" feature.

**Done when:** the admin page demands a key, the wrong key gives a 401, a
`villa` cookie does nothing at `/t/northwind/admin`, and
`grep -ri "admin_key" apps/web/.next/static/` returns nothing — the rule 2 grep,
applied to the new secret.

### Phase 7 — The screens

**Goal:** two tenants, visibly different, no shared state between them.

1. Move `app/page.tsx` → `app/t/[tenant]/page.tsx` and `app/admin/page.tsx` →
   `app/t/[tenant]/admin/page.tsx`. Both stay Client Components; the tenant's
   branding is fetched in a **Server Component layout** and passed down as
   props, which is also what keeps `@rag/db` out of the client bundle.
2. `app/t/[tenant]/layout.tsx` — `getTenant()`, `notFound()` on a miss, and the
   `themeVars()` wrapper from § 2.4. `generateMetadata()` sets the tab title to
   the business name.
3. Header: logo or banner if present, business name, assistant name on the
   assistant's turns. `globals.css` needs no rewrite — every colour it uses is
   already a custom property, which is why the allowlist in § 2.4 is five keys
   and not fifty.
4. Every `fetch` in both pages gets the `/api/t/<slug>` prefix. The slug comes
   from props, never from `window.location` parsing.
5. `app/page.tsx` (the root) becomes a plain static page that says what this is
   and links nowhere in particular. **It does not redirect to a tenant** and it
   does not list them — a tenant directory is a customer list.
6. `app/t/[tenant]/not-found.tsx` — "no such workspace", no hint about which
   slugs exist.
7. Walk both tenants in a real browser, the way Phase 6 of the migration was
   signed off: ask each one its own question, ask each one the *other's*
   question, add and delete a document in each, confirm the sources panel never
   shows the other tenant's document title.

**Done when:** `/t/northwind` and `/t/villa` are recognisably different products
answering from different documents, and the § 2.5 leakage walk passes by hand as
well as in the battery.

### Phase 8 — Cutover and the record

The phase that stops the repo from lying to whoever opens it next.

1. `CLAUDE.md`: amend rule 1 (§ 2.5 — the battery now *wants* two corpora
   loaded, one per tenant), add a rule for Rule 2 of this plan, and add the
   `tenant_id` filter requirement to § Conventions.
2. `architecture.md` § 4 — the schema section, now five tables.
3. `decisions.md` — D-025 … D-030 from [§ 5](#5-decisions-to-log).
4. `risks.md` — R-10 … R-13 from [§ 6](#6-what-this-does-not-fix).
5. `notes.md` — Phase 2's measurements, and the persona before/after.
6. `flow.md` — the diagram gains "resolve tenant" as its first step.
7. `status.md` and `whats-done.md`, per `CLAUDE.md` § Keeping the record: tick
   it, rewrite "▶ Next up", append to the session log, and write down what each
   observed value proves and which trap it avoided. **Real values only.**
8. `README.md` — the curl examples, the setup steps (three SQL files now), and
   `tenant:add` before "add a document".

**Done when:** a fresh reader can go from `git clone` to two working tenants
using only `README.md`, and every number in the docs is one that was observed.

---

## 4. Order, and what depends on what

```
Phase 0  baseline ─┐
                   ├─> 1 schema ──> 2 index ──> 3 pipeline ──> 4 persona+eval ──> 8 record
                   │                                 │
                   └─────────────────────────────────┴──> 5 routes ──> 6 auth ──> 7 screens ──> 8
```

- **0 before 4**, or the persona change is unmeasurable. This is the hard one.
- **1 before 2**, and **2 before 3**: no point threading a tenant through
  thirteen queries to discover the vector index stopped being used.
- **5 before 6 before 7**: auth needs the routes, the screens need the auth.
- **3 before 5**: the routes call the pipeline, not the other way round.
- Phases 4 and 5–7 are independent once 3 lands. Do 4 first anyway — it is the
  one that can send you back to Phase 3.

---

## 5. Decisions to log

Full entries go in `decisions.md` in Phase 8, in the house format (context,
decision, why, what it costs, what would reverse it).

| | Decision | The short reason |
|---|---|---|
| **D-025** | Shared tables with `tenant_id`, filter pushed inside both SQL functions | One schema, one HNSW graph, one migration. Schema-per-tenant would mean N migrations and N index builds for a product whose whole pitch is "add a business in a minute" |
| **D-026** | A tenant is a path segment `/t/<slug>`, not a subdomain | Identical locally and hosted, no wildcard DNS or cert. Resolution is one function, so subdomains later are one file |
| **D-027** | `tenant` is a required parameter everywhere; no default, no ambient context | A default tenant is a silent cross-tenant read. Required means the compiler finds every call site — the same move as `server-only` made for the service-role key |
| **D-028** | Per-tenant admin key, scrypt-hashed, behind a path-scoped signed cookie; hand-rolled | D-001/D-002 still hold. It is ~80 readable lines of `node:crypto` versus an auth framework's worth of concepts, and it is explicitly **not** a replacement for RLS (R-2) |
| **D-029** | Persona above the grounding block, which stays byte-identical, gated on the battery | D-017's wording was measured. A persona is the smallest change that gives each tenant an identity, and the battery is what says whether it cost a refusal |
| **D-030** | Branding applied as CSS custom properties through React's `style` prop, from an allowlist | Keeps the no-`dangerouslySetInnerHTML` rule intact with no exception, and bounds what a `theme` column can do to the page |

Also amend **D-006** (service-role key, no RLS policies): its reasoning was "the
server is the only client of this database". Still true, but the server now
serves mutually distrusting tenants, so the posture's weak point moved from the
network into the application code. Say so where the decision is recorded.

---

## 6. What this does not fix

New entries for `risks.md`:

| | Risk | Honest assessment |
|---|---|---|
| **R-10** | HNSW post-filtering loses recall as tenants multiply | Invisible: a false refusal, not an error. Phase 2 measures it at two tenants and picks a mitigation; **re-measure at ten and at fifty.** The symptom to watch for in the logs is `[retrieve] vector:0` on a question that should hit |
| **R-11** | Isolation is enforced by application code, not by the database | `service_role` bypasses RLS; the composite FKs of § 1.2 protect *writes*, but every read is a filter someone remembered. `leak-1`/`leak-2`/`leak-3` are the only thing that will catch a regression. R-2 is now a bigger deal than it was, not a smaller one |
| **R-12** | A persona erodes refusals over time | Every future prompt edit re-opens this. Phase 4's gate is the mechanism; `CLAUDE.md` rule 1 is what keeps it applied |
| **R-13** | No rate limit on the admin key | A 32-byte key is not brute-forceable, but nothing here throttles attempts or logs failures. Deliberate — no retry loops, no in-memory state (`architecture.md` § 9) — and the first thing to add if this is ever public |

Explicitly still missing after this plan: RLS policies, tenant self-signup,
per-tenant OpenAI keys or spend caps, usage metering, audit logging of admin
actions, and any way for a tenant to export or delete everything they own.

---

## 7. What this unblocks

Each one is a plan of its own, and each is cheaper after this one:

| Want | The seam this plan leaves | Where it lands |
|---|---|---|
| Messenger integration (`todo.md`) | A page id maps to a tenant slug; the webhook resolves a `TenantContext` and calls the same `answerQuestion({ tenant, … })`. This is the monorepo argument, finally paying | `apps/messenger/` |
| Tool calls for dynamic data (`todo.md`) | Tools are per-tenant config, so they belong in a `tenants.tools` column and a `chat()` `tools` parameter. **Re-run the battery** — a bot that can call a tool can also answer from training data while looking grounded | `@rag/pipeline` |
| Google Analytics (`todo.md`) | One script in the tenant layout, with the tenant slug as a dimension. Question text is user content: do not ship it to a vendor without deciding that on purpose | `apps/web` |
| Record unanswered questions (`todo.md`) | The refusal path is already a single short circuit (D-008) and already knows its tenant. One insert into an `unanswered` table, per tenant, is most of the feature — and it is the highest-value analytics in the product | `@rag/pipeline` |
| Tagalog greetings (`todo.md`) | `greeting.ts` already says where to add them, and is already per-tenant after Phase 4. Add a `locale` to `tenants` and the greeting list becomes per-locale | `@rag/pipeline` |
| Real auth and RLS | D-028's cookie is the thing to delete. Tenant membership becomes a users table, RLS policies replace the code filters, and the `service_role` key leaves the read path | Its own plan, and the right time is before a public URL |

Start one only after Phase 8 is committed and the battery matches.
