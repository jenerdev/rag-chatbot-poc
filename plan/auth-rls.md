# Auth + RLS plan — make the database enforce the tenant

> **Status: Phases 0–8 done, 2026-09-26** (commits `6a48801` … Phase 8).
> Three email-dependent checks are owed to Supabase's built-in sender cap
> (R-21): the northwind invite, walk step 6 in the browser (proven over HTTP
> by `staff-cases.mjs`), and the "Forgot password?" email. The record is in
> `whats-done.md` § "Auth + RLS Phase 0" onwards.

> Replace "every query uses a master key and remembers a filter" with "every
> request reaches Postgres as a narrow identity that can only see one tenant",
> and replace the shared per-tenant admin key with real staff accounts.
>
> Written 2026-09-24, against commit `851c517` on `feat/auth-rls`, after
> tenancy ([`plan.md`](../plan.md)) and bookings
> ([`plan/bookings.md`](./bookings.md)) were complete. This is the fix that
> D-006, D-028, R-2, R-11 and R-13 all point at, and it comes **before any
> public URL**. Read [§ 0](#0-the-three-rules) first, then
> [§ 2.1](#21-the-signing-question-decides-the-architecture), which Phase 0
> has to settle before anything else is built.

---

## What this plan covers

| | |
|---|---|
| **In scope** | RLS policies on all ten tables, keyed on a tenant claim; a short-lived, server-minted **tenant token** on every request, including anonymous chat, so Postgres enforces isolation on every read; `service_role` removed from the request path (tools and migrations keep it); staff accounts through **Supabase Auth** (email + password), a `memberships` table, one role (member = admin); login, logout, password reset, and a CLI to add and remove members; removing the per-tenant admin key; tests that prove each of the two walls (code filters, RLS) holds **on its own** |
| **Out of scope** | Guest accounts, and the `request_booking` tool that needs them (`plan/bookings.md` § 7); owner and staff roles; an invite UI (the CLI does it); MFA and SSO; an audit log of admin actions; per-visitor transcript privacy (§ 6); custom SMTP setup, which is a **prerequisite for real staff** but is configuration, not code; deployment itself |

**Three decisions, asked and answered before writing this** (all in [§ 5](#5-decisions-to-log)):

1. **Staff log in with Supabase Auth.** Email + password accounts, with
   password reset and email verification from Supabase. A `memberships` table
   links users to tenants. The first deviation from "hand-roll everything"
   (D-001, D-028), and the reason is sound: password storage, reset tokens
   and email verification are exactly the parts where a readable hand-rolled
   version is also the dangerous one.
2. **RLS covers the anonymous chat path too.** The server mints a
   short-lived token carrying the tenant for **every** request, so the most
   exposed path, open to the internet, gets the database's protection, not
   only the application's.
3. **One role.** Anyone who is a member of a tenant can manage its documents
   and bookings. A `role` column can come later.

---

## 0. The three rules

### Rule 1 — Two walls, and each one is tested on its own

After this plan, a cross-tenant read has to get past two independent checks:

1. **the `tenant_id` filters in application code**, which stay, all of them;
2. **RLS policies in Postgres**, keyed on the token's tenant claim.

"Both are present" is not the acceptance test. The acceptance test is that
**each wall stops a leak with the other one removed**:

- **RLS alone:** a query run under tenant A's token with **no** `tenant_id`
  filter, such as `select * from chunks`, returns only A's rows.
- **Filters alone:** the existing `isolation.mjs` suites still pass. They
  are the proof that the filters were never the thing being relied on by
  accident.

A wall that is never tested alone is a wall nobody knows is there.

### Rule 2 — `service_role` leaves the request path, and a build check says so

Today every query in `apps/web` runs with the `service_role` key, which
bypasses RLS. After this plan:

- **`apps/web` never holds a client that bypasses RLS.** Every request uses a
  client built from the publishable key plus a tenant token.
- **The bypass client moves to a separate entry point,**
  `@rag/db/service`, imported only by `tools/` scripts and SQL-adjacent
  tooling. A check fails the build if anything under `apps/` or
  `packages/*/src` imports it (Phase 6).
- **The honest limit:** whatever signs tenant tokens is itself a master key.
  It can mint any claim, including `service_role` (§ 2.2, R-19). The gain is
  that the app uses it in one function, to mint one shape of narrow token,
  rather than every query holding the master key directly.

### Rule 3 — No prompt changes, so the battery must match exactly

This plan changes no prompt and no retrieval number. The eval must give
**18/19** (`original 9/10 · tool 9/9`), identical verdict by verdict to the
Phase 0 baseline. `prompt-snapshot` must be byte-identical. **Any flipped
verdict means a query now returns different rows**, most likely a policy that
is too strict, and it is a bug to find, not noise to rerun away.

---

## 1. The data model

### 1.1 One new table

```sql
-- Who may administer which tenant. One role for now (decision 3): a row IS admin.
create table memberships (
  user_id    uuid   not null references auth.users(id) on delete cascade,
  tenant_id  bigint not null references tenants(id)    on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, tenant_id)
);
```

A user may belong to several tenants. That supports one person running two
businesses, and it is also why the session carries the tenant as well as the
user.

`tenants.admin_key_hash` is **dropped in Phase 6**, after the new login works,
and not before. Until then both logins exist.

### 1.2 The claims, and two helper functions

Every tenant token carries:

| Claim | Chat token | Staff token | Why |
|---|---|---|---|
| `role` | `authenticated` | `authenticated` | the Postgres role PostgREST switches to. Never `service_role`: the signer refuses to mint it |
| `tenant_id` | the tenant | the tenant | what every policy compares against |
| `sub` | **absent** | the staff user's uuid | `auth.uid()` casts `sub` to uuid. A non-uuid string errors (§ 2.4) |
| `app_admin` | absent | `true` | write policies need it, AND a membership row (below) |
| `exp` | now + 5 min | now + 5 min | outlives a 60-second streamed answer; short enough that a leaked token dies quickly |

```sql
create function app_tenant_id() returns bigint
language sql stable
as $$ select nullif(auth.jwt() ->> 'tenant_id', '')::bigint $$;

-- Admin = the token says so AND the database agrees. A server bug that mints
-- app_admin for the wrong tenant still cannot write, because the membership
-- row is not there.
create function app_is_admin() returns boolean
language sql stable security definer set search_path = ''
-- (Built as security INVOKER in Phase 1, to match D-042's "exactly two
-- definer functions": the memberships policy already lets a user read
-- their own rows. See whats-done.md, auth-rls Phase 1.)
as $$
  select coalesce((auth.jwt() ->> 'app_admin')::boolean, false)
     and exists (
       select 1 from public.memberships m
       where m.user_id = auth.uid() and m.tenant_id = public.app_tenant_id()
     )
$$;
```

A missing claim is `null`, and `null = x` is never true, so **every policy
defaults to deny.** That is the property to keep. `coalesce` on the boolean
makes it explicit.

### 1.3 The policies

RLS is already **enabled** on every table with **no** policies (D-006). This
plan writes the policies. Service tools keep working throughout, because
`service_role` bypasses RLS. So Phase 1 can be applied with the app
unchanged.

| Table | Read | Write | Notes |
|---|---|---|---|
| `tenants` | **no direct access** | none | chat and pages resolve a slug through `tenant_public(slug)`, a `security definer` function returning only the public columns (id, slug, names, logo, banner, theme). The column list is in the function, so no token can ever read `admin_key_hash` |
| `documents` | `tenant_id = app_tenant_id()` | insert/delete: `app_is_admin()` (as built: **and** the tenant match, on every write policy) | chat reads titles for the sources panel |
| `chunks` | `tenant_id = app_tenant_id()` | insert: `app_is_admin()` | deletes cascade from `documents`. FK actions do not go through RLS |
| `conversations`, `messages` | tenant match | insert: tenant match | the open chat writes these |
| `tenant_applications`, `units`, `slots` | tenant match | none (seeded by SQL) | the tool description reads slot names |
| `bookings` | `app_is_admin()` **only** | insert/update: `app_is_admin()` | **the chat token cannot read a single booking row** (§ 2.5) |
| `memberships` | `user_id = auth.uid()` | none | added and removed by the CLI with `service_role` |

**Function changes:**
- **`check_availability`** becomes `security definer`, with
  `set search_path = ''`. It raises if `p_tenant_id <> app_tenant_id()`, so a
  chat token can ask about availability without having SELECT on `bookings`
  (§ 2.5).
- **`match_chunks` and `match_chunks_fts`** stay `security invoker`, so RLS
  on `chunks` applies inside them. Their `p_tenant_id` filter stays too
  (Rule 1).

---

## 2. The traps that will actually cost you time

### 2.1 The signing question decides the architecture

The whole plan rests on the server minting a token that PostgREST accepts.
**This project's `.env` holds `SUPABASE_PUBLISHABLE_KEY`,
`SUPABASE_SECRET_KEY` and `SUPABASE_JWKS_URL`.** So it uses Supabase's newer
API keys and **asymmetric JWT signing keys**, where Supabase holds the private
key. A server cannot sign with a key it does not have.

Phase 0 finds out which of these is true, in this order of preference, and
records the answer in D-039:

| Option | How it works | Check in Phase 0 |
|---|---|---|
| **A. Our own signing key, trusted by the project** | generate an EC P-256 key pair; register it with the project as a signing key, if the dashboard allows importing one; sign ES256 with `node:crypto`. PostgREST verifies against the project's JWKS as it does for Supabase's own tokens | does the JWT signing keys page offer importing a private key? After importing, does a token we sign pass `select auth.jwt()` through PostgREST? |
| **B. The legacy shared secret** | sign HS256 with the legacy JWT secret, if the project still accepts it | is the legacy secret listed as in use (not revoked)? Does an HS256 token pass? **Even if yes:** Supabase is moving projects off it, and the day it is revoked every request fails at once. Acceptable only as a bridge, with a date |
| **C. No token at all: a direct Postgres connection** | connect through the pooler, and per transaction `set local role authenticated` plus `set_config('request.jwt.claims', '<claims>', true)`. `auth.jwt()` reads exactly that setting, so the same policies apply | pooler reachability (`database.types.ts` records that the direct host is IPv6-only). Costs a `pg` dependency, and rewrites every supabase-js query as SQL. The largest change of the three |

**If none works, stop and re-plan.** Do not fall back quietly to
`service_role` "for now". That is the posture this plan exists to end.

### 2.2 The signing key is a master key too

Anyone holding the signing key (A or B) can mint a token claiming anything,
including `role: service_role`. So:
- the minting function refuses any `role` other than `authenticated`;
- the key is a server-only environment variable, with the same rule as
  today's service key (CLAUDE.md rule 2), and the bundle grep adds its name;
- R-19 says plainly what this does not fix.

The improvement is real, but it is not "no master key". It is "the master key
is used in one function, for one narrow token".

### 2.3 RLS can quietly cost the vector index

RLS policies are applied as security-barrier quals. A policy that calls a
function Postgres cannot prove is *leakproof* can change what the planner is
willing to push down or use an index for. Correct results, and a slower plan.
This is the same failure shape as tenancy's § 2.1. **Measure it the same
way** (Phase 2): `explain analyze` of `match_chunks` **as a tenant token**,
not as `service_role`. Service role bypasses RLS, so measuring with it
measures nothing.

### 2.4 `auth.uid()` on a chat token

`auth.uid()` is `(auth.jwt() ->> 'sub')::uuid`. A chat token with `sub:
"chat"` makes every policy that touches `auth.uid()` **raise an error**
instead of returning false. So chat tokens carry **no `sub` at all**, which
gives null and a policy that is simply false. Test it: a chat token calling
`app_is_admin()` must return `false`, not an error.

### 2.5 `check_availability` must not need the bookings table

Today `check_availability` is `security invoker`. Under RLS, a chat token
would need SELECT on `bookings` for the function's `exists` check to see
anything. That token would then be able to read guest names and phones with a
plain `select`, if it ever leaked out of the server. Rule 3 of the bookings
plan was about the result shape. This keeps the **row access** closed too:
the function runs as its owner, checks the tenant claim itself, and returns
only open/taken.

### 2.6 Supabase's built-in email will not carry real staff

Invites and password resets go by email. Supabase's default sender is
rate-limited and meant for testing. The flows can be built and tested
against it, but **custom SMTP is a prerequisite before real staff are
invited.** It is configuration, and it is listed in § 6 so it is not
forgotten.

### 2.7 The eval and the tools need identities too

Today the eval and the isolation scripts call the pipeline with a
`TenantContext` from `loadTenant()`, using the service key underneath. After
Phase 3 a context carries its own scoped client:
- questions will go through **chat tokens**, exactly as the app does;
- the fixture seeding, and isolation's ingest probe, need **staff tokens**,
  and a staff token needs a real member (a `sub` with a `memberships` row).

So Phase 5 adds `tools/member.mjs`, and the tools use a dedicated, documented
**operator** member per tenant, whose token they mint the same way the app
does. The tools do not quietly keep `service_role` for things the app has to
do with a token.

---

## 3. The phases

Nine phases, numbered 0–8. Phases 0–2 change no application code. Phase 1's
policies are harmless to the running app, which still bypasses them. If you
stop after Phase 2, you know whether the design works and what it costs.

### Phase 0 — The signing spike, and the baseline

1. **The spike (§ 2.1).**
   - Create a throwaway function: `create function whoami() returns jsonb
     language sql stable as $$ select auth.jwt() $$;`.
   - Try option A, then B. For each: sign a token with
     `{role: authenticated, tenant_id: 3, exp: +5min}`, call
     `POST /rest/v1/rpc/whoami` with `apikey: <publishable key>` and
     `Authorization: Bearer <token>`, and record the exact response.
   - Try C only if A and B both fail.
   - **Done when:** one option returns the claims back from Postgres. The
     result goes into D-039, with the evidence.
2. **Supabase Auth check.**
   - Email + password provider enabled.
   - Create a throwaway user in the dashboard, and sign in with supabase-js
     `auth.signInWithPassword` using the publishable key.
   - Record the access token's `iss`, `aud`, `role` and `sub`, and the
     sign-in rate limit shown in the dashboard (R-13's partial answer).
3. **Baseline**, saved to `plan/baseline/*-pre-auth.txt`:
   - eval, expect 18/19;
   - isolation, expect 11/11;
   - bookings isolation, expect 12/12 (the plan said 13; the script has 12 checks, see Phase 0 in whats-done.md);
   - verify, expect 28/28;
   - `prompt-snapshot` for northwind;
   - `explain analyze` of `match_chunks` for villa as `service_role`.

**Done when:** the spike has an answer, and the baseline files are
committed. If the spike fails in all three ways, **stop here**.

### Phase 1 — Policies and memberships

1. `packages/db/sql/schema-auth.sql`, idempotent, run in the SQL editor:
   - `memberships`;
   - `app_tenant_id()` and `app_is_admin()`;
   - every policy in § 1.3;
   - `tenant_public(slug)`;
   - the `check_availability` rewrite;
   - `grant execute` only to `authenticated`, and `revoke` from
     `anon`/`public` where Postgres grants by default.
2. `database.types.ts`: `memberships`, `tenant_public`, `whoami` if kept.
3. `verify.mjs`, extended. It mints tokens itself with the signer from
   Phase 0, and creates and deletes its own probe tenants and member:
   - **the RLS-alone check (Rule 1):** a chat token for villa runs
     `select id, tenant_id from chunks` with **no filter**, and every row
     returned is villa's;
   - the same for `documents`, `conversations` and `messages`;
   - chat token → `bookings`: **0 rows**; inserting a booking fails;
   - chat token → `check_availability(villa)` works; with northwind's id it
     raises;
   - staff token for a user with **no** membership → document insert fails;
     with a membership → it succeeds;
   - a staff token for a member of A whose `tenant_id` claim says B, which
     simulates a minting bug → **every write fails**, because
     `app_is_admin()` finds no membership for B. Its reads would see B's
     chat-level rows. That is no more than B's public chat can already read,
     and it is why `bookings` reads need `app_is_admin()`, not just a
     tenant match;
   - chat token → `app_is_admin()` is `false`, not an error (§ 2.4);
   - `tenant_public('villa')` → keys exactly the public columns;
   - a real Supabase Auth user token (Phase 0 step 2) run directly against
     `chunks` → 0 rows, because it has no `tenant_id` claim.

**Done when:** verify passes (28 + the new checks), and the app, which is
unchanged and still on `service_role`, still passes the eval. Policies must
cost the running app nothing yet.

### Phase 2 — Measure the index under RLS

`explain analyze` of `match_chunks` and `match_chunks_fts` for villa, **run
as a chat token**, not as `service_role` (§ 2.3). Compare with the Phase 0
plan and ids:
- **same chunk ids:** nothing to do;
- **a `Seq Scan` where there was an index:** fix it before Phase 3, for
  example by marking helper functions `leakproof` where that is true, or by
  restating the policy.

**Done when:** `notes.md` has both plans, both id lists, and one sentence
saying what was chosen.

### Phase 3 — Tenant tokens and scoped clients

1. **`@rag/db`:**
   - **`mintTenantToken({ tenantId, userId?, admin? })`** implements the
     option from Phase 0, hand-rolled on `node:crypto` (D-002's spirit), in
     about 30 lines. It refuses any role but `authenticated`, and a 5-minute
     `exp`.
   - **`scopedClient(token)`** returns supabase-js with the publishable key
     and `Authorization: Bearer <token>`.
   - **The bypass client moves to `@rag/db/service`.** The main entry point
     no longer exports `supabase`, so every existing import becomes a
     compile error, which is how every call site gets found.
2. **`TenantContext` gains `db`**, the scoped client for this request.
   `BookingTenant` gains it too. Every `supabase.from(…)` in
   `@rag/pipeline` and `@rag/bookings` becomes `tenant.db.from(…)`. The
   `tenant_id` filters **stay** (Rule 1).
   - The consequence worth noticing: D-027 said a forgotten tenant should be
     a compile error. Now a forgotten tenant also means no database at all.
   - **`db` must never reach a Client Component.** Pages already pass named
     props, not the context. Phase 7's bundle grep checks it.
3. **`loadTenant` → `tenant_public(slug)`**, through a client with no claims.
   It is callable because it is `security definer`, and it returns no hash
   column to leak.
4. **Tools and tests:** `@rag/db/service` for setup only. What the tools
   test runs through tokens (§ 2.7).

**Done when:** typecheck is clean, and `grep -rn "@rag/db/service"
apps packages/*/src` prints nothing.

### Phase 4 — The chat path on chat tokens

1. `withTenantRoute` resolves the tenant and attaches a **chat** context.
   Every route gets one, so every request is on RLS from here on, including
   the admin routes until Phase 5 upgrades them.
2. The chat route, the transcript route and the tool executor all run on the
   chat token. `check_availability` works through `security definer`, and
   `listSlots` works through the `slots` read policy.
3. **Measure, with no change expected:**
   - eval 18/19, the same verdict for each case as Phase 0;
   - isolation 11/11;
   - bookings isolation 12/12;
   - `prompt-snapshot` byte-identical.

   **A single flipped verdict is a policy that is too tight** (Rule 3).

**Done when:** all four match. `SUPABASE_SERVICE_ROLE_KEY` is then unset in
the web process, with a restart, and chat still works. That proves no chat
code path needs it.

### Phase 5 — Staff accounts

1. **Login:** `POST /api/t/<slug>/admin/session` takes `{ email, password }`.
   - Supabase Auth `signInWithPassword` with the publishable key.
   - Then a membership check for that user and this tenant.
   - Then **our** session cookie, the same HMAC cookie as D-028, carrying
     `<slug>.<userId>.<expiry>.<mac>`.
   - A wrong password, an unknown email and "not a member of this tenant" all
     give **the same 401 message**, so an attacker learns nothing about which
     emails exist or who belongs where.
2. **`requireAdmin()`** reads the cookie and **re-checks the membership on
   every request**, then mints a **staff** token (`sub` = the user,
   `app_admin`). Removing a member takes effect on their next request, not
   when the cookie expires.
3. **Reset:**
   - "Forgot password" calls `resetPasswordForEmail`, redirecting to
     `/t/<slug>/admin/reset`.
   - That page takes the recovery session from the link and calls
     `updateUser({ password })`.
   - The reset page is the only Client Component that ever holds a Supabase
     Auth session, and only for that one call.
4. **`tools/member.mjs`:**
   - `member:add <slug> <email>` invites the user if they are new (the admin
     API, with `service_role`, in a tool) and inserts the membership.
   - `member:remove <slug> <email>`.
   - `member:list <slug>`.
   - It prints no password and no token.
5. **The screens:** the admin login form becomes email + password, with
   "Forgot password?". The two admin screens are otherwise unchanged.
6. **The tools' operator member (§ 2.7)**, documented in README, and used by
   eval and isolation to mint staff tokens.

**Done when these curl cases give these results:**

| Case | Expected |
|---|---|
| The right password, as a member | 200 |
| A wrong password | 401 |
| An unknown email | 401, the same message |
| A valid user who is not a member | 401, the same message |
| Removed mid-session, next request | 401 |
| Another tenant's cookie sent by hand | 401 |

Also: the reset flow works end to end against Supabase's test sender, and
the Phase 4 measurements still hold.

### Phase 6 — Remove the old

- Drop `tenants.admin_key_hash`.
- Delete `admin-key.ts`, `tenant:key`, and the key half of `tenant.mjs`.
  `tenant:add` stays, now with no key.
- Remove `SUPABASE_SERVICE_ROLE_KEY` from `apps/web/lib/env.ts`'s REQUIRED
  list, because the web app no longer needs it.
- Add the **import check**: a small script, run by `pnpm typecheck`, that
  fails if `@rag/db/service` is imported under `apps/` or `packages/*/src`
  (Rule 2).

**Done when:** a fresh `next build` passes with no service key in its
environment, and the import check catches a planted import, then passes
once it is removed.

### Phase 7 — The walk, and the bundle

- Browser walk:
  1. Log in to villa as a member.
  2. Add and delete a document.
  3. Book a slot and cancel it.
  4. Ask the chat an availability question.
  5. Log out.
  6. Try villa's admin page logged in as a northwind-only member: 401.
  7. Run the reset flow.
- `grep -ri "service_role\|SUPABASE_SECRET\|<signing key name>\|guest_phone"
  apps/web/.next/static/` returns nothing.

### Phase 8 — The record

- **`CLAUDE.md`:** rules 2 and 6 rewritten for the two walls, Rule 2 of this
  plan added, and the traps from § 2.
- **`decisions.md`:**
  - D-038–D-042;
  - D-006 marked **superseded**;
  - D-028 marked superseded, with the cookie kept and the key gone.
- **`risks.md`:**
  - R-2 and R-11 amended, since reads now have a second wall;
  - R-13 amended with Supabase Auth's measured limits;
  - R-19–R-22 added.
- `architecture.md`, `flow.md` (the token step), `notes.md` (Phase 2),
  `README.md` (setup: the signing key, the members, SMTP),
  `status.md`, `whats-done.md`.

---

## 4. Order, and what depends on what

```
0 spike + baseline ──> 1 policies ──> 2 index ──> 3 tokens ──> 4 chat on tokens ──> 5 staff ──> 6 remove ──> 7 walk ──> 8 record
      │
      └── if the spike fails every way: stop and re-plan
```

- **0 before everything.** § 2.1 decides whether Phase 3 is 30 lines of
  signing or a new database driver.
- **1 is safe to apply early,** because nothing the app does is subject to
  RLS until Phase 4.
- **4 before 5.** Chat is the path open to the internet, so it gets the
  database's protection first. Staff are behind a login already.
- **6 only after 5 works in the browser.** Until then the old admin key is
  the way back in.

---

## 5. Decisions to log

| | Decision | The short reason |
|---|---|---|
| **D-038** | Two walls, filters and RLS, and each is tested alone | A wall that is only ever tested alongside the other might not be there |
| **D-039** | Server-minted, 5-minute tenant tokens on every request, including anonymous chat. **The signing mechanism is whatever Phase 0 proves works** (A, B or C) | It puts the most exposed path under the database's protection. The signer refuses `service_role` |
| **D-040** | Supabase Auth authenticates staff. Our HMAC cookie carries the session (slug and user id), and the membership is re-checked on every request | Supabase does the dangerous parts (password storage, reset, verification). Re-checking makes removal immediate. **Supersedes D-028's key**, and keeps its cookie |
| **D-041** | One role: membership is admin | The smallest policy set that works. A `role` column later needs no migration of existing rows' meaning |
| **D-042** | `security definer` for exactly two functions, `tenant_public` and `check_availability`, both with `search_path = ''` | Each needs to see a table the caller must not: the tenants row, and the bookings rows. Anything else stays `security invoker` so RLS applies |

Also mark **D-006 superseded** (service role with no policies), with a pointer
to D-038/D-039.

---

## 6. What this does not fix

| | Risk | Honest assessment |
|---|---|---|
| **R-19** | The signing key is a master key | It can mint any token. Server-only, one function uses it, and the signer refuses `service_role`. But a leak of it is a full compromise, the same as the service key today. Rotating it has to be a documented procedure (Phase 8) |
| **R-20** | Transcripts are readable by anyone holding the conversation uuid **within the tenant** | This was true before this plan, and RLS does not change it: it isolates tenants, not visitors. A per-visitor claim needs guest identity, which is out of scope |
| **R-21** | Email deliverability | Supabase's default sender is for testing. Invites and resets to real staff need custom SMTP first (§ 2.6) |
| **R-22** | A policy that is too tight looks like a wrong answer | A chat token that cannot read `documents` titles gives "(deleted document)". One that cannot read `slots` gives a tool with no slot names. The battery and isolation (Phase 4) are what catch this, which is why Rule 3 treats a flipped verdict as a bug |

Still missing after this plan: guest accounts, roles, MFA, SSO, an audit log,
per-visitor privacy, and a rate limit on our own endpoints other than
Supabase Auth's (R-13, partly).

---

## 7. What this unblocks

| Want | Why it needed this |
|---|---|
| **A public URL** | D-006 and R-2 said "reverse the moment this is deployed". This is the reversal |
| **`request_booking` in chat** | It writes. With RLS, a guest-scoped token can be given exactly insert-a-pending-booking and nothing else |
| **An invite UI and member management** | The CLI proves the flow. A UI is then a screen over `member:add` |
| **Messenger** | A webhook resolves a page to a tenant and gets a chat token like any other request. There is no special path to secure |
