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
> documents, assistant name and theme. Read `plan.md` § 0 before touching any
> query.
>
> **It has applications** since 2026-09-24 ([`plan/bookings.md`](./plan/bookings.md),
> Phases 0–8, all done): `villa` has **bookings**, a staff screen at
> `/t/<slug>/admin/bookings`, and the chatbot's first tool,
> `check_availability`. Read that plan's § 0 before touching the prompt or a
> tool.
>
> **Postgres enforces the tenant, and staff have accounts,** since 2026-09-26
> ([`plan/auth-rls.md`](./plan/auth-rls.md), Phases 0–8, all done).
> - Every request reaches the database on a server-minted, 5-minute **tenant
>   token**, under RLS policies, and never as `service_role`.
> - Staff log in with **Supabase Auth**, and a `memberships` row decides who
>   may administer which tenant.
> - Read that plan's § 0 (two walls, each tested alone) before touching a
>   query, a policy or a token.
>
> **It books by room too** since 2026-09-27
> ([`plan/booking-types.md`](./plan/booking-types.md), Phases 0–8; Phase 4's
> browser walk is owed). A tenant's bookings config says `whole_resort` (the
> default: villa) or `per_room` (harbor). Rooms are `units` rows with a
> capacity, a weekday/weekend rate per slot and photos in Storage, and **the
> price is set by the insert trigger, never by a request**. Read that plan's
> § 0 before touching a price, a room or a photo.
>
> **Rooms have extra-guest pricing** since 2026-09-28
> ([`plan/extra-guests.md`](./plan/extra-guests.md), Phases 1–5): a standard
> capacity, a maximum (`capacity`) and a fee per guest above the standard.
> ONE SQL function, `unit_quote()`, makes every price; the trigger, the staff
> quote and the chatbot's tool all call it, and nothing adds one up anywhere
> else.
>
> **Customers book on a page, not in the chat,** since 2026-09-28
> ([`plan/customer-booking.md`](./plan/customer-booking.md), Phases 0–7, all
> done, walk included). Every tenant with the bookings application and a
> priced unit has `/t/<slug>/book`: a stay of N nights (D-073), the price
> from the database including a per-tenant **holiday calendar** with
> surcharges (D-072), and a **request** that holds nothing until staff
> confirm it on the bookings screen (D-070). `request_booking()` is the ONE
> public write, a fourth definer function (D-071). Villa now has its rates
> in the database. The chat only explains how to book, from its documents;
> no prompt text changed (D-069). Read that plan's § 0 before touching a
> request, a holiday, a price or the page.
>
> **Villa's prices come from the tool** since 2026-09-28
> ([`plan/villa-prices.md`](./plan/villa-prices.md), D-074): a whole-resort
> tenant whose unit has a rate gets `price`, included guests, the fee and,
> with `guests`, the total in every `check_availability` row, from
> `unit_quote()`, and the figures the database holds LEFT its documents
> (R-41, R-17 closed). Villa's tool text is therefore no longer the
> pre-booking-types baseline: it is `plan/baseline/villa-tools-post-villa-prices.txt`.
>
> **A super user manages tenants in the browser, and staff have roles,**
> since 2026-09-29 ([`plan/tenant-management.md`](./plan/tenant-management.md),
> Phases 0–8, all done, walk included). `/platform` is where a
> `platform_admins` row (a **super user**, a second, tenant-less token
> shape, D-076) creates, edits and archives tenants, switches applications
> on and off, and manages any tenant's members. `memberships.role` is
> `owner | admin | staff` (D-075), read from the row on every request;
> `requireAdmin(request, tenant, permission)` names what a route needs from
> the ONE table in `lib/permissions.ts`, and Postgres asks the same role
> again (D-079). Owners manage members at `/t/<slug>/admin/members`. A
> tenant's max stay and booking horizon are in its bookings config (D-078).
> Archive is a button; delete is a command (D-077). Read that plan's § 0
> before touching a role, a policy, a token or a tenant's record.
>
> **A tenant can close dates** since 2026-09-30 (D-080). A closed date is a
> holiday-calendar row with `kind = 'closed'`, set on the Holidays screen. It
> closes the whole property for every slot starting that day. Postgres refuses
> any pending or confirmed booking on it, from anyone, and refuses to close a
> date that has confirmed bookings (`sql/schema-closed-days.sql`, two triggers
> and one advisory lock per tenant). Every availability read says `closed`, so
> the chatbot says so too. The tool's TEXT is unchanged, and its baselines
> with it: a closed date is explained in the tool RESULT only, and only when
> one is in it (`closedNote()` in `tools.ts`). Putting "closed" in the
> description moved `rt-leak-2` from 3 of 4 to 0 of 6.

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
                                                     tools? → model asks → run for THIS tenant → ask again
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
  app/t/[tenant]/admin/unanswered/page.tsx  S-4 unanswered questions — staff only, every tenant
  app/t/[tenant]/admin/accommodations/page.tsx  S-5 rooms — 404 unless the tenant books per_room
  app/t/[tenant]/admin/reset/page.tsx     where invite and reset emails land; the token is in the #fragment
  app/t/[tenant]/book/page.tsx   S-6 the customer booking page — PUBLIC; 404 unless the tenant has a priced unit
  app/t/[tenant]/admin/holidays/page.tsx  S-7 the holiday calendar — 404 unless the tenant has the application
  app/t/[tenant]/admin/members/page.tsx   S-8 the tenant's members — for OWNERS (members:manage); others see one sentence
  app/platform/page.tsx          the platform: login → tenant list → the tenant form (super users only; not linked from /)
  app/platform/reset/page.tsx    where a super user's invite or reset email lands
  app/api/platform/**/route.ts   session, password(-reset), tenants, tenants/[id], /archive, /applications/[key], /members — every one on withPlatformRoute() but the three session/password ones
  app/t/[tenant]/not-found.tsx   "No such workspace"
  app/api/t/[tenant]/**/route.ts the endpoints + admin/session, password-reset, password; chat/ does JSON and SSE
                                 book/quote and book/request are OPEN (no requireAdmin), like chat/
  components/                    tenant-nav (every tenant page's header links, by role and feature), chat-screen, admin-screen, bookings-screen (+ Requests), accommodations-screen, unanswered-screen, booking-page, holidays-screen, admin-login, reset-password (Client), brand-header, sources-panel,
                                 platform-screen, tenant-form (the theme preview is the page's own mechanism), members-panel (one panel, two callers), members-screen
  lib/route.ts           withRoute(): validation + the ONE error→status map
  lib/rate-limit.ts      the per-IP window on book/request — in memory, per instance, the WEAK limit (R-39)
  lib/tenant.ts          getTenant() + withTenantRoute(): slug → a CHAT TenantContext, 404 on a miss
  lib/admin-auth.ts      the staff session cookie; requireAdmin(request, tenant, permission) re-checks the membership and the ROLE → a STAFF context, or 401 / 403
  lib/platform-auth.ts   the platform session cookie (rag_platform, /api/platform); requirePlatform() → { db, userId }; withPlatformRoute()
  lib/permissions.ts     the ONE table of what each role may do — pure, imported by routes (the guard) and screens (the courtesy)
  lib/nav-items.ts       navItems(): the header's links for a tenant's features and a role — pure, tested
  lib/nav.ts             loadNavFeatures(): which of those pages the tenant has, the same checks the pages 404 on
  lib/theme.ts           the five theme keys, the colour regex, themeVars() and parseTheme() — pure, shared by the page and the platform form
  lib/applications.ts    requireApplication(): 404 unless the tenant has it switched on
  lib/branding.ts        the five-key theme allowlist, https-only image URLs
  lib/env.ts             fail-fast config (D-023)
  lib/limits.ts          MAX_CONTENT_LENGTH — importable by the browser
  lib/money.ts           centavos ↔ pesos, by string, never × 100 — browser-safe
  lib/resize-image.ts    canvas resize + WebP before upload; drops EXIF/GPS
packages/
  chunker/             @rag/chunker — pure, isomorphic, ZERO dependencies
  openai/              @rag/openai — embed, chat, chatStream over raw fetch; tool calls in, never run
  db/                  @rag/db — tenant-token clients, the types, sql/ (11 files), and server-only
    src/tenant-client.ts mintTenantToken and mintPlatformToken (ES256, D-039, D-076), one signer, scopedClient, anonClient
    src/service.ts       @rag/db/service: the RLS-BYPASSING client, for tools/ only (one exception: admin-auth.ts until auth-rls Phase 6)
    src/staff-auth.ts    signInStaff, staffClient (membership → { db, role }), platformClient (platform_admins → the platform token), password reset (Supabase Auth, D-040)
    tools/verify.mjs     109 checks (77–92 customer booking; 95–108 roles, the platform token, archive, the shapes, the lookups), no API key
    tools/super.mjs      super:add / remove / list — who runs the platform; the bootstrap, on service_role
    tools/tenant.mjs     tenant:add, tenant:fallback, tenant:booking-type, tenant:archive, tenant:remove (the only hard delete; D-077) — the platform form does the first two and archive too
    tools/member.mjs     member:add [role] / role / remove / list / operator — who may administer a tenant, and as what (owners do this on the Members screen)
    tools/staff-cases.mjs  the six login cases and three role cases over HTTP, against pnpm dev
  bookings/            @rag/bookings — availability, bookings; admin routes AND the chatbot tool call it
    src/accommodations.ts  rooms and their rates (+ holiday_price), staff only (per_room)
    src/images.ts          room photos in the `unit-images` bucket, staff only
    src/requests.ts        the booking page's reads and its one write (chat token); staff list/confirm/decline
    src/calendar.ts        the holiday calendar: list (any token), set/remove/copy (staff)
    src/closed.ts          closed dates (D-080): the reads that say 'closed', the words a refused write gets
    tools/isolation.mjs    29 cross-tenant checks, no API key
    tools/rooms.mjs        34 checks of rooms, groups, quotes, extra guests, photos, stays, holidays, requests and closed dates
    tools/storage-orphans.mjs  objects in the photo bucket with no row (R-30); dry run, `-- --remove` deletes, counted
  rag/                 @rag/pipeline — ingest, retrieve, prompt, answer, tenant, applications, tools
    src/language.ts        the reply language, decided in code: Tagalog in → Taglish out (D-043)
    src/greeting.ts        small talk (greetings, thanks, "okay", goodbyes, English + Tagalog) answered in code, no retrieval (D-049)
    src/refusal.ts         NO_ANSWER is the internal marker; visitors see the tenant's fallback_messages[language] or a default (D-047, D-048)
    src/dates.ts           relative dates ("bukas", "next Friday"), ranges ("from X to Y", "X for 2 nights") and a party size ("for 3 guests") resolved in code; availability AND price turns checked up front (D-046, R-15, D-074)
    tools/prompt-eval.mjs  the battery, 61 cases (10 + 9 tool-* + 10 lang-* + 11 date-* + 13 rt-* + 5 book-* + 3 price-*), three tenants; seeds its own bookings
    src/unanswered.ts      listUnanswered / resolve / reopen: the questions answered with NO_ANSWER, for staff (D-045)
    src/platform.ts        what a super user does to tenants: list, get, create, edit, archive, applications; fromPostgrest(), the ONE code→status map
    src/members.ts         list (with emails), add an existing account, change a role, remove — shared by owners and the platform
    tools/isolation.mjs    21 cross-tenant checks through the pipeline (the 21st, RLS only: a platform token reads nothing)
  tsconfig/            shared base config
fixtures/northwind.json  tenant northwind's corpus, for the eval battery
sample-documents/        tenant villa's corpus (01–08 only), for the battery too
plan/                    the migration plan and its evidence; plan.md is tenancy; plan/bookings.md is bookings
fixtures/villa-bookings.json  the battery's booking fixture, seeded and removed by pnpm eval
fixtures/harbor.json, harbor-units.json  tenant harbor's corpus and rooms (per_room); loaded by plan/booking-types-phase6-harbor.mjs
fixtures/harbor-bookings.json  harbor's booking fixture, seeded and removed by pnpm eval
plan/customer-booking-villa-rates.mjs  villa's unit, rates and nightly slots; idempotent
plan/customer-booking-phase5-docs.mjs  re-ingests the "how to book" documents when they differ from the files
plan/customer-booking-phase3-walk.mjs  10 HTTP checks of the booking and holiday routes, against pnpm dev
plan/tenant-management-phase4-walk.mjs 12 HTTP checks of the platform and members routes, against pnpm dev
plan/tenant-management-phase0-shapes.mjs  the constraints of schema-roles.sql, dry-run against every live row
scripts/check-service-imports.mjs  run by `pnpm typecheck`: fails on @rag/db/service under apps/ or packages/*/src
```

## Commands

```sh
pnpm dev                        # http://localhost:3000
pnpm build · typecheck · test   # typecheck runs the service-import check first
pnpm --filter @rag/db verify    # 109 checks, no API key needed
pnpm eval                       # the prompt battery, 61 cases  ⚠ see below
pnpm scores                     # real similarity scores for northwind, threshold off
pnpm --filter @rag/pipeline isolation   # 21 cross-tenant checks, on chat tokens (+ one platform token)  ⚠ rule 6
pnpm --filter @rag/pipeline isolation -- --filters-only   # 20 of them, code filters alone (RLS bypassed)
pnpm --filter @rag/bookings isolation   # 29 cross-tenant booking checks, on operator staff tokens, no API key
pnpm --filter @rag/bookings isolation -- --filters-only   # the same 29, code filters alone
pnpm --filter @rag/bookings rooms       # 34 checks: rooms, groups, quotes, extra guests, photos, stays, holidays, requests, closed dates; no API key
pnpm --filter @rag/bookings storage-orphans [-- --remove]   # photo objects with no row (R-30): list, or delete and count
(cd packages/rag && node --conditions=react-server --env-file=../../.env ../../plan/customer-booking-villa-rates.mjs)   # villa's rates and the nightly slots, idempotent
(cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/customer-booking-phase3-walk.mjs)   # the booking routes over HTTP, needs pnpm dev
node --conditions=react-server --env-file=../../.env tools/staff-cases.mjs   # (in packages/db) six login and three role cases, needs pnpm dev
(cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/tenant-management-phase4-walk.mjs)   # the platform and members routes over HTTP, needs pnpm dev
pnpm --filter @rag/db tenant:add -- <slug> "<business>" "<assistant>"   # then member:add for its first admin
pnpm --filter @rag/db tenant:fallback -- <slug> <english|taglish|tagalog> "<message>"   # what the chat says when it cannot answer (D-048)
pnpm --filter @rag/db tenant:fallback -- <slug>                  # show all three; `<language> --clear` or `--clear` = the default
pnpm --filter @rag/db tenant:booking-type -- <slug> [whole_resort|per_room]   # show or switch; refused while bookings are live (D-055)
(cd packages/rag && node --conditions=react-server --env-file=../../.env ../../plan/booking-types-phase6-harbor.mjs)   # harbor's corpus and rooms, idempotent
pnpm --filter @rag/db member:add -- <slug> <email> [owner|admin|staff]   # default admin; invites a new account (the link sets a password); an existing member keeps its role
pnpm --filter @rag/db member:role -- <slug> <email> <owner|admin|staff>  # the last owner cannot step down (Postgres says so)
pnpm --filter @rag/db member:remove -- <slug> <email>     # effective on their NEXT request
pnpm --filter @rag/db member:list -- <slug>               # with the role
pnpm --filter @rag/db member:operator -- <slug>           # the tools' own member (admin); eval and isolation need it
pnpm --filter @rag/db super:add -- <email>                # who runs the platform; a new address is invited to /platform/reset
pnpm --filter @rag/db super:remove -- <email>             # effective on their NEXT request
pnpm --filter @rag/db super:list
pnpm --filter @rag/db tenant:archive -- <slug> [--undo]   # a 404 everywhere, reversible; the platform form does this too
pnpm --filter @rag/db tenant:remove -- <slug> --yes       # HARD delete: prints 13 counts, cascades, sweeps the photo bucket. CLI only, on purpose (D-077)
```

## The rules you will be tempted to break

1. **Re-run `pnpm eval` after ANY edit to `buildPrompt()`.** Phase 5.5 measured
   that this prompt, not the similarity threshold, is what stops the model
   inventing answers. A change that makes the bot more helpful can quietly make
   it answer from training data instead. The battery checks both directions at
   once: real questions answered, absent facts still refused.
   **It needs THREE tenants loaded:** `northwind` holding `fixtures/northwind.json`
   and nothing else, `villa` holding `sample-documents/01–08`, and `harbor`
   (per_room) holding `fixtures/harbor.json` and `harbor-units.json`. It used to demand
   northwind *alone*, because Villa describes parking and `absent-2` must refuse
   parking. Tenancy turned that fragile precondition into the feature (plan.md
   § 2.5): `leak-1`/`leak-2`/`leak-3` now assert that a fact in the database,
   but in the other tenant, is unreachable. Expect **59/61**, printed as
   `original 9/10 · tool 9/9 · lang 9/10 · date 11/11 · rooms 13/13 · book 5/5 · price 3/3`:
   `antecedent` is the known model limit (D-017), and `lang-followup` leans
   Tagalog after a bare date (D-043); it passes about one run in three, which
   gives 60/61. `lang-tagalog-2` flips now and then (1 run in 7); repeat it
   before deciding why. A different number means something moved. The five
   `book-*` cases (D-069) check both directions of "the chat does not book":
   the Book button or page is named, and no reply claims a booking was made;
   `book-how-tl` prints its Taglish mix but judges only the booking part.
   Every verdict's reason is on a `why:` line, so read it before rewording.
   **`packages/rag/src/language.ts` and `dates.ts` are prompt text too**:
   their lines are appended to `buildPrompt()`, so an edit there means
   re-running the battery. The nine `tool-*` cases seed
   `fixtures/villa-bookings.json` into villa themselves and hard-delete it
   afterwards (plan/bookings.md Phase 6), and the ten `rt-*` cases do the same
   with `fixtures/harbor-bookings.json` in harbor. Their price checks compare
   the reply with the TOOL's price for that row, never with a typed number. Tools also mean a second prompt
   check: `pnpm --silent --filter @rag/pipeline prompt-snapshot` must match
   `plan/baseline/northwind-prompt-pre-bookings.txt` (`diff --strip-trailing-cr`),
   villa's tool definitions must match
   `plan/baseline/villa-tools-post-villa-prices.txt` (D-074; before it, the
   pre-booking-types file), and harbor's
   `plan/baseline/harbor-tools-pre-customer-booking.txt`. The three `price-*`
   cases compare the reply with the TOOL's row, never a typed number; the
   `lang-*` cases ask facts that are still in the documents (the deposit,
   the extension, the cook), because the rates are not.
2. **No request holds a key that bypasses RLS, and no secret reaches the
   browser** (plan/auth-rls.md Rule 2).
   - Requests use `tenant.db`: the publishable key plus a tenant token.
   - The RLS-bypassing client lives only at `@rag/db/service`, for `tools/`.
     `pnpm typecheck` runs `scripts/check-service-imports.mjs` first, and it
     fails on any import of it under `apps/` or `packages/*/src`.
   - The web app neither needs nor reads `SUPABASE_SERVICE_ROLE_KEY`. It is
     off env.ts's REQUIRED list, and `next build` passes without it.
   - `@rag/db` imports `server-only`, so a Client Component importing it is a
     build error.
   - Before shipping, `grep -ri "service_role\|SUPABASE_SECRET\|TENANT_SIGNING_JWK\|guest_phone"
     apps/web/.next/static/` must return nothing. Grep for the key VALUES too,
     on a build that had them (Phase 7).
3. **Every Route Handler is wrapped in `withTenantRoute()`**, which resolves the
   slug (404 on a miss, never a fallback) and wraps `withRoute()`. Nothing
   enforces it. An unwrapped handler answers with a generic 500 instead of the
   real reason — or, worse, runs without knowing its tenant.
   **Every handler under `app/api/platform/` is wrapped in `withPlatformRoute()`**
   (the session and password ones, which run before a session exists, use
   `withRoute()` and say so). **Every admin handler names its permission:**
   `requireAdmin(request, tenant, 'documents:write')`, from `lib/permissions.ts`;
   the argument is required, so a route that forgets does not compile
   (D-079), and a member whose role lacks it gets a 403 that names both.
4. **Any Node script that touches `@rag/db` needs `--conditions=react-server`.**
   That is the cost of rule 2. Every script in `package.json` carries it already.
5. **`@rag/chunker` has no dependencies and no I/O.** That is what lets the same
   code run in Node and the browser, and what keeps the file readable alone.
6. **Two walls stand between tenants, and each must hold ALONE** (D-038).
   - **Wall 1, the code:** every query on `documents`, `chunks`,
     `conversations` or `messages` filters on `tenant_id`, every insert sets
     it, and every search `.rpc()` sends `p_tenant_id`.
   - **Wall 2, Postgres:** RLS policies (`sql/schema-auth.sql`) compare every
     row with the token's `tenant_id` claim.
   - **Proving each wall alone:** `verify.mjs` checks 28–46 run unfiltered
     queries under a token (RLS alone). `isolation -- --filters-only` runs
     every query on the service client, with RLS bypassed (filters alone).
   - **Neither wall may be dropped because the other exists.** A filter
     removed "because RLS covers it" is a wall nobody tests any more.
   `tenant` is a **required** parameter with **no default** — no ambient
   "current tenant", no fallback slug (D-027); a forgotten one should be a
   compile error, not a silent read, and since auth-rls it also means no
   database at all: `tenant.db` is the only client a request has.
   - After any change to a query, run:
     - `pnpm --filter @rag/pipeline isolation`, both ways;
     - `pnpm --filter @rag/db verify`;
     - `pnpm eval`, where the `leak-*` cases must stay green.
   - Then re-run plan.md Phase 3's grep: every line it prints must carry a
     tenant.
   - A new table needs its own policy, or tokens read nothing from it (R-22). The same applies
   to `tenant_applications`, `units`, `slots`, `bookings`, `unanswered_resolutions` (staff-only, D-045),
   `unit_rates`, `unit_images`, `rate_calendar` (any token reads, admins write) and the `unit-images` bucket's `storage.objects` policies
   (`pnpm --filter @rag/bookings isolation`, 29 checks). **The model never
   supplies a tenant.** No tool's argument schema has a tenant, unit or
   booking id; the executor takes `tenant` from the server (plan/bookings.md
   Rule 2). **A customer never supplies one either:** `request_booking()`
   takes `p_tenant_id` from the route (wall 1) and refuses one that is not
   the token's (wall 2); a chat token has no insert policy on `bookings`, so
   that function is the only way in (D-071).
7. **A tool result carries nothing the chat user may not see.** It goes into a
   prompt, and a prompt-injected model can recite it. `check_availability`
   returns `date, unit, slot, status` and nothing else, and rows are mapped
   field by field, never spread. Chatbot tools are **read-only**: the chat
   route is open, so a write tool is an unauthenticated write (D-037). A
   tool's result is shown to the user as "Checked availability", open,
   because it is what the answer was built from.
8. **The token signer is a master key too** (D-039, R-19). `TENANT_SIGNING_JWK`
   can mint any claim, so it is read in ONE function, `mintTenantToken()`,
   which mints one shape:
   - the role is always `authenticated`. There is no role parameter, so it
     cannot mint `service_role`;
   - it carries a tenant;
   - it lasts five minutes.

   Chat tokens carry **no `sub`**. Staff tokens carry the user and
   `app_admin`, and Postgres's `app_role()` reads the `memberships` row for
   that tenant on every write: the ROLE is never a claim (D-075).
   **A second shape since tenant management (D-076):** `mintPlatformToken()`,
   in the same file, mints `{ sub, app_super }` with NO tenant, still
   `authenticated`, still five minutes, still no role parameter; with no
   tenant claim every tenant policy is false for it, and `app_is_super()`
   demands a `platform_admins` row. Ten functions are `security definer`
   (`tenant_public`, `check_availability`, `check_room_availability`,
   `request_booking`, `app_role`, `tenant_applications_validate`,
   `tenant_applications_no_delete_live`, `memberships_keep_an_owner`,
   `member_emails`, `user_id_by_email`; D-042 as amended by D-054, D-071
   and D-076), each with `search_path = ''` and each checking its caller
   itself. `request_booking` is still the only one that writes for a
   stranger, and it can write `pending` rows only.

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
   return the refusal string (NO_ANSWER, the internal marker; the visitor
   sees the tenant's friendly words, D-047) directly — do not call OpenAI (D-008). For a
   tenant **with tools** the model is called anyway, and its reply is kept
   only if it called a tool; otherwise it becomes the refusal (D-035). The
   text is held, not streamed, until that is decided.
7. **Changing the chunker does not re-chunk stored documents.** Delete and
   re-add them (or open and save each one: an edit re-ingests), or they keep
   their old boundaries. An edit gives the document a NEW id (D-044).
8. **"Check, then insert" double-books.** Never read availability and then
   insert. Insert, and let `bookings_no_overlap` refuse the loser with
   `23P01`, which `@rag/bookings` maps to a 409 (D-034).
9. **"Today" is the tenant's, not the server's.** At 01:04 SGT the UTC date was
   still yesterday. `localDate(timezone)` for dates; `slot_range()` in SQL for
   turning wall-clock time into instants. The model has no clock, so the tools
   block states today's date. Knowing today is not counting from it: the
   model asked "Which date?" for "bukas" 6 times in 6, so `dates.ts` resolves
   relative dates in code and runs the check itself (D-046).
10. **A tools-block sentence can cost a documents answer.** "Start with a
    sentence that names the date" passed every tool case and made a Wi-Fi
    question refuse 2 runs in 3. Run the full battery, not `--only`, and when a
    verdict flips, repeat that case before deciding why (R-18).
11. **Measure RLS as a token, never as `service_role`.** `service_role`
    bypasses RLS, so an `explain` run as it measures nothing
    (`plan/auth-phase2-explain.sql`). The policies call the helpers as
    `(select public.app_tenant_id())`, which makes an InitPlan evaluated once.
    Bare, it would be a function call per row.
12. **A check that passes on zero rows proves nothing.** Before schema-auth
    ran, a token read 0 chunks, and "every row is villa's" was vacuously true.
    A chat token also gets `200 []` from the bookings list. Every RLS check
    needs its positive twin: the count matches, or a real row comes back.
13. **`. ./.env` in bash breaks the signing key.** Bash strips the JSON's
    quotes, and `node --env-file` never overrides a variable that is already
    set. For `next dev`, "unset a key" means setting it EMPTY
    (`SUPABASE_SERVICE_ROLE_KEY=`), because next.config's dotenv refills a
    missing one.
14. **Supabase's email is capped** (R-21). The built-in sender allows a few
    emails an hour, and an invite plus two resets used it up. Custom SMTP
    comes before real staff. The dashboard also holds ONE standby signing
    key at a time, so rotating ours has a gap (R-19).
15. **PostgREST fills a missing key with NULL, not the default.** In a
    multi-row insert it builds one column list for the whole array, so a key
    that one row lacks is sent as NULL. Four rooms with `active` on the last
    one only failed `not null` (23502). Every row carries every key
    (booking types Phase 1).
16. **`next build` while `next dev` runs breaks the dev server.** Both use
    `apps/web/.next`; every page then 500s with `Cannot find module
    './535.js'` while API routes still answer. While dev runs, build packages
    only (`pnpm --filter @rag/<pkg> build`).
17. **A refused Storage delete is silent.** No error, 0 removed. Check how
    many objects were removed, never only the error (booking types Phase 1).
18. **A missing pre-check looks like a prompt failure.** `rt-tagalog` fell
    from 3 of 3 to 1 of 7 and read like the model ignoring a date. The cause
    was `dates.ts` matching "bakante" but not "bakanteng" (the Tagalog
    linker), so D-046's up-front check never ran. When a case that names a
    date fails, check `[query] dates:` in the log before rewording anything
    (extra-guests Phase 4).
19. **A trigger inherits its caller's `search_path`.** `bookings_compute_during`
    named `units` and `slots` bare and worked for years of staff inserts.
    Fired from inside `request_booking()`, whose `search_path` is `''`, it
    would have been "relation does not exist" on every web request. Every
    trigger and function now has `set search_path = ''` and qualifies every
    name (customer-booking Phase 1, caught by reading before the first run).
20. **Re-running an older schema file can put an older function back.**
    `schema-customer-booking.sql` replaces five definitions from two earlier
    files. Those steps are guarded on `to_regclass('public.rate_calendar')`
    so a re-run skips them; without that, `schema-extra-guests.sql` would
    fail (`unit_quote` changed its return type) and `schema-booking-types.sql`
    would quietly restore a price function with no holidays. When a file
    replaces a definition, guard the old one on the new file's marker.
21. **A request does not hold a date, and the screen's disabled button is
    not the guard.** Once the list reloads, a clashing request's Confirm is
    disabled by `clash`; a stale list (a second tab) still reaches the
    server, and `bookings_no_overlap` answers 409 there (D-070). Never add a
    "check, then confirm" in code to make the button smarter (trap 8).
22. **A write under RLS reaches only rows the token can SELECT.** The owner
    policies on `memberships` were right and updated 0 rows: an owner could
    select its own row only. verify's positive twin (1 row promoted) is what
    showed it; the negative checks alone had passed. The fix, a tenant-wide
    read policy, then met the recursion rule: **a policy that calls a
    function that reads the same table under that policy is "infinite
    recursion detected"**, so `app_role()` is `security definer` (tenant
    management Phase 1).
23. **Dropping a column default breaks every writer at once, silently.**
    `memberships.role` lost its default and nine tool inserts failed with
    23502 unreported; the symptom was every staff write refused everywhere,
    because the probe users were never members. Every insert names its role
    now. When a column loses a default, grep every insert before the first
    run.
24. **An identical prompt can get a different answer.** `leak-2`'s control
    flipped with the same five chunks, the same scores and the same
    1957-token prompt, 4 of 4 (tenant management Phase 6). When retrieval,
    prompt and data are byte-for-byte the same and only the reply moves,
    the cause is the model; record it, and do not reword anything to chase
    it. `tool-leak` and `book-for-me-harbor` flip with the DATE the battery
    asks about (Phase 0); read `[retrieve]` before deciding which kind of
    flip you have.
## Conventions

- ES modules, `async`/`await`, named exports, one responsibility per module.
- Tunable constants in `packages/rag/src/constants.ts`, SCREAMING_SNAKE_CASE.
  Booking limits live in `packages/bookings/src/constants.ts`, beside the code
  that enforces them. A limit the browser needs too (the photo limits) reaches
  the Client Component as a prop from its server page, never as a copy.
- Money is bigint **centavos** everywhere; it becomes text once, for a person
  (`lib/money.ts`, and `money()` in the tool result).
- Validate at the route boundary, throw in the pipeline, map errors to status
  codes in exactly one place (`apps/web/lib/route.ts`).
- Staff are managed by an OWNER on the Members screen (`/t/<slug>/admin/members`:
  list, add an existing account, change a role, remove) or with
  `member:add [role] | member:role | member:remove | member:list`; a
  change takes effect on the person's next request, and a tenant always
  keeps one owner (a trigger). Inviting a NEW account is the CLI's alone
  (it needs the service key). The platform (`super:add`) manages any
  tenant's members and its record at `/platform`, and reads no tenant's
  content unless it makes itself an owner there (D-076). Tools that do
  staff work run as the tenant's **operator** member (`member:operator`,
  an admin), on a staff token, not as `service_role` (plan/auth-rls.md § 2.7).
- Every Route Handler lives under `app/api/t/[tenant]/` and is wrapped in
  `withTenantRoute()` (which wraps `withRoute()`), which hands it a CHAT
  context. Admin-only handlers start with `tenant = await requireAdmin(request,
  tenant)`, which re-checks the membership and swaps in a STAFF context, so no
  later line can touch the database as the chat token. Then
  `requireApplication()` if the route belongs to an application. The chat
  route stays open, and so do `book/quote` and `book/request`: they run on
  the chat token, read only what any token of the tenant may read, and write
  only through `request_booking()`. Their limits are, weakest first, a
  honeypot field, the in-memory per-IP window, and the per-contact limit in
  SQL, which is the one that holds.
- Money is bigint **centavos**, and every price is `unit_quote()`'s: a
  quote before, the stored rows after. A screen never adds up a total; a
  receipt's total is the sum of what was STORED (customer-booking Rule 3).
- Every tenant-owned query carries `.eq('tenant_id', tenant.id)` — rule 6.
  "Not yours" and "not there" must look identical (`[]`, `null`, 404), or ids
  can be enumerated across tenants.
- Tokens read `tenants` only through `tenant_public(slug)`: the table has no
  policies, and that function's column list is the boundary. Tools on the
  service client still select `tenants` columns **explicitly**, never
  `select('*')`. A `TenantContext` carries `db`, a live token, so it never
  goes to a Client Component: pages pass named props.
- Frontend: never `dangerouslySetInnerHTML` for anything from the server or the
  model. React escapes children, which is what makes this free — adding
  markdown rendering is what would take it away. Tenant branding follows the
  same rule: theme colours reach the page as CSS custom properties through the
  `style` prop, from the allowlist in `lib/branding.ts` (D-030).
- `console.log` in the pipeline is deliberate: `[ingest]`, `[retrieve]`,
  `[query]`, `[openai]`, `[tool]` and `[bookings]` are how you see chunks,
  scores, cost and what a tool said. Leave them.

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
