# Project map (George's digest; built 2026-10-27 at watermark `e1a41db`)

A digest of the record, never a second record (plan/ai-employees.md Rule 2).
Every line names where it came from. When this file and the record
disagree, the record wins and the disagreement is a finding (§ 10 below).

## 1. What the product is

A **retrieval-augmented chatbot** for resorts: a business pastes documents,
visitors ask questions, the bot answers only from those documents and
refuses rather than invents (CLAUDE.md "What this is"). It is
**multi-tenant** since 2026-09-23 (one database, each business at
`/t/<slug>`, plan.md), and has grown **bookings** (D-032–D-037), a public
**booking page** (D-069), **guest self-service and payments** (D-104–D-109),
**staff roles and a super-user platform** (D-075–D-079), **notifications**
(D-116), **feature flags and per-tenant permissions** (D-127, D-128), the
**legal groundwork** for the Data Privacy Act (D-129–D-131), **room types**
(D-133), **voice** (D-134), an **audit log** (D-138) and, as of 2026-10-26,
**free children** (D-147). The plan for the office calls it "a multi-tenant
RAG chatbot for resorts with bookings, payments, staff roles, a platform"
(plan/ai-employees.md § 3.3).

The pipeline, in one line (CLAUDE.md "What this is"):

```
resolve tenant → paste document → chunk → embed → store in pgvector
ask question → rewrite → embed → vector + keyword search → RRF fuse → prompt → stream
                                  tools? → model asks → run for THIS tenant → ask again
```

**The functional requirement that is not a feature:** "this project was
built to be understood" — no library does a pipeline step (D-001, D-002),
every number was measured (notes.md), the why is in the code (CLAUDE.md
"The thing to understand before changing anything").

**Deployed:** the user confirmed a Vercel deploy on 2026-10-27 ("it works.
the speed improves", whats-done.md:10085, D-150). `release-process.md`
(commit `ddbafab`) is the deploy plan. See § 10 for D-013, which still
says local-only.

## 2. The stack

From CLAUDE.md "Layout" and rule 2 (techstack.md describes the ORIGINAL
Express/no-TypeScript brief and is superseded; see § 10):

| Layer | Choice | Where it says so |
|---|---|---|
| App | Next.js 15, App Router, TypeScript, one app `apps/web` | CLAUDE.md Layout; D-020, D-021 |
| Monorepo | pnpm workspaces + Turborepo | D-020 |
| Database | Supabase Postgres + pgvector, `vector(1536)` | D-003, D-004; trap 3 |
| Isolation | RLS under a server-minted 5-minute ES256 tenant token; never `service_role` in a request | D-038, D-039; rule 2, rule 6 |
| Staff auth | Supabase Auth + an HMAC session cookie; `memberships.role` read per request | D-040, D-075 |
| OpenAI | raw `fetch`, no SDK: `text-embedding-3-small`, `gpt-4o-mini` (env), `tts-1`, transcription | D-002, D-004, D-005, D-134 |
| Validation | zod at the route boundary; one error→status map in `lib/route.ts` | D-022 |
| Styles | no CSS framework, no component library, no icon package; `tokens.css` is the only place a colour or size is a literal | D-101, D-102 |
| Push | Web Push by hand in `@rag/push` (RFC 8291/8292, `node:crypto`) | D-116 |
| Tests | vitest-style suites per package + `node --test` for the office; walks are raw CDP scripts in `plan/` | CLAUDE.md Commands; plan/ai-employees.md § 6.3 |

## 3. The packages and the layout

CLAUDE.md "Layout":

- `apps/web/` — the Next.js app: `app/t/[tenant]/...` (guest and staff
  pages), `app/platform/` (the super user), `app/api/t/[tenant]/**` and
  `app/api/platform/**` (every Route Handler wrapped in `withTenantRoute()`
  or `withPlatformRoute()`, rule 3), `components/`, `lib/` (`route.ts`,
  `rate-limit.ts`, `tenant.ts`, `admin-auth.ts`, `platform-auth.ts`,
  `permissions.ts`, `features.ts`, `nav-items.ts`, `theme.ts`, `money.ts`,
  `tables.ts`, `legal.ts`, `quick-notes.ts`, `version.ts`, …).
- `packages/chunker/` — `@rag/chunker`, pure, zero dependencies (rule 5).
- `packages/openai/` — `@rag/openai`: embed, chat, chatStream over fetch.
- `packages/db/` — `@rag/db`: tenant-token clients, the types, `sql/` (45
  files, § 7), `tools/verify.mjs` (243 checks), the CLIs (`tenant`,
  `member`, `super`, `retention`, `staff-cases`).
- `packages/bookings/` — `@rag/bookings`: availability, bookings, rooms,
  photos, requests, calendar, promos, payments, changes, notifications,
  `tools/rooms.mjs` (57), `tools/isolation.mjs` (42).
- `packages/rag/` — `@rag/pipeline`: ingest, retrieve, prompt, answer,
  tools, dates, language, greeting, refusal, tables, `tools/prompt-eval.mjs`
  (the battery, 63 cases), `tools/isolation.mjs` (24).
- `packages/push/` — `@rag/push`: Web Push, server-only.
- `packages/tsconfig/` — shared base config.
- `fixtures/` (northwind, harbor, villa-bookings, harbor-bookings),
  `sample-documents/` (villa's corpus 01–08), `plan/` (one plan per
  feature plus the walks and `plan/baseline/`), `scripts/check-service-imports.mjs`.
- `office/` — the AI employees (plan/ai-employees.md § 1); `.claude/agents/`.

**The ONE places the record insists on** (each is a rule, not a habit):
`unit_quote()` makes every price (D-066); `promo_discount()` every discount
(D-097); `rate_kind()` names the rate (D-082); `booking_reference()` the
reference (D-100); `booking_takes()` the taken test (D-106);
`request_booking()` the only public write (D-071); `mintTenantToken()` the
only signer (rule 8); `lib/permissions.ts` the default permission table
(D-079, D-128); `lib/features.ts` the feature registry (D-127);
`audit_row()` the audit trigger (D-138); `rate_allow()` the per-IP count
(D-137); `speakable()`, `freeGuestsWords()`/`partyWords()`,
`chatLinkLabel()`, `DEFAULT_WELCOME_TEXT` (D-134, D-147, D-136, D-139).

## 4. The tenants

- Live: **`villa`** (whole_resort; its rates in the database since D-074;
  DPA unsigned, R-62) and **`alteza`** (per_room; voice on since
  2026-10-20; `free_up_to_age: 3`; DPA signed 2026-10-01; status.md:92,
  1911). Alteza was "the fourth tenant, loaded by script" 2026-09-29
  (status.md:3048).
- **Deleted 2026-10-20 by the user's choice** (`tenant:remove --yes`):
  `northwind` and `harbor`. "Ask before rebuilding them (the user declined,
  2026-10-20)" (CLAUDE.md header, last paragraph). What cannot run: § 9.

## 5. Every feature, its D-number, its plan, its status

Status is from the dated paragraphs of CLAUDE.md's header unless a line
says otherwise. "Walk owed" means the plan's browser walk was never
recorded as done.

| Since | Feature | D | Plan | Status |
|---|---|---|---|---|
| 2026-09-20 | The POC: hybrid search, query rewrite, grounding, paragraph chunking, SSE | D-001–D-019 | mvp.md, steps.md | done |
| 2026-09-22 | Next.js + TypeScript migration | D-020–D-023 | plan/steps.md | done (Phase 8 deploy never done then) |
| 2026-09-23 | Multi-tenancy, `/t/<slug>`, branding | D-025–D-031 | plan.md | Phases 0–8 done |
| 2026-09-24 | Bookings, `check_availability` tool | D-032–D-037 | plan/bookings.md | complete (plan:13) |
| 2026-09-26 | Auth + RLS, tenant tokens, staff accounts | D-038–D-042 | plan/auth-rls.md | Phases 0–8 done (plan:3); three email checks owed (R-21) |
| 2026-09-26 | Taglish replies; fallback words; small talk; relative dates | D-043–D-049 | — | done; walked 2026-09-28 (status.md:3236) |
| 2026-09-27 | Booking types (per_room), rooms, photos | D-050–D-056 | plan/booking-types.md | Phases 0–8; **Phase 4 browser walk owed** |
| 2026-09-28 | Extra-guest pricing, `unit_quote()` | D-065–D-068 | plan/extra-guests.md | complete (plan:10) |
| 2026-09-28 | Customer booking page, holidays, requests | D-069–D-073 | plan/customer-booking.md | Phases 0–7 done, walk included |
| 2026-09-28 | Villa's prices from the tool | D-074 | plan/villa-prices.md | done; R-41, R-17 closed |
| 2026-09-29 | Tenant management, roles, `/platform` | D-075–D-079 | plan/tenant-management.md | Phases 0–8 done, walk included |
| 2026-09-30 | Closed dates | D-080 | — | done |
| 2026-09-30 | Price without a date; rate kinds; day price; room list; fee; horizon | D-081–D-088 | — | done |
| 2026-09-30 | Suggested questions; slot management | D-089, D-090 | — | done |
| 2026-10-04 | Tables in replies; emoji; **bold**; rate card scope; room cards | D-091–D-094 | plan/tables.md | Phases 0–5 done, walk included; D-094 amended 2026-10-21 and fixed 2026-10-26 |
| 2026-10-04 | Pending by default; decision notes | D-095, D-096 | — | done |
| 2026-10-04 | Promos | D-097 | plan/promos.md | Phases 0–6; **walk owed** |
| 2026-10-05 | Dashboard | D-098 | plan/dashboard.md | Phases 0–6; **walk owed** |
| 2026-10-05 | Staff clash; staff requests and references | D-099, D-100 | plan/staff-clash.md, plan/staff-requests.md | Phases 0–4 done, walks included |
| 2026-10-06/08 | UI refresh; UI components | D-101, D-102 | plan/ui-refresh.md, plan/ui-components.md | done; axe 160 states at 0 |
| 2026-10-09 | Calendar (S-12) | D-103 | plan/calendar.md | Phases 3–4 done (status.md:2306) |
| 2026-10-10 | Manage booking, payments, holds, changes, events | D-104–D-109 | plan/manage-booking.md | Phases 0–6 and 8; **Phase 7 (email) gated on deployment** |
| 2026-10-11/12 | Stay outcome; staff stay; list of stays; staff terms; one page per stay | D-110–D-114 | — | done |
| 2026-10-13 | Conversations (S-16) | D-115 | plan/conversations.md | Phases 0–6, walk included |
| 2026-10-14 | Notifications, Web Push, S-17 | D-116 | plan/notifications.md | Phases 0–8; **phone walk owed** (plan:24) |
| 2026-10-14 | Nav layout; public brand; platform header; room cards; landing; booking photos; logo/banner; avatar; "Book your stay"; Manage layout | D-117–D-126 | plan/nav-layout.md, public-brand.md, platform-header.md, room-cards.md, landing.md | done |
| 2026-10-14 | Feature flags; role permissions per tenant | D-127, D-128 | — | done |
| 2026-10-14 | Legal groundwork (RA 10173) | D-129–D-131 | plan/legal.md | done; **three answers, the lawyer's texts and villa's DPA date wait on the user** (status.md:145–150) |
| 2026-10-15 | Staff notes on a stay | D-132 | — | done |
| 2026-10-20 | Room types | D-133 | plan/room-types.md | Phases 0–5 and 7; **Phase 6's runs owed** (eval, isolation on tokens); the user's alteza walk DONE 2026-10-20 (status.md:130; see § 10) |
| 2026-10-20 | Voice | D-134 | plan/voice.md | complete (status.md:97) |
| 2026-10-20 | Quick notes; guest-page links | D-135, D-136 | — | done |
| 2026-10-20 | Shared rate limit, the chat included | D-137 | plan/rate-limit.md | Phases 0–5 done, walk included; R-39 closed |
| 2026-10-20 | Audit log, S-18 | D-138 | plan/audit-log.md | Phases 0–5 done, walk included |
| 2026-10-21 | Welcome line; sources for staff; caching; native fields; date picker; reference prefix; skeleton + progress; app icon | D-139–D-146 | plan/date-field.md | done; date-field **Phase 4 (the user's look) owed** (status.md:69) |
| 2026-10-26 | Free guests | D-147 | plan/free-guests.md | Phases 0–6 done, walk included; **the platform form's field on screen owed** (status.md:65) |
| 2026-10-26 | Build tag on every page | D-148 | — | done |
| 2026-10-27 | Page transitions; region pin `sin1` | D-149, D-150 | — | done, confirmed on the deploy |
| 2026-10-27 | AI employees (the office, George) | — | plan/ai-employees.md | Phases 0–2 done; Phase 3 is this day; **not committed** |

## 6. The screens

CLAUDE.md "Layout" (screens.md still says "Total: 2 screens", screens.md:19;
see § 10). All under `/t/<slug>` unless noted.

| # | Page | Who | Note |
|---|---|---|---|
| S-1 | `/` chat | public | the composer, voice (D-134), suggested questions (D-089), sources for `sources:read` only (D-140) |
| S-2 | `/admin/documents` knowledge base | staff | |
| S-3 | `/admin/bookings` list of stays | staff | 404 without the application; Requests section (D-100) |
| S-4 | `/admin/unanswered` | staff | D-045 |
| S-5 | `/admin/accommodations` rooms | staff | per_room only; a type's rooms (D-133) |
| S-6 | `/book` the booking page | PUBLIC | 404 unless a priced unit (D-069) |
| S-7 | `/admin/holidays` | staff | closed dates too (D-080) |
| S-8 | `/admin/members` | owners | `members:manage` |
| S-9 | `/admin/slots` | owners, admins | D-090 |
| S-10 | `/admin/promos` | owners, admins | D-097 |
| S-11 | `/admin/dashboard` | every member | the first staff link; `/admin` redirects here (D-098 amended) |
| S-12 | `/admin/calendar` | staff | D-103 (decisions.md:3664) |
| S-13 | `/manage` Manage booking | PUBLIC | D-104; `?ref=` |
| S-14 | `/admin/payments` | every member reads; owners, admins decide | D-107, D-108 |
| S-15 | `/admin/bookings/[reference]` one booking | staff | EVERY action on a stay (D-114); quick notes (D-135); staff notes (D-132); Move (D-133) |
| S-16, S-16a | `/admin/conversations`, `/[id]` | every member | D-115 |
| S-17 | `/admin/notifications` | staff | the ONE badge (D-116 § 8); 404 without bookings |
| S-18 | `/admin/activity` | `activity:read` (owners) | D-138 |
| — | `/platform` | super users | tenants, Pulse strip, the tenant form (Profile, Applications/Bookings, Features, Permissions, Knowledge base, Legal, Activity, Members, Archive) |
| — | `/`, `/privacy`, `/terms`, `/admin/reset`, `/platform/reset` | | the landing (D-121), the legal texts (D-129), where emails land |

## 7. The 45 SQL files (`packages/db/sql/`)

45 files on disk (Glob, 2026-10-27), matching CLAUDE.md "Layout"
(`sql/ (45 files; the 45th, schema-free-guests.sql …)`). The record
numbers them from the 16th on; the first fifteen it names without a
number: `schema.sql`, `schema-hybrid.sql`, `schema-tenancy.sql`,
`schema-bookings.sql`, `schema-auth.sql`, `schema-unanswered.sql`,
`schema-booking-types.sql`, `schema-extra-guests.sql`,
`schema-customer-booking.sql`, `schema-roles.sql`, `schema-closed-days.sql`,
`schema-rate-kind.sql`, `schema-day-price.sql`, `schema-suggested-questions.sql`,
`schema-slots.sql`.

| # | File | D |
|---|---|---|
| 16 | schema-pending-default | D-095 |
| 17 | schema-decision-note | D-096 |
| 18 | schema-promos | D-097 |
| 19 | schema-dashboard | D-098 |
| 20 | schema-taken-span | D-099 |
| 21 | schema-staff-requests | D-100 |
| 22 | schema-calendar | D-103 |
| 23 | schema-manage-booking | D-104–D-109 (cannot be re-run: trap 25) |
| 24 | schema-holds | D-106 |
| 25 | schema-stay-outcome | D-110 |
| 26 | schema-walk-in | D-111 |
| 27 | schema-staff-terms | D-113 |
| 28 | schema-conversations | D-115 |
| 29, 30 | schema-notifications, schema-notification-reads | D-116 |
| 31, 32 | schema-brand-images, schema-assistant-avatar | D-123, D-124 |
| 33 | schema-features | D-127 |
| 34 | schema-role-permissions | D-128 |
| 35 | schema-legal | D-129–D-131 |
| 36 | schema-stay-notes | D-132 |
| 37–40 | schema-room-inventory, -room-counts, -room-move, -room-views | D-133 |
| 41 | schema-voice | D-134 |
| 42 | schema-rate-limit | D-137 |
| 43 | schema-audit-log | D-138 |
| 44 | schema-welcome-text | D-139 |
| 45 | schema-free-guests | D-147 |

Rule: "safe to re-run" means in ORDER (trap 25); a file that replaces a
definition guards the old one on the new file's marker (trap 20).
Definer functions: twelve by D-100, nine more for manage booking, two for
notifications, `rate_allow`, and trigger-only ones (CLAUDE.md rule 8).

## 8. The suites and their last recorded numbers

| Suite | Last number | Date | Where |
|---|---|---|---|
| `pnpm --filter @rag/db verify` | **243/243** | 2026-10-26 | status.md:65; whats-done.md:10044 |
| `pnpm --filter @rag/bookings rooms` | **57/57** | 2026-10-26 | status.md:65 |
| Package tests: bookings / rag / web | **137 / 376 / 243** | 2026-10-26/27 | status.md:65, 61; whats-done.md:10073 |
| openai tests | 20 | 2026-10-20 | status.md:93 |
| `pnpm typecheck` | 13/13 (incl. the service-import check) | 2026-10-27 | status.md:61 |
| `plan/page-pending-walk.mjs` | 5/5 twice | 2026-10-27 | whats-done.md:10073 |
| `plan/free-guests-walk.mjs` | 7/7 (three runs) | 2026-10-26 | whats-done.md:10053 |
| `pnpm eval` (the battery) | **59/61** (antecedent, leak-2) on 61 cases | 2026-10-16 | status.md:102; now 63 cases, `rt-count` and `rt-count-full` NEVER run (CLAUDE.md Layout) |
| `@rag/pipeline isolation` | 24/24 on tokens, 22/22 filters alone | 2026-10-16 | status.md:102–105 |
| `@rag/bookings isolation` | 42/42 filters alone, "tokens all passing" | 2026-10-20 | status.md:126 |
| `plan/ui-refresh-a11y.mjs` (axe) | 160 states, 0 violations; the room-types re-audit started 2026-10-20, result not recorded | 2026-10-13 / 2026-10-20 | CLAUDE.md Conventions; status.md:117 |
| The bundle grep (rule 2) | 0 files of 132 at `6666555` | 2026-10-20 | status.md:97 |
| `office.test.mjs`, `office:check` | 15/15; consistent (1 employee, 13 plugins) | 2026-10-27 | whats-done.md:10112 |

The three chatbot baselines (`plan/baseline/northwind-prompt-post-emoji.txt`,
`villa-tools-post-villa-prices.txt`, `harbor-tools-tables-phase0.txt`) were
byte-identical at every feature that says "the chatbot is untouched"; the
last diff recorded is villa's on 2026-10-26 (whats-done.md:10044).
Northwind's and harbor's cannot be re-snapshotted (§ 9).

## 9. What cannot run since the test tenants were deleted

The user hard-deleted `northwind` and `harbor` on 2026-10-20 and declined
rebuilding them (CLAUDE.md header, last paragraph; status.md:129). Until
they are rebuilt from `fixtures/` (northwind.json, harbor.json,
harbor-units.json, harbor-bookings.json):

- `pnpm eval` (63 cases; needs three tenants, rule 1);
- `@rag/pipeline isolation` on tokens (24) and `@rag/bookings isolation`
  on tokens (42) — the filters-only halves ran 2026-10-20;
- every harbor walk (`plan/room-types-walk.mjs`, `booking-types-phase6-harbor.mjs`), `plan/public-brand-a11y.mjs` (status.md:79);
- the build grep and the axe re-audit listed at status.md:129;
- the northwind prompt snapshot and harbor's tool baseline.

Still runnable: `verify` (243: checks 16, 26 and 99 no longer need
northwind), `rooms` (57), every package test, typecheck, the villa and
alteza walks (status.md:128).

## 10. Where the record disagrees with itself (findings, not fixes)

Each is a task for the right employee, not for George (charter § 7).

1. **D-013 says "Local only, no deployment · Still true"** (decisions.md:280),
   but the deploy is confirmed (whats-done.md:10085, 2026-10-27;
   `release-process.md` at `ddbafab`). D-013 needs its reversal recorded.
2. **status.md's Snapshot is dated 2026-09-30** and names tenants
   `northwind (id 1)` and `villa (id 3)` (status.md:12, 28–31); the truth is
   in "▶ Next up" and the session log.
3. **screens.md says "Total: 2 screens"** (screens.md:19); CLAUDE.md's
   layout names S-1 … S-18 plus the platform.
4. **techstack.md describes the original brief** (Express 4, no
   TypeScript, three dependencies; techstack.md:15–43); CLAUDE.md says that
   brief is in git history (removed 2026-09-22).
5. **CLAUDE.md's room-types paragraph says "the user's alteza walk owed"**;
   status.md:130 records it done 2026-10-20 ("Room types is complete").
6. **risks.md R-2** (`service_role` + no RLS) is counted open by the index
   (risks-open.md), though D-006 is superseded by D-038/D-039; its heading
   was never closed.
7. **architecture.md § 3 and § 7** describe the Express POC's layout (headings
   at architecture.md:93–591); the current layout is CLAUDE.md's.

## 11. The office (plan/ai-employees.md)

- Rules 1–12 (plan § 0); George is Rule 1 (read-only by hook), her
  digests Rule 2, the board Rule 3.
- Nine roles to hire in Phase 6 (plan § 4.1: Ivy, Rhea, Uma, Vera, Theo,
  Finn, Quinn, Sage, Lex recommended, q11 unanswered); eight gates (§ 4.2);
  the short lane is gates 6, 7 (qa), 8.
- Phases: 0 (hook spike) done, 1 (office) done, 2 (George) done, **3 (this
  day)**, 4 talking, 5 guards by profile + pipeline + two skills, 6 the
  nine hired, 7 one idea through every gate, 8 the record (plan § 8).
- `idea add`, `gate`, `pipeline` arrive with Phase 5; until then an idea is
  a line in `owed.md` (charter § 8).
