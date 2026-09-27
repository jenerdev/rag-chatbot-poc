# Status — RAG Chatbot POC

> **What this file is:** the live "where am I / what's next" log for the **build
> phase**. Unlike `mvp.md` (the whole plan), this file answers one question:
> **when I sit down to work, what do I do next?**
>
> **Keep it current.** Update it after **every completed step** (not just at the
> end of a session): mark what got done, bump the progress %, and set "Next up"
> so the next session (you or a fresh Claude) starts immediately without
> re-reading everything.
>
> Last updated: 2026-09-26 (Taglish replies, D-043; auth-rls complete and merged into `master` at `f3ea70b`; three email checks owed)

---

## Snapshot

- **Overall progress:** **100% — all five phases complete**, plus five post-MVP
  changes: hybrid search (D-015), query rewriting (D-016), reworded grounding
  instruction (D-017), paragraph-aware chunking (D-018), streaming (D-019).
  **The entire original post-MVP list is now done.**
- **Current phase:** **none.** Tenancy ([`plan.md`](./plan.md), Phases 0–8)
  was completed 2026-09-23 and merged into `master` by fast-forward
  (`88bf00f`). The feature branch `feat/nextjs-migration` is deleted. Before
  that, the Next.js + TypeScript migration ([`plan/steps.md`](./plan/steps.md))
  finished 2026-09-22. Its optional Phase 8 (deploy) was never done, and D-013
  still says local-only.
- **Status:** one Next.js app and five packages, **multi-tenant**: tenants
  `northwind` (id 1) and `villa` (id 3), each with its own documents, persona,
  theme and admin key. Measured on the final code: eval 9/10 (the known
  `antecedent` model limit), isolation 11/11, verify 14/14, and tests 41 + 13.
  Both tenants were also walked by hand in the browser.
- **Working on right now:** nothing new. The **auth + RLS plan**,
  [`plan/auth-rls.md`](./plan/auth-rls.md) (Phases 0–8, written 2026-09-24), is
  complete and was **merged into `master` by fast-forward on 2026-09-26**:
  `master` is at `f3ea70b`, 11 commits from `feat/auth-rls`, and there is no
  merge commit. `feat/auth-rls` still exists. **Phase 0 done 2026-09-26:** option A works (D-039), and
  the baseline is in `plan/baseline/*-pre-auth.txt`. **Phase 1 done
  2026-09-26:** `schema-auth.sql` applied, verify 47/47, and the app is
  unchanged (eval 18/19 verdict for verdict). **Phase 2 done:** RLS costs
  no access path and the ids are identical, so nothing changed. **Phase 3
  done:** every request runs on a tenant token. Admin writes are broken until
  Phase 5, as planned. **Phase 4 done:** chat works with the service key
  unset in the web process. **Phase 5 done:** staff log in with Supabase
  Auth, admin writes work again, and the web app no longer imports the
  service client at all. **Phase 6 done:** the admin key and its column
  are gone, and `pnpm typecheck` enforces the service-import rule. **Phase 7
  done:** the browser walk and a clean bundle. The northwind invite and the
  reset email are owed to the email cap. **Phase 8 done:** the record.
  **The auth + RLS plan is complete**, apart from three checks that wait on
  Supabase's email cap. Bookings is complete and merged
  (`master` at `23a84cd`). On that code: eval 18/19, isolation 11/11,
  bookings isolation 12/12 (it was always 12; "13" was a miscount), verify 28/28, tests 99.

---

## ▶ Next up (do this next)

**Booking types (whole-resort / per-room)**, [`plan/booking-types.md`](./plan/booking-types.md),
on branch `feat/booking-types` (plans committed on `master` at `e8fc28b`).
- [x] **Phase 0 — Baseline** (2026-09-27). `harbor` created (tenant 67,
  "Harbor Inn", assistant Marina, operator member), no application, no
  documents, no units. Baselines in `plan/baseline/*-pre-booking-types*`.
- [x] **Phase 1 — Schema** (2026-09-27).
  - [x] Storage spike (§ 2.8), 9/9 on 2026-09-27: Storage accepts our
    tokens; cross-tenant and chat-token uploads refused (403), SVG 415,
    over 2 MiB 413. A refused delete is silent (0 removed, no error).
  - [x] Steps 1–10 of `schema-booking-types.sql`, run by the user.
    verify **69/69** (21 new: 49–68). Villa's availability, tool
    definitions and prompt, and Northwind's prompt, byte-identical to Phase 0.
    Spike 9/9 again, isolation 16/16 + 12/12 both ways, tests unchanged.
  - [x] The file's second run changes nothing: verify 69/69, villa's
    availability and tools identical, spike 9/9, bucket settings unchanged.
- [x] **Phase 2 — `@rag/bookings`** (2026-09-27). `accommodations.ts`,
  `images.ts`, and in `bookings.ts` `createBookings` (several rooms, one
  insert), `quote`, `checkRoomAvailability`, `requirePerRoom`, the room
  filter. `tools/rooms.mjs` (`pnpm --filter @rag/bookings rooms`) 15/15 on a
  staff token; unit tests 27 → 72; verify 69/69; isolation 16/16 + 12/12
  both ways; `tool-*` 9/9; villa and Northwind prompts and villa's tools
  identical to Phase 0.
- [x] **Phase 3 — Routes** (2026-09-27). `accommodations` (+ `[id]`,
  `rates`, `images`, `images/[imageId]`), `bookings/quote`, `?unit=` and
  `rooms` on `bookings`, `bookingType`/`currency` on `setup`. HTTP walk
  (`plan/booking-types-phase3-walk.mjs`) 10/10 against `pnpm dev`.
- [~] **Phase 4 — Screens** (code 2026-09-27, `f720ab8`; **browser walk
  owed**). S-5 `/t/<slug>/admin/accommodations` (rooms, rates in pesos →
  centavos by string, photos resized to WebP in the browser), and on the
  bookings screen for per_room only: rooms to tick with guests each, the
  server's quote, a room filter, room and price on each row. Pages: villa
  bookings 200, accommodations 404 for villa/northwind, 200 for harbor.
  Harbor now has the bookings application, `per_room`, slot Night 14:00 +22h.
  **Owed, by the user in the browser** (walk login `walk-harbor@example.com`,
  delete it after): villa's screen unchanged; a FULL-SIZE phone photo, whose
  before/after sizes set `MAX_IMAGE_BYTES` / `MAX_IMAGE_EDGE` (both still
  provisional); photo reorder/remove; a two-room booking; the 409 clash; the
  room filter; retiring Family Room. Checked so far from the database: one
  330×352 WebP, 6560 bytes, no EXIF/GPS (ICCP only); one Garden Room booking
  on a Saturday at 450000. The second round of steps did not reach the
  database; the user deferred finding out why.
- [x] **Phase 5 — The CLI** (2026-09-27). `pnpm --filter @rag/db
  tenant:booking-type -- <slug> [whole_resort|per_room]`.
  `plan/booking-types-phase5-cli.mjs` 6/6.
- [x] **Phase 6 — the tool, then measure** (2026-09-27). The per_room branch
  of `check_availability` (same name; `slot`, `room`, `guests`; prices as
  text), harbor's corpus/rooms/booking fixtures, ten `rt-*` cases. Full
  battery **47/48** (`original 9/10 · tool 9/9 · lang 10/10 · date 9/9 ·
  rooms 10/10`); rt 30/30 over three runs; villa's and Northwind's prompts
  and villa's tools byte-identical; `MAX_AVAILABILITY_ROWS` 150 now measured
  (36.3 tokens a row).
- [x] **Phase 7 — isolation and the bundle** (2026-09-27). Bookings isolation
  22/22 both ways (10 new, on two throwaway per_room tenants); pipeline
  isolation 20/20 both ways (4 new, harbor ↔ villa); verify 69/69; bundle
  scan of `.next/static` clean on two fresh builds (service key empty, and
  full `.env`), with its positive twin. Dev server stopped for the builds and
  restarted in the background (with the user's OK).
- [x] **Phase 8 — the record** (2026-09-27). D-050–D-056 (D-042 amended:
  three definer functions), R-23–R-30 (R-17 and R-15 amended), CLAUDE.md
  (header, layout, commands, rules 1/6/8, traps 15–17, money convention),
  flow.md (11b, the new routes).

**Booking types is COMPLETE except Phase 4's browser walk.** Owed, by the
user: villa's screen unchanged; a full-size phone photo (sets MAX_IMAGE_BYTES
and MAX_IMAGE_EDGE); photo reorder/remove; a two-room booking, the clash,
the room filter, retiring Family Room; why the second walk round never
reached the database. Then delete `walk-harbor@example.com`, and merge
`feat/booking-types` into `master`.

**Then:** [`plan/payments.md`](./plan/payments.md), Phase 0. Also open: the
date-range finding (R-15), and `storage-orphans.mjs`, planned but not built
(R-30).

Before that, the browser walk of D-047–D-049 is still owed.

**Payments (booking lifecycle + manual verification): plan drafted
2026-09-27**, in [`plan/payments.md`](./plan/payments.md). Nothing built;
needs booking-types first. § 9 answered: payments are `per_room` only
(villa keeps Viber), the model quotes and a button books, email via Resend.
Roles, phone, proof retention and deployment deferred to their phases.

~~**Conversational messages (D-049).**~~ **Done 2026-09-27, uncommitted.**
Greetings, thanks, acknowledgments and goodbyes (English + Tagalog) are
answered in code, short and in the conversation's language, with no
retrieval or tool; "Salamat po" and "okay" no longer get the refusal. Mixed
messages answer the question ("Thanks! …" also gets "You're welcome!").
Tests 294, battery 36/38, isolation 16/16 both ways. **Next:** commit; the
browser walk.

~~**Per-language fallback messages (D-048).**~~ **Done 2026-09-27** (code in
`c6e360c`, record uncommitted). `tenants.fallback_messages` per reply
language; villa has all three (English and Taglish as the user wrote them,
Tagalog set by me). Live: each language gets its own line; verify 48/48,
isolation 16/16 both ways, tests 234. **Next:** commit the record; the
browser walk.

~~**Friendly refusal (D-047).**~~ **Done 2026-09-27, uncommitted.** Visitors
no longer see "I don't know based on the documents I have." It stays the
internal marker; the chat shows `tenants.fallback_message` (villa: Viber/SMS
0917-845-2290, set with `tenant:fallback`) or a friendly default in the
reply's language. `schema-auth.sql` re-run by the user. Tests 233 in the
pipeline, battery 36/38, verify 48/48, isolation 16/16 both ways, snapshot
identical. D-046's tools-rule edit reverted (lang-tagalog-2). **Next:**
commit; browser walk.

~~**Relative dates (D-046).**~~ **Done 2026-09-27, uncommitted.** "bukas",
"tomorrow", "sa makalawa", "sa Friday", "next week" were 6/6 "Which date?";
now resolved in code (`dates.ts`) and, on an availability turn, checked up
front with the resolved date. Battery 36/38 (`original 9/10 · tool 9/9 ·
lang 9/10 · date 9/9`), tests 214 in the pipeline, northwind snapshot
identical, isolation 16/16, verify 48/48 (checks 30–33 now count in Postgres:
villa passed PostgREST's 1000-row cap). **Next:** commit; walk it in the
browser in Taglish (the battery judges the words, not the ear).

~~**Mark unanswered questions resolved (D-045).**~~ **Done 2026-09-27.** S-4
has Open / Resolved tabs; **Mark resolved** and **Reopen** add or remove a
row in `unanswered_resolutions` (new `schema-unanswered.sql`, applied by the
user). verify 48/48, isolation 16/16 both ways, tests green, typecheck green,
HTTP 401/404 on the new routes without a session. **Next:** the browser walk
of the whole loop (unanswered → ✎ FAQ → ask in chat → mark resolved), then
the three email checks.

~~**Edit a document (D-044).**~~ **Done 2026-09-27, uncommitted.** ✎ on each
knowledge-base row loads the full text into the form; **Save changes** PUTs
it, and the server ingests the new version and then deletes the old one (new
id). Isolation 14/14 both ways (new: `getDocument cross-tenant is null`,
`updateDocument replaces in its own tenant only`), verify 47/47, tests green,
typecheck green; over HTTP on `pnpm dev` GET/PUT without a session are 401,
an unknown tenant 404. `pnpm build` not re-run (it would break the running
dev server again). **Next:** walk it in the browser: log in at
`/t/villa/admin`, click **Unanswered**, pick a question, ✎ the FAQ, add the
answer, save, and ask the question in chat.

~~**Unanswered questions screen (S-4).**~~ **Done 2026-09-27, uncommitted.**
`/t/<slug>/admin/unanswered` lists what visitors asked that got the exact
refusal, newest first, behind `requireAdmin()`. No new table: refusals were
already saved. Pipeline isolation 12/12 both ways (new `listUnanswered per
tenant`: northwind 200 at the limit, villa 68), verify 47/47, tests 103/27/14/13,
typecheck and build green. **Not yet seen in a browser**: the build overwrote
the running `pnpm dev`'s `.next`, so restart dev (delete `apps/web/.next`),
log in at `/t/villa/admin`, click **Unanswered**. Northwind's list is mostly
eval/isolation traffic.

~~**Taglish replies (D-043).**~~ **Done 2026-09-26, uncommitted.** A question
in Tagalog or Taglish now gets a Taglish answer. English still gets English,
and an explicit "Tagalog lang" or "in English" request holds for the whole
conversation. `language.ts` decides the language in code, and the prompt
carries one directive. The battery grew from 19 cases to 29 (`lang-*`). The
full run was 26/29 (`original 9/10 · tool 9/9 · lang 8/10`). isolation 11/11
both ways, verify 47/47, bookings isolation 12/12, tests 103 in the pipeline.
The northwind snapshot is unchanged. **Next:** commit it, and walk a Tagalog
conversation in the browser (villa), because the battery judges the mix by
counting words, not by ear.

~~**Bookings Phase 0: baseline.**~~ **Done 2026-09-24.** verify **14/14**,
isolation **11/11**, eval **9/10** (the known `antecedent` failure only).
Northwind's prompt was captured with the new `prompt-snapshot` script (sha256
`d6337d0f…`). All four files are in `plan/baseline/*-pre-bookings.txt`.

~~**Bookings Phase 1: schema.**~~ **Done 2026-09-24.**
`packages/db/sql/schema-bookings.sql` was run in the Supabase SQL editor by the
user. verify **28/28**. Villa is seeded with the bookings application
(Asia/Manila), unit "Whole property", and three slots. Northwind has none. The
turnover-gap question (§ 8) is still open. If the answer is yes, it becomes one
column on `slots`.

~~**Bookings Phase 2: `@rag/bookings`.**~~ **Done 2026-09-24.** The package
exposes `checkAvailability`, `listBookings`, `createBooking`, `cancelBooking`,
`listUnits`, `listSlots` and `bookingsConfig`, with three errors carrying
400/409/404. There are 27 new unit tests, and
`pnpm --filter @rag/bookings isolation` passes **13/13**.

~~**Bookings Phase 3: applications and admin routes.**~~ **Done 2026-09-24.**
The changes:
- the `APPLICATIONS` registry and `enabledApplications()` in `@rag/pipeline`;
- `requireApplication()` in `apps/web/lib/applications.ts`;
- `lib/route.ts` now passes 400/404/409 through (not for `OpenAIError`);
- four routes under `/api/t/[tenant]/bookings`, with README curls.

27 curl cases pass.

~~**Bookings Phase 4: the admin screen.**~~ **Done 2026-09-24.** Added
`/t/[tenant]/admin/bookings` (404 without the application), `bookings-screen`
and the shared `admin-login`. The user reported the walk as passed. The
database confirms the Overnight booking (#27, 22 Oct) and the refused next-day
booking. **It does not confirm the UI cancel:** #27 was still `confirmed`
afterwards.

~~**Bookings Phase 5: tool calling in `@rag/openai`.**~~ **Done 2026-09-24.**
`chat` and `chatStream` take `tools` and return `{ content, toolCalls }`.
Without tools, the request body and the log line are unchanged, which is
tested. There are 14 new fixture tests, and a real call with a dummy tool
returned parseable arguments both ways.

~~**Bookings Phase 6: the tool in the pipeline, then measure.**~~ **Done
2026-09-24.** Eval **18/19** (`original 9/10 · tool 9/9`), with the
original ten the same verdict by verdict. Isolation 11/11. Northwind's prompt
is identical to the Phase 0 snapshot. The three wording findings were then
fixed (tool cases 6/9 → 7/9 → 9/9; full battery still 18/19). Availability
replies now open with a sentence naming the date. A first, unscoped wording
cost `leak-2` (1 of 3 runs). Scoped to availability, it is 3/3, and the full
battery is 18/19.

~~**Bookings Phase 7: the chat screen.**~~ **Done 2026-09-24.** `chat-screen`
handles `tool` events, and `sources-panel` shows an open "Checked
availability" box with open/taken chips. The user walked it, and the server log
confirms the slot-filling flow, the 23 Oct taken Day Tour, a documents answer
with no tool, and Northwind's free refusal.

~~**Bookings Phase 8: the record.**~~ **Done 2026-09-24.** CLAUDE.md
(rules 6–7, traps 8–10), decisions D-032–D-037 plus the D-008 amendment, risks
R-14–R-18, architecture, flow, notes and README. `todo.md` was left alone,
because it holds your uncommitted edits. Its tool-call and ask-a-question
items are done.

~~**Auth + RLS Phase 0: the signing spike, and the baseline.**~~ **Done
2026-09-26.** Option **A** works. A token signed ES256 by our own key,
imported as a *standby* signing key, gets `200` back from `whoami()` with the
claims `{"role": "authenticated", "tenant_id": 3}`. Before the import, the same
token got `401 PGRST301`. B and C were not needed. Recorded as D-039, evidence
in `plan/baseline/auth-spike-phase0.txt`. Supabase Auth email sign-in works:
`iss …/auth/v1`, `aud authenticated`, `role authenticated`, uuid `sub`, 3600 s
tokens, still signed by Supabase's `cb77f580…`. The baseline matches: verify
28/28, isolation 11/11, bookings isolation 12/12, eval 18/19 (`antecedent`),
prompt-snapshot byte-identical (`d6337d0f…`), and villa's `explain` is a Seq
Scan plus top-N sort, 0.974 ms. Sign-up + sign-in rate limit (R-13): **30**,
shared by both, as shown in the dashboard.

~~**Auth + RLS Phase 1: policies and memberships.**~~ **Done 2026-09-26.**
`packages/db/sql/schema-auth.sql` was run in the SQL editor by the user.
- **verify 47/47** (28 + 19 through tenant tokens):
  - the RLS-alone reads under villa's chat token: documents 8/8, chunks
    30/30, conversations 141/141, messages 368/368, 0 foreign;
  - a chat token reads 0 of the probe's 5 bookings;
  - `check_availability` with another tenant's id: `42501`;
  - a wrong-tenant staff token: `42501` on both writes, 0 of villa's 3
    bookings read.
- **The app is unchanged:** isolation 11/11, bookings isolation 12/12,
  eval 18/19 with identical verdicts, snapshot byte-identical.
- **Two deviations from the plan's sketch,** both in whats-done.md:
  - `app_is_admin()` is security invoker;
  - every write policy also checks the tenant.

~~**Auth + RLS Phase 2: measure the index under RLS.**~~ **Done 2026-09-26.**
`plan/auth-phase2-explain.sql` was run by the user. Both search bodies were
explained as service_role and as villa's token (`notes.md` § "Auth-rls
Phase 2").
- **Same access path in every pair.** The policy shows up as one
  `InitPlan` plus a `One-Time Filter`, not a per-row call.
- **Identical ids:** `match_chunks` 142 · 162 · 143 · 168 · 149 and
  `match_chunks_fts` 149 · 156 · 168 · 161 · 150.
- **With HNSW forced,** the token's plan takes `chunks_tenant_idx` (the
  policy qual as its Index Cond) rather than a Seq Scan.
- **Chosen:** nothing to change, and no `leakproof`.
- **Still to drop:** `whoami`, `auth_explain` and `auth_explain_token`
  (statements at the bottom of the file).

~~**Auth + RLS Phase 3: tenant tokens and scoped clients.**~~ **Done 2026-09-26.**
- **`@rag/db`:**
  - `mintTenantToken`, `scopedClient` and `anonClient` are in
    `src/tenant-client.ts`;
  - the service client moved to `@rag/db/service`;
  - `TenantContext` and `BookingTenant` carry `db`, and every call site uses
    it;
  - `loadTenant` goes through `tenant_public`, and so does `loadBranding`.
- **One exception:** `admin-auth.ts` imports `@rag/db/service` to read
  `admin_key_hash`, until Phase 6.
- **Fresh key `45345cbc…`:** the spike key `ea5ce335…` is revoked and now
  gets `401`.
- **Measured:**
  - verify 47/47 on the new key;
  - isolation 11/11 on chat tokens AND 11/11 `--filters-only`;
  - bookings isolation 12/12;
  - **eval 18/19, every question on a chat token, verdicts identical**;
  - snapshot byte-identical.
- **⚠ Admin writes are refused until Phase 5.** Every request is a chat
  context now, and the bookings screen shows empty. Admin login still
  works.

~~**Auth + RLS Phase 4: the chat path on chat tokens.**~~ **Done 2026-09-26.**
- **Measurements, from Phase 3's run on the same pipeline code:** eval 18/19
  with identical verdicts, isolation 11/11, bookings isolation 12/12, and
  the snapshot byte-identical.
- **In the running app:** `plan/auth-phase4-walk.sh` ran against `pnpm dev`
  twice, with the service key set and then with it **empty in the web
  process**. The chat lines are identical:
  - the page is 200 and `/t/nope` is 404;
  - the parking answer comes with 5 sources, and the transcript has 2
    messages;
  - a cross-tenant transcript is 404, and northwind refuses the villa fact;
  - `check_availability` is called for 5 November 2026 through the chat
    token;
  - the SSE sequence is `meta`, then `delta`s, then `done`.
- **Admin-key login with the key empty:** a 500 naming the missing key.
  That is the one exception, until Phase 6.
- **Done early:** `SUPABASE_SERVICE_ROLE_KEY` left env.ts's REQUIRED list
  (a Phase 6 item). `admin-auth.ts` now imports the service client lazily,
  inside `checkAdminKey()`.

~~**Auth + RLS Phase 5: staff accounts.**~~ **Done 2026-09-26.**
- **Login:** email + password through Supabase Auth, then the membership,
  then our cookie `<slug>.<userId>.<expiry>.<mac>`.
- **Every admin request:** `tenant = await requireAdmin(…)` re-checks the
  membership and swaps in a staff token.
- **Also built:**
  - the reset flow: "Forgot password?", then `/t/<slug>/admin/reset`, then
    `…/admin/password`;
  - `tools/member.mjs` and the operator members (`rag-operator+<slug>@example.com`);
  - the eval, and both isolation suites (`--filters-only` on bookings too),
    run their staff work as the operator.
- **Measured:**
  - **the six plan cases pass** (`staff-cases.mjs`), with the web process
    holding NO service key;
  - a member can add and delete a document, and book and read a booking back
    with its guest name;
  - verify 47/47, isolation 11/11 + 11/11, bookings isolation 12/12 + 12/12;
  - eval 18/19 with identical verdicts; snapshot identical;
  - in the browser: invite link → set password → log in → log out works.
- **Pending:** the "Forgot password?" email. Supabase's built-in sender
  returned `429 over_email_send_rate_limit` (R-21). Retry once the hourly cap
  resets. It uses the same page and route the invite already exercised.
- **Deviation:** the admin-key login is gone NOW, not in Phase 6. The way back
  in is `member:add`.

~~**Auth + RLS Phase 6: remove the old.**~~ **Done 2026-09-26.**
- **Removed:**
  - `admin-key.ts`, and its exports;
  - `tenant:key`, and the key half of `tenant.mjs` (`tenant:add` stays,
    keyless);
  - `admin_key_hash` from the types;
  - the column itself: `schema-auth.sql` § 7 was run by the user, and a
    select of it now fails with `42703`.
- **Added:** `scripts/check-service-imports.mjs`, run first by
  `pnpm typecheck`. Two planted imports (`apps/web/lib`, and `./service.js`
  inside `packages/db/src`) → exit 1 naming both; removed → exit 0.
- **Fresh `next build` with `SUPABASE_SERVICE_ROLE_KEY` empty:** passes.
- **After the drop:**
  - verify 47/47;
  - isolation 11/11 + 11/11, bookings isolation 12/12 + 12/12;
  - snapshot identical, unit tests pass;
  - staff cases all pass, against a keyless dev server.
- **Not re-run:** the eval. No pipeline or prompt code changed.

~~**Auth + RLS Phase 7: the walk, and the bundle.**~~ **Done 2026-09-26**, with two
email items owed.
- **Browser walk, steps 1–5, by the user as `villa-staff-test@yopmail.com`.**
  All worked, and the server log agrees:
  - login 200;
  - document #90 added (201) and deleted (200);
  - booking #185 made (201) and cancelled (200);
  - the chat's availability question called `check_availability` (3 slots,
    3 open);
  - logout 200.
- **Step 6** (a northwind member at villa → 401) is proven over HTTP by
  `staff-cases.mjs` case 6 (`401 "Admin login required for villa"`). In the
  browser it waits for the northwind invite.
- **Bundle:** two fresh production builds, one with the service key empty and
  one with the full `.env`. In both, 36 static files have **0 hits** for:
  - `service_role`, `SUPABASE_SECRET`, `SUPABASE_SERVICE_ROLE`,
    `TENANT_SIGNING_JWK`, `guest_phone`, `@rag/db/service`, `admin_key_hash`;
  - the signing key's kid and private `d`;
  - the service, secret, OpenAI and cookie-secret VALUES.
  A positive control (`Checked availability`, `Forgot password?`) does hit.
- **Owed to the email cap (R-21):**
  - `member:add -- northwind northwind-staff-test@yopmail.com` (got `email
    rate limit exceeded`, and no account was created);
  - step 6 in the browser;
  - the "Forgot password?" email.

~~**Auth + RLS Phase 8: the record.**~~ **Done 2026-09-26.**
- **CLAUDE.md:**
  - the header names the auth plan;
  - rule 2 is "no request holds an RLS-bypassing key", with the import check
    and the bundle grep;
  - rule 6 is the two walls, each tested alone;
  - a new rule 8 covers the signer as a master key;
  - traps 11–14 (measure as a token; zero-row checks; `.env` sourcing and
    `next dev` unset; the email cap and the one-standby limit);
  - the layout, commands and conventions are updated.
- **decisions.md:**
  - D-038, D-040, D-041 and D-042 are added (D-039 was written in Phase 0);
  - D-006 is marked superseded;
  - D-028's key is marked superseded, with the cookie kept.
- **risks.md:**
  - R-2, R-11 and R-13 are amended;
  - R-19 (with the rotation procedure), R-20 and R-22 are added, next to
    Phase 5's R-21.
- **architecture.md** has a new "Auth" subsection with the policy table, the
  staff routes in the API table, a rewritten env section and overview, and
  updated module rows.
- **flow.md** has the token step in the query diagram and the new routes.
- **README.md** covers the five schema files, the new env vars, "Create
  tenants and their staff", "The signing key" (including rotation), and a
  rewritten security section.
- **plan/auth-rls.md** carries a status line.

**▶ Next up: the three email checks.**
- `feat/auth-rls` was merged into `master` BEFORE these checks, by the user's
  choice. So they are owed on `master`.
- When Supabase's email cap has reset (R-21), do these three in one sitting:
  1. `pnpm --filter @rag/db member:add -- northwind northwind-staff-test@yopmail.com`;
  2. walk step 6: log in as that member at `/t/villa/admin`. It must refuse;
  3. log out and click "Forgot password?" for `villa-staff-test`. Follow the
     email and log in with the new password.
- Before any real staff: custom SMTP (R-21). Before a public URL: a rate
  limit on our own endpoints (R-13).

<details><summary>Phase 0's original brief</summary>

[`plan/auth-rls.md`](./plan/auth-rls.md) § 2.1 and § 3. This project uses
Supabase's asymmetric JWT signing keys (the `.env` has
`SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` and `SUPABASE_JWKS_URL`), so
first prove the server can mint a token PostgREST accepts. Try, in order:
A, our own key imported as a signing key; B, the legacy secret; C, a direct
Postgres connection. **If none works, stop and re-plan.** Also check that
Supabase Auth's email+password sign-in works, and save the baseline to
`plan/baseline/*-pre-auth.txt`. You will need the Supabase dashboard for
the spike.

</details>


~~**1. Sign off Phase 6**~~ — **done 2026-09-22, checked by hand.** All four
steps pass in the browser: the document list and its chunks, the live estimate,
a streamed answer with its sources panel arriving first, and the refusal after
the document is deleted. That is the `mvp.md` definition of done, on the new
stack.

The migration needs nothing more. **The next piece of work is chosen and
planned:** multi-tenancy, in [`plan.md`](./plan.md) (8 phases, written
2026-09-22).

~~**1. Tenancy Phase 0 — capture the eval baseline.**~~ **Done 2026-09-23**
(commit `78d243f`). Northwind only (document 37, chunks 137–140); eval **5/6**, the
D-017 `antecedent` failure; pgvector **0.8.2**. Files are in `plan/baseline/`:
`eval-pre-tenancy.txt`, `scores-pre-tenancy.txt`, `match-ids-pre-tenancy.md`.
Phase 0 is closed.

~~**2. Tenancy Phase 1 — schema and migration.**~~ **Done 2026-09-23.**
`packages/db/sql/schema-tenancy.sql` was run in the Supabase SQL editor by the
user. It created tenant `northwind` (id 1, assistant "Nora") and backfilled every
row to it. `pnpm --filter @rag/db verify` gives **14/14**, with zero NULL
`tenant_id` in all four tables. The composite FK rejects a cross-tenant chunk
with `23503 ... chunks_document_tenant_fk`. `pnpm eval` still gives **5/6**.
**Deviation:** a temporary bridge, D-031. `tenant_id` defaults to northwind, and
the old unfiltered search functions are kept as overloads, so the app keeps
working.

~~**3. Tenancy Phase 2 — measure the index.**~~ **Done 2026-09-23.** Tenant `villa` (id 3) was
seeded with an explicit `tenant_id`: documents 38–45, 30 chunks. The
tenant-scoped ids match Phase 0 exactly. The planner uses `chunks_tenant_idx`
plus an exact sort, not HNSW. With HNSW forced and ef_search 2, villa got
**0 rows**, and iterative scan brought back 5. **Chosen:**
`set hnsw.iterative_scan = 'strict_order'` on `match_chunks`, confirmed in
`pg_proc`. No composite GIN index. Details are in `notes.md` § "Tenancy
Phase 2". Verify is still 14/14.
✓ `tenancy_explain` dropped (the RPC now returns `PGRST202`).
⚠ **Two tenants now exist, so the D-031 bridge is live.**
Don't use the app until Phase 3: "parking spaces" pulls villa chunks at 0.362
through the old unfiltered function.

~~**4. Tenancy Phase 3 — thread the tenant through `@rag/pipeline`.**~~ **Done
2026-09-23.** Every pipeline function takes a required `TenantContext`, and the
plan's grep shows a tenant filter on all 15 lines. `pnpm build`, `typecheck` and
`test` pass (40 + 13). `pnpm --filter @rag/pipeline isolation` passes 11/11.
Eval is **5/6** with the same verdicts, and the score probe is **identical** to
Phase 0. **D-031's database bridge is removed:** the old functions give
`PGRST202`, and a tenant-less insert gives `23502`. The routes are pinned to
northwind by `bridgeTenant()` until Phase 5. Also fixed: `listDocuments()` had
been failing since Phase 1 ("more than one relationship was found").

~~**5. Tenancy Phase 4 — persona, then measure.**~~ **Done 2026-09-23.** A
persona line was added above the unchanged D-017 block; the optional sentence
was not needed. `greetingReply(message, tenant)` names the tenant. The battery
now has 10 cases and scores **9/10, twice**. The six original verdicts are
identical to Phase 0, and leak-1, leak-2 (with a villa control), leak-3 and
persona all pass. Villa's assistant was renamed from "Amihan" to **"Lia"**,
because "Amihan" is also in the business name, which made the persona check
meaningless. Output: `plan/baseline/eval-post-persona.txt`. Details:
`notes.md` § "Tenancy Phase 4".

~~**6. Tenancy Phase 5 — routes under `/api/t/<slug>/`.**~~ **Done 2026-09-23.**
All five route files moved to `app/api/t/[tenant]/`, behind `withTenantRoute()`.
`bridgeTenant()` is deleted, so D-031 is fully gone. Observed over curl:
- `/api/t/northwind/documents` lists only document 37;
- `/api/t/villa/documents` lists only documents 38–45;
- `/api/t/nope/documents` gives `404 {"error":"No workspace named \"nope\""}`;
- the old `/api/chat` and `/api/documents` give `404`;
- villa's document 38, asked for through northwind, gives `[]` for its chunks
  and `404` on delete;
- the parking question is refused by northwind and answered by villa from
  villa's titles;
- villa's SSE gives `meta`, then 13 × `delta`, then `done`.

`apps/web/README.md` has the new table and curl examples.
⚠ **The two screens are broken until Phase 7.** They still fetch `/api/chat`
and `/api/documents`, which are now 404. The plan prefixes those fetches in
Phase 7, step 4. Use curl until then.

~~**7. Tenancy Phase 6 — admin auth.**~~ **Done 2026-09-23.**
- **Code:** `ADMIN_COOKIE_SECRET` is required in `env.ts`. scrypt
  `hashAdminKey`/`verifyAdminKey` live in `@rag/db`. `lib/admin-auth.ts` has an
  HMAC-signed cookie that carries the slug and an expiry.
  `POST/GET/DELETE /api/t/<slug>/admin/session` handles login, status and
  logout. `requireAdmin()` guards the list, add and delete document routes and
  the chunks route; chat stays open. `pnpm --filter @rag/db tenant:add` and
  `tenant:key` print a key once.
- **Keys:** northwind and villa both have keys, issued by the user. Claude
  never saw them.
- **Checked over curl, against a throwaway tenant (since deleted):**
  - no cookie, wrong key, a cookie from another tenant, a swapped slug, a
    tampered signature, a correctly signed but expired cookie, and after
    logout: all **401**;
  - right key: **200**, with `Path=/api/t/authprobe; HttpOnly; SameSite=lax`;
  - a tenant with no key: 401, "has no admin key set";
  - chat with no cookie: **200**.
- **Static bundle:** 0 files contain `admin_key`, `ADMIN_COOKIE_SECRET`,
  `service_role`, `rag_admin`, `scrypt`, or the secret's value.

**Deviations, which D-028 must record in Phase 8:**
1. The cookie path is `/api/t/<slug>`, not `/t/<slug>`. The guarded routes
   live under `/api/`, and a `/t/<slug>` cookie would never be sent to them.
2. The key hashing is in `@rag/db`, not `apps/web/lib`, because
   `tools/tenant.mjs` needs it too.
3. `tenant:key` was added alongside `tenant:add`. The two existing tenants had
   no way to get a key otherwise.

~~**8. Tenancy Phase 7 — the screens.**~~ **Done 2026-09-23, and signed off by
the user in a real browser** (all seven walk steps passed).
- **Pages:** `/t/<slug>` and `/t/<slug>/admin` are Server Components that
  resolve the tenant and pass props to `components/chat-screen.tsx` and
  `components/admin-screen.tsx`. Both were moved with `git mv`.
- **Frame:** `app/t/[tenant]/layout.tsx` applies the theme through the `style`
  prop and sets the tab title to the business name.
- **Branding:** `lib/branding.ts` allowlists five theme keys, checks each
  against a colour regex, and accepts `https:` URLs only.
- **Admin screen:** a login form, a logout button, and a fall-back to the form
  on any 401.
- **Chat screen:** the empty-knowledge-base hint now comes from the new
  `countDocuments()`, passed from the server.
- **Other pages:** `/` is a static page with no tenant list and no redirect.
  `/t/nope` gives a 404 "No such workspace".
- **Villa's theme** is `{accent #0f766e, accentSoft #e7f5f2, bg #faf7f2}`.
- **Hostile-theme test:** `ink: "red;}body{display:none"`,
  `panel: "url(javascript:alert(1))"`, an unknown key, and `javascript:` /
  `http:` URLs. Every one was dropped: 0 occurrences in the HTML, and only the
  3 valid variables were rendered.
- **Checks:** the static bundle grep is clean, and `dangerouslySetInnerHTML`
  appears only in comments. Tests pass (41 + 13), isolation is 11/11, eval is
  9/10, and verify is 14/14.

~~**9. Tenancy Phase 8 — cutover and the record.**~~ **Done 2026-09-23.
Tenancy is complete: Phases 0–8.**
- **`decisions.md`:** D-025 to D-030 added. D-028 records the three Phase 6
  deviations, and D-006 was amended.
- **`risks.md`:** R-10 to R-13 added, plus "still missing after tenancy", and
  R-2 amended.
- **`architecture.md`:** §2 system overview, §3 diagrams, §4 the five tables
  and three SQL files, §5 routes, §7 layout and §8 env vars.
- **`flow.md`:** redrawn for Next.js, with "resolve tenant" as step 1.
- **`CLAUDE.md`:** rule 1 amended for two tenants; new rule 6 on the
  `tenant_id` filter; Conventions, Layout and Commands updated.
- **`README.md`:** three-file SQL setup, `ADMIN_COOKIE_SECRET`,
  `tenant:add`/`tenant:key`, the `/t/<slug>` pages, and a loader for both
  eval corpora.
- **The README's loader script was run verbatim** against a throwaway tenant,
  with only the slug and key substituted. It gave 9 documents and 34 chunks,
  with the same per-document counts as the real tenants, and the tenant was
  then deleted.

**What is left is optional, and each item is its own plan** (`plan.md` § 7):
- Messenger;
- recording unanswered questions;
- Tagalog greetings;
- analytics;
- tool calls;
- real auth plus RLS, which is due before any public URL (R-2, R-11, R-13).

**Tenancy, the rule for Phases 3–8:** the one thing to internalise before starting is `plan.md` § 0 Rule 2:
**after this, the only thing between tenant A and tenant B is a
`where tenant_id = …` in application code** — `service_role` still bypasses
RLS — so isolation is proven by the `leak-1`/`leak-2`/`leak-3` cases, not by
having read the queries.

**10. Phase 8 of the migration — deploy** (`plan/steps.md` § Phase 8). The step
that catches a proxy buffering the stream, which cannot be caught locally.
Before it, read `README.md` § "Before you put this in production" — R-2 in
particular (RLS is enabled with no policies; `service_role` bypasses it) stops
being a note and becomes a blocker the moment there is a public URL, and
`plan.md` R-11 makes it larger rather than smaller.

ℹ `pnpm eval` and `pnpm scores` now carry `--conditions=react-server`, because
the pipeline imports `@rag/db`, which is `server-only`. Without the flag they
cannot run at all. See `packages/db/README.md`.

~~Decide tenancy~~ — **decided 2026-09-22: single tenant.** No `tenant_id`.
Multi-tenancy is its own plan after Phase 7, and now carries a backfill.

What is left on the POC itself is optional:

1. **Read [`notes.md`](./notes.md).** It is the deliverable — what each of the
   five knobs actually does, measured on this build.
3. **Verify both post-MVP features in the browser:**
   - Ask `NL-220` → the sources panel should show `KEYWORD` or `BOTH` badges.
   - Ask "Who is the Operations Director?" then "When did they join?" → the
     second answer should work, with an italic *searched for:* line in the
     sources panel showing the rewritten query.
4. **Nothing left on the post-MVP list.** Everything in `mvp.md` § Post-MVP
   has been built except auth and deployment, both of which are deliberate
   non-goals for a learning POC (D-006, D-013).

⚠ **After D-018, any document already in the database was chunked by the OLD
splitter.** Changing the chunker does not touch stored chunks. Delete and
re-add anything ingested before 2026-09-20 or it keeps its mid-sentence cuts.

### ⚠️ If this ever goes to production — the checklist is in `README.md`

**“Before you put this in production”**, at the top of [`README.md`](./README.md).
The two that are easiest to forget:

- **`pnpm scores`** — re-measure `MIN_SIMILARITY` on YOUR documents. The
  shipped 0.25 came from a three-chunk corpus of invented facts.
- **`pnpm eval`** — run the prompt battery on YOUR documents, **and use its
  result to decide the chat model.** `gpt-4o-mini` scored 5/6 here and `gpt-4o`
  scored 6/6 at ~16× the input cost; the case that separated them was applying
  a general rule where the document also stated an exception. If your content
  has carve-outs — pricing tiers, policy exceptions, eligibility bands — test
  both before choosing. Do not guess (D-005, D-017).

Also on that checklist: R-1 (the API key) and R-2 (RLS has no policies), both of
which stop being notes and become blockers the moment there is a public URL.

**Re-run `pnpm eval` after ANY edit to `buildPrompt()`.** It
checks both directions at once: that real questions get answered and that absent
facts still get refused. Losing the second is how the sourdough recipe happened.

**If you deploy this, two things stop being notes and become blockers:**
R-1 (the API key) and R-2 (RLS has no policies — `service_role` bypasses it).

**Server:** may still be running on port 3000. On Windows:
`Get-NetTCPConnection -LocalPort 3000 -State Listen` then `Stop-Process`.

## ✅ Done

- [x] Idea captured and intake filled — 2026-09-20 — `idea-intake.md`
- [x] Tech stack settled (3 dependencies, no framework) — 2026-09-20 — `techstack.md`
- [x] Architecture, data model, `match_chunks` SQL, prompt design — 2026-09-20 — `architecture.md`
- [x] MVP scope, out-of-scope list, 6-phase roadmap — 2026-09-20 — `mvp.md`
- [x] Both screens specified with all states — 2026-09-20 — `screens.md`
- [x] 14 decisions logged, 5 open questions — 2026-09-20 — `decisions.md`
- [x] Risks and cost model — 2026-09-20 — `risks.md`, `costs.md`
- [x] Build brief for the target repo — 2026-09-20 — `BUILD.md`
- [x] **`whats-done.md` written** — 2026-09-20 — a per-step explanation of
      Phases 0 and 1: what was done, why it mattered, and what each verified
      number proves. Companion to this file (`status.md` = what's next;
      `whats-done.md` = what happened and why).
- [x] **Q-3 resolved** — checked OpenAI's deprecations page 2026-09-20:
      `text-embedding-3-small` is **not** deprecated (community reports of an
      Oct 2026 shutdown are contradicted by the official page), and
      `gpt-4o-mini` is not scheduled for shutdown. `vector(1536)` stands.
- [x] **Phase 0.1–0.2** — OpenAI credits added and API key created — 2026-09-20
- [x] **Phase 0.3 + 0.5** — Supabase project created; `schema.sql` ran
      successfully — 2026-09-20. RLS enabled on all four tables (no policies),
      a deliberate amendment to D-006 — see `decisions.md` D-006 and `risks.md`
      R-2. `schema.sql` carries the `alter table ... enable row level security`
      lines so the file stays the source of truth.
      ⚠️ **The first run did not apply them** — the SQL editor still held the
      pre-amendment copy of the file, so the tables were created with RLS off
      and `pg_tables.rowsecurity` read false. Fixed by running the four
      `alter table` statements on their own. **Verified:** all four tables now
      report `rowsecurity = true`. Lesson for any future schema change: re-copy
      the file, and verify the effect rather than trusting "run succeeded".
- [x] **Code review fixes** — 2026-09-20. A review of the D-018/D-019 commits
      found 8 issues; all 8 verified by reproducing them, all 8 fixed.
      **Two were real silent-truncation bugs:** `chatStream()` treated *any*
      end of stream as success, so a dropped connection returned a half answer
      that was saved to the database and reported as complete; and an OpenAI
      error delivered inside a 200 response was skipped in silence. Both now
      throw. The client likewise required nothing of the stream — it now
      requires the `done` event.
      **One real chunker bug:** a short heading before an oversized paragraph
      became its own stub chunk (`"# Refund Policy"`, 15 chars), burning an
      embedding and a retrieval slot while severing the heading from its
      content — the exact failure D-018 exists to prevent. `current` is now
      folded into the text being split instead of flushed.
      The rest: a stream failure no longer loses the turn from history; the
      SSE error-send is guarded against a dead socket; Retry no longer
      duplicates the question; and two UI texts that D-018 had made false
      (the "estimate is exact" comment and the overlap hint) now say what is
      actually true. Regressions, prompt battery (5/6) and score probe all
      unchanged.
- [x] **`flow.md` written** — 2026-09-20. Mermaid diagrams of the implemented
      flow: system overview, ingest sequence, query sequence (including
      rewriting, hybrid search, the threshold gate and streaming), a
      where-it-goes-wrong map, the route table and the seven knobs. Every box
      names the file and function. `architecture.md` § 3 now carries a note
      saying its diagrams are the original design.
- [x] **Streaming responses (D-019)** — post-MVP, 2026-09-20. `chatStream()`
      in `src/openai.js` parsing OpenAI's SSE, `answerQuestionStream()` sharing
      `prepareAnswer()` with the blocking path, an SSE branch on
      `POST /api/chat`, and hand-rolled SSE parsing in `public/app.js`
      (EventSource cannot POST).
      **Measured:** sources on screen at **1,381 ms** versus **2,353 ms**
      before anything appeared at all — 1.7× sooner. Same tokens, same cost.
      **`meta` fires before the answer exists**, so the sources panel is
      readable while the model is still writing.
      Caught a real bug in testing: `req.accepts('text/event-stream')` matches
      `Accept: */*`, so every curl was being handed a stream it could not
      parse. Now an explicit header check; plain curl still gets JSON.
      Prompt battery **5/6, unchanged**.
- [x] **Paragraph-aware chunking (D-018)** — post-MVP, 2026-09-20.
      `chunkText()` packs whole paragraphs up to a `CHUNK_SIZE` ceiling; the
      old sliding window survives as the fallback for oversized paragraphs and
      for text with no blank lines. Sizes unchanged at 1000/150.
      **Northwind handbook: 3 chunks (1000/1000/907, cut mid-sentence) → 4
      chunks (584/804/720/937, every one ending on a full stop).**
      **Scores rose and separation widened:** direct hits 0.462→0.530,
      0.457→0.577, 0.536→0.588, while the absent question stayed at 0.427 and
      off-topic stayed under 0.10. `MIN_SIMILARITY` re-checked and left at 0.25.
      Prompt battery **5/6, unchanged** — no regression.
      Caught a bug in my own first version: the carried overlap tail was being
      emitted as a spurious extra chunk (1001 chars gave 3 chunks instead of 2).
      Fixed with a `carriedOnly` flag and covered by a regression check.
      ⚠ Only helps where the source has paragraph breaks; one unbroken wall of
      text still falls back to fixed-size cuts.
- [x] **Grounding instruction reworded (D-017)** — post-MVP, 2026-09-20.
      Separates connecting stated facts (allowed) from adding absent ones
      (never) from partial answers (say what is missing). Judged with a fixed
      six-case battery, `scratch/prompt-eval.js`, run before and after.
      **4/6 → 5/6**, and **all three refusal cases held** — which was the thing
      at risk. The one-step inference case now passes: "Who do I contact on
      extension 4417?" → *"You can contact the Kessler Seismograph Annex
      liaison at extension 4417."*
      ⚠ **Two things the prompt could not fix**, both worth knowing:
      the wrong-antecedent case is a **model** limit — identical prompt on
      `gpt-4o` scores **6/6**; and the partial-answer clause fails under a
      starved retriever (`MATCH_COUNT=1`), where **both** models still invent a
      reason rather than admit the gap. A second prompt attempt at the
      antecedent case gave no improvement and was removed.
- [x] **Query rewriting (D-016)** — post-MVP, 2026-09-20. `rewriteQuestion()`
      in `src/rag.js`, `chat()` extended with `maxTokens`/`temperature`/`label`,
      and an italic "searched for:" line in the sources panel.
      **The Phase 4 failure is fixed:** "When did they join?" went from
      **0 chunks + refusal** to a rewritten query of "When did the floor
      supervisor and the Operations Director join?", 3 chunks, and the correct
      answer naming Marisol Venn.
      **Measured cost:** 3 rewrite calls over a 4-turn conversation, 409 in +
      30 out, $0.000079 — **21%** on top of the answers, $0.00002/message.
      2 of 4 turns were left unchanged, so no over-rewriting.
      ⚠ **Does not fix generation.** The Phase 3 wrong-antecedent case still
      fails: the rewriter correctly resolved "that group" to "prospective staff
      badge holders" and the model still answered about auditors.
- [x] **Hybrid search (D-015)** — post-MVP, 2026-09-20. `schema-hybrid.sql`
      (GIN index, `to_or_tsquery`, `match_chunks_fts`), `retrieve()` in
      `src/rag.js` fusing both searches with Reciprocal Rank Fusion, and a
      `vector`/`keyword`/`both` badge in the sources panel.
      **Measured honestly:** on a 19-chunk corpus it changed **nothing** for
      four natural-language questions containing identifiers — vector search
      already ranked the right chunk #1 or #2 every time. The one clear win
      was a bare identifier typed alone: `NL-220` was **missed entirely** by
      vector-only (5 chunks passed the threshold, none contained it) and
      rescued at rank #2 by hybrid, producing the correct answer.
      Zero extra prompt tokens. Filler test documents removed afterwards.
      ⚠ **Hybrid fixes retrieval, not generation.** "Who do I contact on
      extension 4417?" now retrieves the correct chunk at rank #1 (confirmed by
      keyword) and the model **still refuses**, because answering needs a
      one-step inference from "reachable at" to "contact on". Logged in
      `notes.md`; the fix would be prompt work, not retrieval work.
- [x] **Phase 5 complete** — 2026-09-20. All six experiments run in fresh Node
      processes; `src/chunker.js` and `src/rag.js` backed up first and verified
      **byte-identical** after restoration. Findings written to `notes.md`
      (337 lines). Build instructions added to `README.md`.
      **Headline finding:** the threshold and the grounding instruction do
      different jobs — `MIN_SIMILARITY` protects **cost**, the "use ONLY the
      context" line protects **correctness**. Removing the threshold produced
      zero wrong answers (just 671 wasted tokens per off-topic question);
      removing the prompt line produced a full sourdough recipe cited to three
      lab-handbook chunks.
      **Caught a real hallucination:** at `MATCH_COUNT = 1` the model answered
      the Quiet Hour's hours correctly and *invented* its reason.
- [x] **Phase 4 complete** — 2026-09-20. **Verified working in a real browser by the user.** Five files in
      `public/` (~870 lines incl. CSS), plus `GET /api/documents/:id/chunks` and
      `getChunks()` — the route `screens.md` § S-2 implied but
      `architecture.md` § 5 never listed.
      **Verified server-side:** all six static assets serve with correct content
      types; every endpoint the UI calls returns correctly; no `console.log` and
      no `innerHTML` anywhere in `public/`; both frontend modules parse.
      **`src/chunker.js` is now served to the browser at `/chunker.js`** and
      imported by `admin.js`, so the live chunk estimate uses the server's own
      constants instead of duplicating them.
- [x] **Phase 3 complete** — 2026-09-20. `MIN_SIMILARITY` tuned from measured
      scores, `buildPrompt`, `answerQuestion`, message/conversation persistence,
      the no-results short circuit, `POST /api/chat` and
      `GET /api/conversations/:id/messages`.
      **The success criterion passed:** asked for the Bay 3 freezer temperature
      → "minus 68 degrees Celsius" with 3 sources; deleted the document; asked
      again → the refusal, with **zero** chunks and no OpenAI call.
      **Q-1 resolved** — see the decision note below.
- [x] **Phase 2 complete** — 2026-09-20. `src/chunker.js` (pure, overlap
      verified byte-identical), `src/openai.js` (`embed` batched + `chat`),
      `src/supabase.js`, `src/rag.js` (`ingestDocument`, `listDocuments`,
      `deleteDocument`), `server.js` with the three document routes, fail-fast
      env check and one-place error mapping. Verified by curl: a 2,607-char
      document became **3 chunks** (1000 / 1000 / 907) each with a 1536-dim
      embedding; overlap between chunks 0 and 1 byte-identical; all five
      validation paths return the right status; **R-7 rollback confirmed** —
      a forced embedding failure left zero orphan rows; DELETE cascaded 3
      chunks to 0.
- [x] **Phase 0.4 + 0.6** — `.env` filled; `pgvector` verified **functionally**
      from Node — a `vector(1536)` value inserted, read back and searched with
      the `<=>` operator, which cannot work unless the extension is live. The
      literal `select * from pg_extension` check was not run from Node because
      PostgREST cannot reach system catalogs; the functional proof is stronger.
- [x] **Phase 1.1** — `scratch/embed-test.js` prints **1536** — 2026-09-20.
      Model reported back as `text-embedding-3-small`, 2 prompt tokens.
- [x] **Phase 1.2** — `scratch/roundtrip-test.js` — vector round-trips intact:
      1536 numbers, max drift 3.6e-9 (pgvector stores float4, so single-
      precision rounding is expected and harmless). `match_chunks` returned the
      probe chunk at similarity **1.0000** against its own embedding, proving
      the column is a real vector and the search path works end to end. Delete
      cascaded: 0 chunks left. Probe rows cleaned up.
- [x] **Phase 1.3** — `scratch/chat-test.js` returns a completion — 2026-09-20.
      Served by `gpt-4o-mini-2024-07-18`, 23 in + 31 out tokens.
- [x] **Phase 0.7** — `npm init`, `"type": "module"`, 3 deps installed,
      `schema.sql`, `.gitignore`, `.env.example` written — 2026-09-20.
      Versions recorded in `techstack.md`: node 24.19.0, express 4.22.3,
      @supabase/supabase-js 2.116.0, dotenv 16.6.1. `typeof fetch === 'function'` ✓

## 🔨 In progress

- Nothing. The project is complete.

## ⏭️ Not started (MVP backlog)

Build order — pull from the top. Full detail in `mvp.md` § Roadmap.

**Phase 0 — Setup** ✅ complete
- [x] OpenAI account, credits, spending limit, API key
- [x] Supabase project created
- [x] Copy `URL` + `service_role` key into `.env`
- [x] Run `schema.sql` (incl. RLS on all four tables)
- [x] Verify `pgvector` enabled
- [x] `npm init`, `"type": "module"`, 3 deps, `.gitignore`, `.env.example`
- [x] `.env` filled with real values

**Phase 1 — Prove the API calls** ✅ complete
- [x] `scratch/embed-test.js` — embedding prints length 1536
- [x] Vector round-trips through Supabase as numbers, not a string
- [x] `scratch/chat-test.js` — a chat completion returns

**Phase 2 — Ingest** ✅ complete
- [x] `src/chunker.js` (pure, overlap visibly correct)
- [x] `src/openai.js` — `embed()` batched in one call
- [x] `src/supabase.js`
- [x] `rag.ingestDocument()`
- [x] `server.js` + `POST/GET/DELETE /api/documents`
- [x] Verified by curl

**Phase 3 — Query** ✅ complete
- [x] `match_chunks` via `.rpc()`, log real similarity scores
- [x] Tune `MIN_SIMILARITY` from those scores (Q-1) — **0.30 → 0.25**
- [x] `buildPrompt()` per `architecture.md` § 6
- [x] `rag.answerQuestion()` + `POST /api/chat`
- [x] Message + conversation persistence
- [x] No-results short circuit (skip OpenAI entirely)

**Phase 4 — UI** ✅ complete
- [x] `admin.html` + `admin.js` — add / list / delete / expand chunks
- [x] `index.html` + `app.js` — messages, input, send
- [x] Sources panel with similarity scores
- [x] Loading + error states from `screens.md`
- [x] `style.css`
- [x] `GET /api/documents/:id/chunks` (gap in `architecture.md` § 5)
- [x] **Walked through in an actual browser** — confirmed working

**Phase 5 — Understand it (the actual deliverable)** ✅ complete
- [x] Chunk size 300, then 4000 — note what breaks and why
- [x] `MIN_SIMILARITY = 0` on an unrelated question — watch it retrieve nonsense
- [x] `MATCH_COUNT` 1 vs 20 — cost/quality tradeoff
- [x] Remove the "use ONLY the context" line — watch it hallucinate; put it back
- [x] Check real OpenAI usage against `costs.md`
- [x] Write `notes.md`

**Post-MVP backlog** (optional, ordered by what the experiments justify)
- [x] Hybrid search (vector + Postgres full-text) — D-015
- [x] Query rewriting so retrieval sees conversation history — D-016
- [x] Prompt work on the generator — D-017 (4/6 → 5/6; the last one is a model limit)
- [ ] Decide whether `gpt-4o` is worth ~16× the input cost (6/6 vs 5/6)
- [x] `git init` + first commit — 2026-09-20, 32 files, `.env` verified excluded
- [x] Paragraph-aware chunking — D-018
- [x] Streaming responses — D-019

---

## 🚧 Blockers & open questions

**Blockers: none.** Both are resolved.

~~The OpenAI API key is invalid~~ — **replaced 2026-09-22 and working.**
`embed(['hello'])` returns 1536, and real grounded answers come back over both
the JSON and SSE paths. (It failed three different ways first: "expired", "has
been invalidated", "Incorrect API key provided".)

~~The eval/score baseline was never captured~~ — **closed by decision
2026-09-22**, not by capture. Phase 4 rests on structural parity instead; the
reasoning and what it does not cover are in `whats-done.md` § Phase 7, and the
evidence is in `plan/baseline/parity-final.txt`. The old note follows, for the
record.

**Superseded — the eval/score baseline has not been captured**
(`plan/steps.md`). Phase 4's definition of done is "`pnpm eval`
gives the same six verdicts as the baseline", and there is no baseline yet,
because capturing one means clearing the Villa Amihan corpus out of the
database — deferred by decision on 2026-09-21. Not urgent for Phases 1–3, which
touch no pipeline behaviour. Blocking from Phase 4 on. Commands in
[`plan/baseline/db-state.md`](./plan/baseline/db-state.md).

**Open questions** (full list in `decisions.md` § Open questions):

- ~~**Q-1** — What `MIN_SIMILARITY` actually works?~~ **Resolved 2026-09-20: 0.25.**
  Measured with `scratch/score-probe.js` on the Northwind corpus — direct hits
  0.46–0.54, paraphrases 0.40–0.45, an exact identifier 0.28, off-topic
  0.04–0.10. 0.25 sits in the empty gap. The planned 0.30 would have falsely
  refused the "extension 4417" question.
- ~~**Q-2** — Is 1000/150 the right chunk size for real documents?~~
  **Partly resolved 2026-09-20.** On this corpus 300 retrieved *better* than
  1000 (0.726 vs 0.462 top score) and cost 40% less — but at `MATCH_COUNT = 1`
  a 300-char chunk was too small to hold a complete answer and the model
  invented the missing half. 4000 collapsed the document to one chunk and
  inverted the ranking. Kept at 1000/150; paragraph-aware chunking is the
  real answer.
- ~~**Q-3** — Is `gpt-4o-mini` still the right cheap model?~~ **Resolved 2026-09-20:** both named models are current and not deprecated. Chat model stays swappable by env var (D-005); revisit in Phase 5 if desired.
- ~~**Q-5** — Keep or delete the `scratch/` scripts?~~ **Resolved: kept**,
  with `scratch/` in `.gitignore`. `score-probe.js` and `experiment.js` both
  earned their place in Phase 5 and are how you re-measure on a new corpus.

---

## 🗒️ Session log

### 2026-09-27 — booking types Phase 8 (the record)
- **Did:** decisions D-050–D-056, D-042 amended; risks R-23–R-30, R-15 and
  R-17 amended; CLAUDE.md, flow.md, the plan's status line.
- **Noticed while writing it:** `storage-orphans.mjs` was in the plan's file
  list and was never built. Recorded as such in R-30, not claimed.
- **Numbering:** plan/payments.md already reserved D-057+ and R-31+, so the
  range finding went onto R-15 instead of a new number.
- **Next:** the Phase 4 walk, the merge, then payments.

### 2026-09-27 — booking types Phase 7 (isolation and the bundle)
- **Did:** 10 checks in `packages/bookings/tools/isolation.mjs` (probes A and
  B, both per_room, one operator a member of both); 4 in
  `packages/rag/tools/isolation.mjs` (harbor ↔ villa: documents, the Wi-Fi
  token, the tool through executeTool); `plan/booking-types-phase7-bundle.mjs`.
- **Observed:** bookings 22/22 and 22/22 (`--filters-only`); pipeline 20/20
  and 20/20; B's room, rate, object and photo row byte-identical after
  everything A tried; the bundle: 0 files for every name and every secret
  value, on both builds, 46 static files; the scan finds
  `admin/accommodations` in 1 file, so it reads the right files.
- **Why probes, not harbor, as B:** a failing "cannot delete another
  tenant's photo" would have deleted a real photo.
- **Next:** Phase 8, the record.

### 2026-09-27 — booking types Phase 6 (the tool)
- **Did:** `roomTools()` in tools.ts and a per_room branch in executeTool
  (chosen from the database); `listRooms()`; `fixtures/harbor.json`,
  `harbor-units.json`, `harbor-bookings.json`; the loader
  `plan/booking-types-phase6-harbor.mjs` (idempotent, as harbor's operator);
  the battery loads harbor, seeds/removes its fixture, and counts a `rooms`
  group; `plan/booking-types-phase6-rows.mjs`.
- **Observed:** rt 10/10 three times; full battery 47/48, the original 38 at
  37/38 as in Phase 0 (`antecedent` only; `lang-followup` then 2/3 on
  repeat, a known coin-flip); tests 13/14/72/299; verify 69/69; isolation
  16/16 and 12/12 both ways; rooms 15/15.
- **Finding, not fixed:** for "from X to Y", D-046's resolver checks the two
  end dates as two single days, and the model does not ask for the range
  (7, 14 and 31 days all came back as 8 rows). Pre-existing; it affects
  villa's range questions too. dates.ts is prompt text, so a fix needs its
  own battery run.
- **Next:** Phase 7.

### 2026-09-27 — booking types Phases 4 (code) and 5
- **Did (4):** `accommodations-screen.tsx`, its page, `lib/money.ts`,
  `lib/resize-image.ts`, the per_room parts of `bookings-screen.tsx`, CSS.
  Photo limits reach the browser as props from the server page (one copy).
  Gave harbor `per_room` bookings and a Night slot; made a walk login.
- **Observed (4):** typecheck green; page codes as expected; the user's
  first upload stored as a 330×352 WebP with no EXIF. The walk's second round
  did not reach the database. The user chose to move on and check later.
- **Did (5):** `tenant:booking-type` in `tools/tenant.mjs`: it shows the type,
  and a switch is decided by the SQL trigger, whose message (with the count)
  is printed as is.
- **Observed (5):** 6/6: refused with "3 active units" and with "1 live
  booking(s)"; allowed back and forth once the booking was cancelled;
  whole_resort is stored as the ABSENCE of the key.
- **Next:** Phase 6.

### 2026-09-27 — booking types Phase 3 (routes)
- **Did:** seven route files (four new directories under `accommodations/`,
  `bookings/quote`), the `bookings` and `setup` changes, zod schemas (shape
  only), photo remove/reorder scoped to the room in the URL.
- **Observed:** walk 10/10: 401 on every new route without a cookie; one
  tenant's cookie refused by another; whole_resort 404 for rooms and quotes;
  a forged `price: 1` in the body stored as 350000 + 600000 = the quote;
  another tenant's unit 400 "No such unit or slot."; SVG named `.png` 400,
  3 MB 400, another tenant's room 404; delete via the wrong room 404. rooms
  15/15, verify 69/69, bookings isolation 12/12 both ways, tests unchanged.
- **Mistake, mine:** a full `pnpm build` while the user's `pnpm dev` was
  running rewrote `apps/web/.next` under it, and every page returned 500
  (`Cannot find module './535.js'`). The user restarted dev. Rule now: while
  dev runs, build packages only (`pnpm --filter @rag/<pkg> build`).
- **Next:** Phase 4, screens.

### 2026-09-27 — booking types Phase 2 (`@rag/bookings`)
- **Did:** database types for the new schema; `parseConfig`, `parseRooms`,
  `parsePrice`, `sniffImageType` (pure, tested); `createBookings`, `quote`,
  `checkRoomAvailability`, `requirePerRoom`, `listBookings` room filter;
  `accommodations.ts`; `images.ts`; `tools/rooms.mjs`.
- **Observed:** rooms 15/15 (after one test-date bug of mine: two dates found
  independently put Friday before Monday); tests 13/14/72/294; verify 69/69;
  isolation 16/16 and 12/12 both ways; `tool-*` 9/9; prompts identical.
- **Deviation:** the plan said `unitIds[]`; it is `rooms: [{ unitId,
  guestCount? }]`, because capacity is per room and so is the guest count.
- **Next:** Phase 3, routes.

### 2026-09-27 — booking types Phase 1 (schema)
- **Did:** steps 1–10 of `schema-booking-types.sql` (booking_type in config,
  unit columns, unit_rates, bookings.price/group_id, unit_price(), the
  extended insert trigger, check_availability skipping inactive units,
  check_room_availability, RLS and grants, unit_images) and verify checks
  49–68 on a per_room probe with a real member.
- **Observed:** first run 55 PASS / 14 FAIL, all from one cause: PostgREST
  sends a key missing from one row of a multi-row insert as NULL, not the
  default, so three test rooms had `active = null` (23502). Test data fixed
  (every row, every key); then 69/69. Villa and Northwind diff clean.
- **Then:** the user re-ran the file; verify 69/69 again, villa identical.
- **Next:** Phase 2.

### 2026-09-27 — booking types Phase 1 (Storage spike)
- **Did:** wrote `schema-booking-types.sql` § 11 (bucket `unit-images`,
  public read, 2 MiB, jpeg/png/webp; insert/select/delete policies on the
  first folder = token tenant AND app_is_admin, no update policy) and
  `plan/booking-types-phase1-storage.mjs`. The user ran the SQL.
- **Observed:** 9/9. Refusals confirmed by listing, not by the error.
  Villa staff's delete of harbor's photo: no error, 0 removed.
- **Next:** steps 1–10 of the schema.

### 2026-09-27 — booking types Phase 0 (baseline)
- **Did:** committed `plan/booking-types.md` and `plan/payments.md`
  (`e8fc28b`), branched `feat/booking-types`, saved the baseline, created
  `harbor` and its operator.
- **Observed:** tests 13/14/27/294; verify 48/48; isolation 16/16 both
  ways; bookings isolation 12/12 both ways; Northwind's prompt identical to
  `northwind-prompt-pre-bookings.txt`; villa's 14 days 42 rows, 42 open;
  battery **37/38** (`lang-followup` passed once), then `lang-followup` 1 of 4
  on repeat, so the baseline is the usual 36/38.
- **Deviation:** the plan said create harbor first; the baseline was taken
  first and verify + bookings isolation + the Northwind snapshot re-run
  after, so "harbor changes nothing" is measured, not assumed.
- **Next:** Phase 1, the Storage spike.

### 2026-09-26 — session 8, continued (Taglish replies, D-043)
- **Did:** added `packages/rag/src/language.ts` (explicit-request detection,
  code-side language detection, the prompt lines, and the reply to a bare
  request). `buildPrompt()` got a sixth parameter: language lines, appended
  last. `answer.ts` reads the user's messages (≤ `LANGUAGE_SCAN_MESSAGES` =
  50, tenant-filtered) to decide the language. Added 10 `lang-*` battery
  cases and unit tests (103 in the pipeline, all passing).
- **Observed before:** `eval-lang-before.txt` 5/10. Tagalog questions got
  0.00 English share, a Taglish question got plain English, and tool answers
  were English.
- **Deviation:** the first fix was prompt only, and it was abandoned. It
  measured 5 → 7 → 9 → 7 of 10, and pulled English questions into Taglish.
  The classifying moved to code (D-043).
- **Observed after:**
  - lang 9/10 twice (`eval-lang-after-run7/8.txt`);
  - the full battery 26/29 (`eval-lang-full.txt`); `lang-tagalog-2` failed
    once at 0.90 English, then passed 4/4 repeats;
  - the northwind snapshot is identical, isolation 11/11 both ways, verify
    47/47, bookings isolation 12/12;
  - `pnpm typecheck`, `test` and `build` are all green.
- **Known:** `lang-followup` keeps Taglish after a bare date, but at 0.13
  English, below the 0.20 floor.

### 2026-09-26 — session 8, continued (merge)
- **Did:** fast-forwarded `master` to `feat/auth-rls` (`git merge --ff-only`).
  `master` was an ancestor, so 11 commits came across (the plan, then Phases
  0–8), with no merge commit. `master` is at `f3ea70b`. Nothing is pushed.
- **Owed on `master`:** the three email checks (R-21).

### 2026-09-26 — session 8, continued (auth-rls Phase 8, the record)
- **Did:**
  - CLAUDE.md: rules 2 and 6 rewritten, rule 8 and traps 11–14 added;
  - decisions: D-038, D-040, D-041 and D-042 added, D-006 superseded, and
    D-028's key superseded;
  - risks: R-2, R-11 and R-13 amended, and R-19, R-20 and R-22 added;
  - architecture.md, flow.md and README.md updated for tokens, policies,
    staff and the signing key;
  - a status line on the plan.
- **Checked:**
  - no doc still tells a reader to use an admin key or `tenant:key`;
  - the architecture overview no longer says the server holds the
    service_role key.
- **Next:** the three email checks, then the merge.

### 2026-09-26 — session 8, continued (auth-rls Phase 7)
- **Did:**
  - the user walked steps 1–5 in the browser as `villa-staff-test`;
  - the northwind invite failed on the email cap (no account was created);
  - two fresh production builds, with the bundle grepped each time.
- **Observed:**
  - the dev log confirms the walk (doc #90, booking #185, a tool call,
    login and logout);
  - the bundle has 0 hits for every name and every secret value, across 36
    files, in both builds, and the positive control hits.
- **Found:** grepping for a secret's VALUE only proves something on a build
  that HAD the secret, so the grep was re-run on a full-`.env` build.
- **Owed:** the northwind invite, step 6 in the browser, and the reset
  email, all waiting on R-21's cap.
- **Next:** Phase 8.

### 2026-09-26 — session 8, continued (auth-rls Phase 6)
- **Did:**
  - deleted `admin-key.ts`, `tenant:key` and the key half of `tenant.mjs`;
  - `schema-auth.sql` § 7 drops `admin_key_hash`, and the user ran it;
  - wrote `scripts/check-service-imports.mjs`, now in the root `typecheck`.
- **Observed:**
  - the column is gone (`42703`), and `tenants` has 8 columns;
  - the guard caught both planted imports, then passed;
  - fresh `next build` passes without the service key;
  - all suites and staff cases pass after the drop.
- **Found (my mistake):** removing the planted import with `git checkout --
  packages/db/src/index.ts` also reverted my uncommitted edit to that file,
  which brought the deleted admin-key export back. Caught by the diff check
  straight after, and re-applied. Remove a plant by editing it out, never by
  checking out a file that has other uncommitted work.
- **Next:** Phase 7.

### 2026-09-26 — session 8, continued (auth-rls Phase 5)
- **Did:**
  - `@rag/db` `staff-auth.ts`: `signInStaff`, `staffClient`,
    `requestPasswordReset` and `setPasswordWithToken`;
  - rewrote `admin-auth.ts` (a four-part cookie; an async `requireAdmin`
    returning a staff context);
  - all 9 guarded handlers now use `tenant = await requireAdmin(…)`;
  - the login form takes email + password, with "Forgot password?";
  - the reset page and its two routes;
  - 429 added to the error map;
  - `member.mjs` plus the operator helpers in `@rag/db/service`, and the
    tools moved onto operator tokens;
  - `staff-cases.mjs`.
- **Observed:**
  - the six cases pass, and admin writes work again, all with the web
    process holding no service key;
  - all the suites hold;
  - the browser invite flow works.
- **Found:**
  - my first bookings check proved nothing, because a chat token also gets
    `200 []`. It now books a real row and reads back its guest name.
  - Supabase refuses to send to `example.com` (a 500, versus 200 for an
    unknown email), and the built-in sender hit its hourly cap
    (`over_email_send_rate_limit`). That became R-21, with an accurate error
    message.
  - `member.mjs`'s `process.exit(1)` crashed Node on Windows with a libuv
    assertion, so it now throws instead.
- **Next:** retry the reset email, then Phase 6.

### 2026-09-26 — session 8, continued (auth-rls Phase 4)
- **Did:**
  - dropped `SUPABASE_SERVICE_ROLE_KEY` from env.ts's REQUIRED list;
  - made `admin-auth.ts` import `@rag/db/service` lazily, with its own
    missing-key error;
  - wrote `plan/auth-phase4-walk.sh`, and ran it against `pnpm dev` with the
    key set and with it empty.
- **Observed:** the chat lines are identical in both runs (the diff excluded
  only ids, delta counts and the admin line). The admin login gives 401
  with the key, and a 500 naming the key without it.
- **Found:**
  - the walk's first draft asked "What time is check-in?", which the villa
    documents do not answer, so the refusal was grounded. It also gave an
    ISO date, and the model asked "Which date do you mean?" and called no
    tool. Neither was an auth effect. Both were replaced with the phrasing
    the passing suites use.
  - Unsetting a key for `next dev` means setting it EMPTY. The dotenv loader
    in next.config refills a missing variable from `.env`.
- **Next:** Phase 5.

### 2026-09-26 — session 8, continued (auth-rls Phase 3)
- **Did:**
  - `@rag/db`: `tenant-client.ts`, the `./service` entry, and `supabase`
    removed from the main entry;
  - `TenantContext.db` and `BookingTenant.db`, with all 22 call sites on
    `tenant.db`;
  - `loadTenant` and `loadBranding` on `tenant_public`;
  - `env.ts` requires `SUPABASE_PUBLISHABLE_KEY` and `TENANT_SIGNING_JWK`;
  - the tools moved to `@rag/db/service` for setup;
  - rag isolation gained `--filters-only`;
  - verify uses the shipped signer.
- **Key swap:** a fresh key `45345cbc…` was imported as standby. The
  dashboard allows only one standby at a time, so `ea5ce335…` had to go
  first, and it is now revoked (`401`).
- **Observed:**
  - build and typecheck clean, unit tests pass;
  - verify 47/47;
  - isolation 11/11 and 11/11 `--filters-only`, bookings isolation 12/12;
  - eval 18/19 with identical verdicts; snapshot identical.
- **Found:** sourcing `.env` into bash strips the quotes from the JWK JSON,
  and `--env-file` does not override an existing variable, so verify then
  failed with a JSON parse error. Never `. ./.env` in a shell that runs the
  tools.
- **Next:** Phase 4.

### 2026-09-26 — session 8, continued (auth-rls Phase 2)
- **Did:**
  - wrote `plan/auth-phase2-explain.sql`: `auth_explain(query, seqscan)`
    for service_role, and `auth_explain_token`, which needs an
    `app_explain` claim;
  - added `auth-spike.mjs phase2`;
  - wrote the result into `notes.md`.
- **Observed:**
  - every pair has the same scan, and the token adds `InitPlan` plus
    `One-Time Filter: ((InitPlan 1).col1 = 3)`;
  - the ids are identical for both functions;
  - with HNSW forced, service_role walks `chunks_embedding_idx` while the
    token uses `chunks_tenant_idx` with the policy qual as its Index Cond;
  - a chat token without `app_explain` gets `42501`.
- **Chosen:** no change.
- **Next:** Phase 3.

### 2026-09-26 — session 8, continued (auth-rls Phase 1)
- **Did:**
  - wrote `packages/db/sql/schema-auth.sql`: `memberships`, the two
    helpers, 17 policies on 9 tables (none on `tenants`), a
    security-definer `check_availability` with a tenant check,
    `tenant_public()`, and the EXECUTE grants;
  - added checks 28–46 to `verify.mjs`, which mint ES256 tokens with
    `TENANT_SIGNING_JWK`, newly in `.env`;
  - added the auth types to `database.types.ts`.
- **Observed:**
  - verify 47/47;
  - eval 18/19 with the same verdicts;
  - isolation 11/11 and 12/12; snapshot identical.
- **Found:**
  - the first run failed the wrong-tenant booking check with `23503`. A
    trigger refused the probe's unit before RLS ran, so the test used villa's
    own unit and slot, and then got `42501`.
  - Both service keys reach Postgres as `role: service_role` in
    `auth.jwt()`. The legacy service_role JWT is still accepted, so the
    legacy secret is still live.
- **Next:** Phase 2.

### 2026-09-26 — session 8 (auth-rls Phase 0)
- **Did:**
  - wrote `plan/auth-phase0-spike.sql` (`whoami()`, plus `auth_explain()`,
    which only `service_role` can execute) and
    `packages/db/tools/auth-spike.mjs` (hand-rolled ES256/HS256 on
    `node:crypto`);
  - generated an EC P-256 key into `scratch/`, and the user imported it as a
    standby JWT signing key;
  - ran the baseline.
- **Observed:**
  - **Option A:** `401 PGRST301` before the import, `200` with
    `{"role":"authenticated","tenant_id":3}` after it.
  - **Supabase Auth sign-in:** `200` through `whoami`, signed by
    `cb77f580…`.
  - **Baseline:** 28/28, 11/11, 12/12, 18/19, and the snapshot is identical.
- **Found:**
  - bookings isolation has always had 12 checks. "13" in CLAUDE.md and the
    plan was a miscount, now corrected there; historical entries are left
    as written.
  - The spike key's private half appeared in the transcript. Phase 3 must
    use a fresh key and delete `ea5ce335…`.
- **Also:** sign-up + sign-in rate limit is 30 (dashboard), shared.
- **Next:** Phase 1.

### 2026-09-24 — session 7, continued (auth + RLS planning)
- **Did:** branched `feat/auth-rls`, and committed the #27 record there
  (`851c517`). Wrote [`plan/auth-rls.md`](./plan/auth-rls.md) after three
  questions:
  - staff log in with **Supabase Auth**;
  - RLS covers **the anonymous chat path too**, through server-minted tenant
    tokens;
  - **one role**.
- **Found:** the `.env` holds the new-style Supabase keys and a JWKS URL, so
  the project signs JWTs asymmetrically. Minting our own tenant tokens is
  therefore not guaranteed, and Phase 0 is a spike with three ranked options
  and a stop condition.
- **Next:** Phase 0.

### 2026-09-24 — session 7, continued (after the merge)
- **Did:** fast-forwarded `master` to `23a84cd` (11 commits) and deleted
  `feat/bookings`. On master: typecheck 11/11, tests 99, verify OK. The user
  then cancelled booking #27 from the admin screen, with this repo's
  `next dev` on :3000.
- **Observed:** #27 is `cancelled`. `check_availability` for 2026-10-22..23
  is 6 of 6 open.
- **So:** the Phase 4 walk's step 4 (cancel in the UI frees the slot) is
  confirmed, not just the route.

### 2026-09-24 — session 7, continued (bookings Phase 8, the record)
- **Did:**
  - `CLAUDE.md`: the header, the flow line, rule 6 extended, a new rule 7,
    trap 6 amended, new traps 8–10, the conventions and layout.
  - `decisions.md`: D-032–D-037, and D-008 amended.
  - `risks.md`: R-14–R-18, and the "still missing" list.
  - `architecture.md` § 4–6, `flow.md` (the diagram and step 11a),
    `notes.md` (the bookings section), `README.md`.
- **Observed**, for `notes.md`: the same villa question with the same 5
  chunks, tools off → on: 1,260 → 1,682 and 1,279 → 1,701 input tokens, so
  **+422 per answer call**.
- **Not done:** `todo.md` (your edits are in it). Tool-call latency (not
  measured, and said so).
- **Next:** merge, the two loose ends, then choose the next plan.

### 2026-09-24 — session 7, continued (bookings Phase 7)
- **Did:**
  - `chat-screen.tsx`: `toolCalls` on the answer turn, and a `tool` event
    handler.
  - `sources-panel.tsx`: `ToolCallBox`, an always-visible "Checked
    availability · <date>" with a day row of `slot-chip`s. Errors show in red,
    and an unknown tool is shown as raw JSON.
  - CSS for `.checked` and `.tool-call`.
- **Observed:**
  - Build clean, bundle grep 0.
  - curl SSE: `meta → tool → 32 deltas → done`. Northwind JSON: refusal,
    `toolCalls: []`.
  - **The walk (user):** passed, and the log confirms it:
    - slot-filling: 0 tool calls, then `2026-10-08`, 3 open;
    - 23 Oct: 1 open of 3;
    - the docs question: 0 tool calls, 5 sources;
    - Northwind: 0 chunks and no OpenAI call;
    - also tried: 22 Oct, 0 open of 3.
- **Next:** Phase 8, the record.

### 2026-09-24 — session 7, continued (availability replies name the date)
- **Did:**
  - Added a `namesDate()` check to `tool-open`, `tool-taken`, `tool-partial`
    and `tool-slotfill`. It was tested against 7 samples, including rejecting
    "18 October" for the 8th.
  - `tools.ts`: a first sentence that names the date, then the Open/Taken
    lines. Then scoped to availability answers.
- **Observed:**
  - Before, tool cases: 6/9 (`tool-open`, `tool-partial` and `tool-slotfill`
    had no date).
  - Unscoped wording: tool cases 9/9, but the full battery was **17/19**:
    `leak-2`'s villa control refused.
  - `leak-2` alone, 3 runs each: unscoped 1/3, previous wording 3/3, scoped
    3/3.
  - Scoped, full battery: **18/19** (`original 9/10 · tool 9/9`). The
    original verdicts are identical, and so is the Northwind prompt.
  - `tool-partial` now reads "No, the Day Tour and 22-Hour Whole Day slots
    are taken on 5 October 2026, but the Overnight slot is open."
  - The fixture was removed, and #27 is untouched.
- **Next:** Phase 7, the chat screen.

### 2026-09-24 — session 7, continued (Phase 6 wording fixes)
- **Did:**
  - Tightened `tool-ask` (the refusal string is now a fail), `tool-partial`
    (an "…available:" heading is a fail) and `tool-past` (the lenient
    refusal branch is removed).
  - Added `--only <prefix>` to the eval, with totals over the cases that ran.
  - Rewrote the tools block's instructions in `tools.ts`, twice.
- **Observed** (tool cases only):
  - Before the fix, tightened: 6/9, the three failing with the Phase 6
    wording.
  - Prohibitions ("never introduce…", "do not add…"): 7/9. Only `tool-past`
    was fixed: "1 January 2020 is in the past. Today is 2026-09-24."
  - Positive instructions ("two lines, Open: / Taken:", "your whole reply is
    one question"): 9/9. `tool-ask`: "Which date are you referring to for
    availability?"
  - Full battery: 18/19 (`original 9/10 · tool 9/9`). The original verdicts
    are identical, and so is the Northwind prompt. The fixture was removed
    and #27 is untouched.
- **Found:** replies are now form-like ("Open: 22-Hour Whole Day, Day Tour,
  Overnight / Taken: None") and often omit the date.
- **Next:** Phase 7, or first make the format carry the date.

### 2026-09-24 — session 7, continued (bookings Phase 6)
- **Did:**
  - Added `packages/rag/src/tools.ts`: `toolsFor()` builds `check_availability`
    from the tenant's real slot names, and `executeTool()` checks the
    application again, parses the arguments, and returns input errors as
    `{error}`.
  - Added `MAX_TOOL_ROUNDS = 2` and `ToolCallRecord`, and `Answer.toolCalls`.
  - `buildPrompt(…, tools)` appends a block after END CONTEXT, only when there
    are tools.
  - `answer.ts`: a `toolLoop()` shared by both paths, plus `acceptReply()`
    (D-035). A tenant with no tools keeps the old path verbatim.
  - The chat route sends a `tool` SSE event.
  - `prompt-snapshot` now goes through `toolsFor()`.
  - Added `fixtures/villa-bookings.json`, 9 `tool-*` cases, and
    `prompt.test.ts` (4 tests).
- **Observed:**
  - **Eval:** 18/19 (`original 9/10 · tool 9/9`). The original verdicts match
    `eval-pre-bookings.txt` line by line.
  - **Isolation:** 11/11. The Northwind prompt diff is empty. Tests total 99.
  - **Tool calls:** `tool-leak`: 0 tool calls, 0 answer calls to OpenAI.
    `tool-slotfill`: "8 October" with no year became
    `{"date_from":"2026-10-08","date_to":"2026-10-08"}`.
  - **Cost:** tool-tenant answer calls were 1,251–1,680 input tokens.
  - **Streaming:** `meta → tool → 35 deltas`. For the zero-match "capital of
    France?" on villa, the reply was held, D-035 replaced it, and 1 delta was
    sent. That cost 485 in + 11 out, where it used to cost nothing.
  - The fixture was removed afterwards, and #27 is untouched.
- **Findings:**
  - `tool-ask`'s reply begins with the refusal string.
  - `tool-past`'s model gave the bare refusal after the tool's "in the past"
    error.
  - `tool-partial` is headed "available" above a list of taken slots.
- **Next:** Phase 7.

### 2026-09-24 — session 7, continued (bookings Phase 5)
- **Did:** tool calling in `@rag/openai`, still raw fetch:
  - `ChatMessage` is now a union over four roles, adding `tool`.
  - New types `ToolDefinition`, `ToolCall`, `WireToolCall` and `ChatTurn`.
  - `chat` / `chatStream` overloads keyed on `tools`, a per-index accumulator,
    and `holdContent`.
  - `assistantToolCallMessage` and `toolResultMessage`.
  - The tool-call count in the log line, only when tools were offered.
  - Added vitest to the package.
- **Observed:**
  - 14/14 new tests, and the repo total is 95 (13 + 27 + 14 + 41).
    Typecheck is 11/11.
  - The tests cover a call split across 3 events, a network cut inside the
    arguments string, interleaved indexes 0/1, `holdContent`, no `[DONE]`
    (502 with the partial text), and a missing id.
  - Without tools, the body keys are exactly
    `messages,model,stream,stream_options,temperature` and the log line is the
    old one.
  - Real calls: chat 91+21 with 1 tool call; stream 91+21 with 1 tool call,
    both `{"date_from":"2026-10-12"}`; round trip 147+15, a text answer, with
    the deltas equal to `content`.
- **Finding:** given "Overnight open" only, the model said "The villa is
  available … on 12 October". This goes into Phase 6's prompt and battery.
- **Next:** Phase 6.

### 2026-09-24 — session 7, continued (bookings Phase 4)
- **Did:**
  - Added `app/t/[tenant]/admin/bookings/page.tsx`, which calls `notFound()`
    unless `hasApplication`.
  - Added `components/bookings-screen.tsx`: a create form, a 14-day list of
    open/taken chips plus that day's bookings, and cancel.
  - Moved `LoginForm` and `describeFailure` into `components/admin-login.tsx`.
  - Added a Bookings link on the knowledge-base admin page, shown only when
    the application is enabled, and a bookings section in `globals.css`.
- **Observed:**
  - Typecheck is 11/11, and the build lists `/t/[tenant]/admin/bookings` at
    3.5 kB.
  - The bundle grep for `service_role|guest_phone|admin_key|SUPABASE` finds
    0 files.
  - Pages: Villa's bookings page is 200, Northwind's and `nope`'s are 404.
    The Bookings link appears on Villa's admin page (1) and not Northwind's (0).
  - **The walk (user):** reported as passed. The database shows #27, Overnight
    2026-10-22, `["2026-10-22 06:00:00+00","2026-10-23 04:00:00+00")`,
    `confirmed`. The log shows `[error] That slot on 2026-10-23 overlaps an
    existing booking.` There is no cancelled row, so step 4 is unconfirmed.
- **Next:** Phase 5. Also: decide whether to keep #27.

### 2026-09-24 — session 7, continued (bookings Phase 3)
- **Did:**
  - Added the `APPLICATIONS` registry and `enabledApplications()` in
    `packages/rag/src/applications.ts`.
  - Added `apps/web/lib/applications.ts`: `requireApplication()` and
    `hasApplication()`, memoised with `cache()`.
  - `lib/route.ts`: `CLIENT_STATUSES` {400,401,404,409}, applied to errors
    that are not `OpenAIError`.
  - Added `createBookingSchema`, which checks shape only.
  - Four routes: `bookings` (GET/POST), `bookings/[id]` (DELETE, which
    cancels), `bookings/availability` and `bookings/setup`.
  - README curls; `web` now depends on `@rag/bookings`.
- **Observed:**
  - Typecheck is 11/11, and the build lists all four routes.
  - 27 curl cases against `next start --port 3100`, using the throwaway
    `bookprobe` (id 24), since deleted:
    - no cookie → 401; the application off → 404; setup reports today as
      `2026-09-24`;
    - create → 201; the same slot → 409; Day the morning after Night → 409;
    - `2026-02-30` → 400; a past date → 400 with "Today is 2026-09-24";
      a blank name → 400; Villa's unit id → 400 "No such unit or slot.";
    - 40 days → 400; cancel → 200, with availability back to open;
      a nonexistent id → 404; `nope` → 404;
    - bookprobe's valid cookie at `villa` and `northwind` → 401.
  - Afterwards: tenants `northwind` and `villa`, 0 bookings.
- **Caught:** the first cross-tenant cookie test sent no cookie. The curl jar
  writes httpOnly cookies as `#HttpOnly_` lines, and a comment filter removed
  them. Re-run with a real cookie, which was verified by getting past admin at
  its own tenant.
- **Next:** Phase 4.

### 2026-09-24 — session 7, continued (bookings Phase 2)
- **Did:** created `packages/bookings` (`@rag/bookings`, depends on `@rag/db`
  only), containing `constants.ts`, `validate.ts` (pure), `errors.ts`,
  `types.ts` and `bookings.ts`. Added `validate.test.ts` and
  `tools/isolation.mjs`.
- **Observed:**
  - **Tests and typecheck:** 27 new tests pass, alongside pipeline's 41 and
    chunker's 13. Typecheck: 10/10 tasks.
  - **Isolation, 13/13:**
    - Northwind gets a 404 from all three calls.
    - A second Villa booking on the same slot gets `409 "That slot on
      2027-07-21 overlaps an existing booking."`
    - The probe tenant sees 0 of Villa's bookings, and cancelling Villa's
      booking returns `false` with it still confirmed.
    - Villa's unit id gets the same "No such unit or slot." as a
      nonexistent one.
    - Availability keys are `date,slot,status,unit`.
  - **Cleanup:** afterwards, only `northwind` and `villa` exist, with 0
    bookings.
  - **Rule 6 grep:** all 7 queries in `bookings.ts` carry a tenant.
- **Also observed:** at 01:04 SGT, the Manila date is 2026-09-24 while UTC is
  still 2026-09-23. A server-UTC "today" would be one day behind right now.
- **Next:** Phase 3.

### 2026-09-24 — session 7, continued (bookings Phase 1)
- **Did:** wrote `schema-bookings.sql`: `btree_gist`, `tenant_applications`
  with a timezone trigger, `units`, `slots`, `bookings` with composite FKs and
  the `bookings_no_overlap` exclusion constraint, a `bookings_compute_during`
  trigger, `slot_range()`, `check_availability()`, and the Villa seed. Added
  hand-written types and verify checks 15–28. The user ran the SQL.
- **Observed:** verify 28/28. Overnight 2026-10-01 in Manila is
  `["2026-10-01 06:00:00+00","2026-10-02 04:00:00+00")`. An overlap fails with
  `23P01 … "bookings_no_overlap"`. An unknown timezone fails with `22023`.
  Cross-tenant unit and slot fail with `23503`. After the run: 0 bookings, and
  only `northwind` (1) and `villa` (3) remain.
- **Deviations:** a trigger computes `during` instead of the planned
  `create_booking()` RPC. Verify has 28 checks, not "about 20".
- **Next:** Phase 2.

### 2026-09-24 — session 7, continued (bookings Phase 0)
- **Did:** captured the baseline. Added `packages/rag/tools/prompt-snapshot.mjs`
  and its `prompt-snapshot` script, which prints `buildPrompt()` output for
  fixed chunks and history.
- **Observed:** verify 14/14 (documents 9, chunks 34, conversations 265,
  messages 688). Isolation 11/11. Eval 9/10: `antecedent` FAIL, the other nine
  PASS, 12 OpenAI chat calls. Northwind's prompt file is 18 lines, sha256
  `d6337d0f21c8b478e045c801181168e95b56355057c4fb4331abcef2fb046ba8`.
- **Next:** Phase 1, the slot seed waiting on the owners' answers.

### 2026-09-24 — session 7 (bookings planning)
- **Did:** wrote [`plan/bookings.md`](./plan/bookings.md): a code registry of
  applications plus a `tenant_applications` table, a `@rag/bookings` package
  (domain logic that both the admin routes and the chatbot tool call directly),
  an admin booking screen, hand-written tool calling in `@rag/openai`, and one
  read-only tool, `check_availability`.
- **Found:** Villa does not have rooms. It sells three whole-property slots,
  and two of them cross midnight (`02-rates-and-schedules.md`). So bookings are
  `tstzrange`s with an exclusion constraint. D-008's short circuit would make
  the tool unreachable, so it is reworded (D-035) rather than removed.
- **Next:** Phase 0, then the § 8 questions for the owners.


### 2026-09-23 — session 6, continued (tenancy Phase 8)
- **Did:** the record. decisions.md got D-025 to D-030 and the D-006
  amendment. risks.md got R-10 to R-13 and the R-2 amendment. architecture.md
  and flow.md were redrawn for the tenant-aware Next.js app; the §2 overview
  and §3 diagrams still showed the Express POC and were fixed too. CLAUDE.md
  got rule 1 amended and a new rule 6. README.md got the setup and fixture
  loading. plan.md's "Eight phases" became "Nine phases, numbered 0–8".
- **Observed:** the README loader, run verbatim against a throwaway
  `loadprobe` tenant, gave 9 documents and 34 chunks (northwind 4, villa
  3/4/5/4/4/3/3/4). The tenant was deleted and 0 of its documents remain.
- **Next:** nothing required. See plan.md § 7 for the optional follow-ups.

### 2026-09-23 — session 6, continued (tenancy Phase 7)
- **Did:** Moved the screens into components, driven by Server Component
  pages under `app/t/[tenant]/`. Added the branding allowlist, `BrandHeader`,
  the assistant's name above its turns, the admin login and logout, the
  not-found page, and a static root. Added `countDocuments()`.
- **Observed:** villa renders
  `style="--accent:#0f766e;--accent-soft:#e7f5f2;--bg:#faf7f2"` and northwind
  renders no style (the defaults). The titles are "Villa Amihan Private Resort"
  and "Northwind Labs". The hostile theme values rendered 0 times. `/t/nope`
  and `/admin` give 404. The user walked both tenants in the browser, and all
  steps passed.
- **Next:** Phase 8.

### 2026-09-23 — session 6, continued (tenancy Phase 6)
- **Did:** Admin auth, hand-rolled on `node:crypto`: scrypt hashes with the cost
  stored inside the hash, and HMAC session cookies scoped to `/api/t/<slug>`.
  Added the session route, `requireAdmin()` on the four admin handlers, and the
  `tenant:add` / `tenant:key` tools. The user set `ADMIN_COOKIE_SECRET` (43
  characters) and issued keys for both tenants.
- **Observed:** hashing takes 50 ms, and verify returns true / false / false /
  false for the right key, a wrong key, a null hash and junk. All 16 curl
  cases pass, against the throwaway tenants `authprobe` (11) and `nokeyprobe`
  (12), both deleted. The key appeared 0 times in the dev log.
  `tenant:add Bad.Slug` fails with `tenants_slug_shape`. The static bundle
  grep is clean. Tests pass (41 + 13), and verify is 14/14.
- **Deviations:** the cookie path, where the hashing lives, and `tenant:key`
  (see "Next up").
- **Next:** Phase 7, the screens.

### 2026-09-23 — session 6, continued (tenancy Phase 5)
- **Did:** Moved the five route files to `app/api/t/[tenant]/`, file by file.
  `git mv` of the `documents` directory failed with `Permission denied`, most
  likely a Windows handle. Replaced `bridgeTenant()` with `withTenantRoute()`,
  which resolves the slug, returns 404 on a miss, and is built on
  `withRoute()`. Updated the table and curl examples in `apps/web/README.md`.
- **Observed:** a clean build lists only the five `/api/t/[tenant]/…` routes.
  Typecheck and test pass (41 + 13). The curl done-when passes: northwind
  shows only document 37, villa only 38–45, `nope` gives 404, the old paths
  give 404, cross-tenant access gives `[]` and 404, and SSE works.
- **Known gap:** the screens fetch the old paths until Phase 7.
- **Next:** Phase 6, admin auth.

### 2026-09-23 — session 6, continued (tenancy Phase 4)
- **Did:** `buildPrompt(tenant, …)` gets one persona line, and the grounding
  block is untouched. `greetingReply(message, tenant)` and
  `greetingText(tenant)` replace `GREETING_REPLY`. The battery gained a tenant
  per case plus leak-1, leak-2 (with a villa control), leak-3 and persona.
  Greeting tests: 41 (was 40). Renamed villa's assistant to "Lia".
- **Observed:** 9/10 twice. The six original verdicts are identical to Phase 0,
  with antecedent still giving the auditor 1:1 answer. leak-2: northwind
  `keyword:0`, villa `keyword:1`. leak-3: `null` against the owner's 2
  messages.
- **Decided:** the optional persona sentence was left out, because the
  verdicts were identical without it.
- **Next:** Phase 5, the routes.

### 2026-09-23 — session 6, continued (tenancy Phase 3)
- **Did:** Added `TenantContext` and `loadTenant()` (which selects four explicit
  columns). Made `tenant` the required first argument of `ingestDocument`,
  `listDocuments`, `deleteDocument`, `getChunks`, `retrieve`, `answerQuestion`,
  `answerQuestionStream` and `getMessages`. Fixed § 2.2:
  `ensureConversation()` now verifies ownership, and `getMessages()` returns
  `null` for "not yours / not there". Updated `database.types.ts` to the
  bridge-free schema. Pinned the existing routes to northwind with
  `bridgeTenant()`. Pointed eval and scores at northwind by name. Added
  `tools/isolation.mjs`. Rewrote `schema-tenancy.sql` so step 9 removes the
  bridge, and the user re-ran it.
- **Observed:** 15/15 grep lines show a tenant. Build, typecheck and test pass
  (40 + 13). Isolation passes 11/11, both with and without the bridge. Eval is
  5/6 with the same verdicts; `absent-2` stays refused with villa loaded. The
  score probe output is byte-identical to `scores-pre-tenancy.txt`. Verify is
  14/14. After the removal: `PGRST202` for the old functions and `23502` for a
  tenant-less insert. Over HTTP: northwind-only list, villa document 38 gives
  `[]` and `404`, and the parking question is refused.
- **Found:** `listDocuments()` had been broken since Phase 1. Two foreign keys
  now link chunks to documents, and PostgREST would not pick one. Neither
  verify nor eval calls it. It is fixed with `chunks!chunks_document_tenant_fk(count)`.
- **Deviation:** `plan.md` asks for `tools/parity.mjs` at 22/0, but that script
  compared against `apps/legacy-poc`, which was deleted in migration Phase 7.
  Substituted: the eval verdicts, the score-probe diff against Phase 0, and the
  isolation suite.
- **Next:** Phase 4, the persona.

### 2026-09-23 — session 6, continued (tenancy Phase 2)
- **Did:** Seeded tenant `villa` (id 3; id 2 was the deleted verify probe) with
  the 8 sample documents, using a direct-insert script, because the bridge
  would have written them to northwind. Added the temporary, locked-down
  `plan/tenancy-phase2-explain.sql` helper; the anon key gets
  `42501 permission denied`. Ran 15 explain scenarios. Added iterative scan to
  `match_chunks`, and the user re-ran `schema-tenancy.sql`.
- **Observed:** the tenant filter plans as `Index Scan using chunks_tenant_idx`
  plus a sort, which is exact. With HNSW forced and ef_search 2, villa went
  from 0 rows to 5 with `strict_order`. The Phase 0 ids are unchanged. Verify
  is 14/14. The bridge leak was confirmed: the old function returns villa
  chunks 153/151/152 for the parking question.
- **Deviation:** the plan expected an HNSW Index Scan. The planner picked the
  B-tree instead. Recorded in `notes.md`, with the forced-HNSW runs as the
  substitute measurement.
- **Next:** Phase 3. (`tenancy_explain` was dropped afterwards and now returns `PGRST202`.)

### 2026-09-23 — session 6, continued (tenancy Phase 1)
- **Did:** Wrote `packages/db/sql/schema-tenancy.sql`, which the user ran in the
  SQL editor successfully. Extended `packages/db/tools/verify.mjs` from 10 checks
  to 14.
- **Observed:** verify **14/14**. NULL `tenant_id` counts are 0 · 0 · 0 · 0.
  The cross-tenant chunk insert was refused with `23503` on
  `chunks_document_tenant_fk`. `match_chunks(own)` returns chunk 137 at
  1.000000, and `match_chunks(probe tenant)` returns 0 rows. `tenants` holds
  only `northwind` (id 1), because the probe tenant was cleaned up. Eval:
  **5/6**, the same verdicts as Phase 0.
- **Decided:** D-031, the temporary bridge, chosen by the user over following
  the plan literally or merging Phases 1 and 3.
- **Not exercised:** a new ingest through the bridge default. The eval covers
  conversation and message inserts, but not document or chunk inserts.
- **Next:** Phase 2. The villa corpus must be written with an explicit
  `tenant_id`.

### 2026-09-23 — session 6 (tenancy Phase 0)
- **Did:** Deleted the 8 Villa Amihan documents (ids 27–34, with the user's
  go-ahead). The first Northwind ingest failed with `HTTP 401: Your API key has
  been invalidated`, and the R-7 cleanup removed the half-made document 36
  (DB checked: 0 documents, 0 chunks). The user put in a new key, and Northwind
  loaded as document 37 → 4 chunks (137–140).
- **Observed:** eval `5/6 as intended`, where the only FAIL is `antecedent`
  ("auditor groups ... one per one"), matching D-017. Scores: top 0.588 (Quiet
  Hour), 0.530 (freezer), 0.286 (`extension 4417`), off-topic ≤ 0.092.
  pgvector 0.8.2.
- **Deviation:** `plan.md` asks for five chunk ids per question, but the corpus
  has four chunks, so four were recorded.
- **Next:** Phase 1 (schema). Baseline committed as `78d243f`.

### 2026-09-22 — session 5 (tenancy planning)
- **Did:** Wrote [`plan.md`](./plan.md) — multi-tenancy, 8 phases, each with an
  observable "done when". This is the plan `plan/steps.md` § 7 deferred and the
  Phase 3 callout warned would be expensive if decided late. It was decided
  late; the plan says what that costs.
- **Three decisions taken before writing, because they are the expensive ones:**
  a tenant is a path segment `/t/<slug>` rather than a subdomain (D-026);
  admin is a per-tenant scrypt-hashed key behind a path-scoped signed cookie,
  hand-rolled on `node:crypto` (D-028); and per-tenant persona **is** in scope,
  which is what makes the eval baseline mandatory (D-029).
- **The finding that changed the plan's shape:** `ensureConversation()`
  (`packages/rag/src/answer.ts:18`) returns a client-supplied `conversationId`
  unverified, and `getMessages()` (`:259`) has no tenant filter at all. Harmless
  in a single-tenant app; with tenants it is two holes — post tenant A's uuid to
  tenant B's chat endpoint and A's history is pasted into B's prompt, and any
  uuid reads its own full transcript. Written up as `plan.md` § 2.2 with the fix
  in Phase 3 and three `leak-*` eval cases to catch a regression.
- **The trap that is genuinely new:** an HNSW index does not know what a tenant
  is, so `where tenant_id = …` is a **post**-filter — Postgres walks the graph
  in distance order and discards non-matching rows, giving up after
  `hnsw.ef_search` (40) candidates. At two tenants that is free; at fifty a
  small tenant can get **zero rows** back and the bot refuses a question it
  could answer, with `[retrieve] vector:0` in the log as the only sign. Phase 2
  exists solely to measure it (`explain analyze` must still say
  `Index Scan using chunks_embedding_idx`), and it is logged as R-10.
- **One liability turned into an asset:** `CLAUDE.md` rule 1's "load
  `fixtures/northwind.json` and nothing else" exists because the Villa corpus
  describes parking and `absent-2` needs parking refused. Under tenancy the two
  corpora become two tenants and that same case asserts something stronger —
  parking **is** in this database and still unreachable from this tenant. Rule 1
  gets amended in Phase 8.
- **Next:** `plan.md` Phase 0. Nothing in the plan is implemented.

### 2026-09-21 — session 3 (migration planning + Phase 0)
- **Did:** Wrote [`plan/steps.md`](./plan/steps.md) — the full migration from
  the Express + vanilla-JS POC to a Turborepo monorepo running Next.js and
  TypeScript. 8 phases, each with an observable "done when".
- **Then:** implemented migration Phase 0.
- **The finding that made Phase 0 worth doing first:** the eval battery's corpus
  was not in version control. `tools/prompt-eval.js` asserts on Bay 3, extension
  4417 and the violet badge ratio — facts that existed only in
  `scratch/testdoc.json`, and `scratch/` is gitignored. The battery `CLAUDE.md`
  names as the gate on every `buildPrompt()` change was one `git clean -fdx`
  from being unrunnable, and no fresh clone ever had it. Now committed at
  `fixtures/northwind.json` (2,607 chars — matches the figure in `notes.md`).
- **Also:** moved `todo.txt` out of `sample-documents/` to `todo.md` at the
  root. It sat among eight files whose instructions are "paste each of these
  into the admin page"; it is not corpus.
- **Observed, recorded in `plan/baseline/db-state.md`:** 8 documents / 30 chunks
  / 150 conversations / 428 messages. The loaded corpus is Villa Amihan, not
  Northwind. Also: `embedding` comes back from PostgREST as a **string** that
  parses to 1,536 numbers — not the trap from `CLAUDE.md` § 5 (the column is a
  real `vector`; `<=>` works), but it is what the type generator will see in
  migration Phase 3.
- **Decided:** do **not** capture the eval/score baseline yet, because it means
  deleting the Villa Amihan documents. The two corpora cannot share a database
  for this: `03-amenities` documents parking, so the eval case `absent-2` would
  get a real answer and be scored a failure.
- **Stopped at:** Phase 0 complete except the measurement.
- **Next:** migration Phase 1 — the workspace skeleton.

### 2026-09-22 — session 4, continued (greeting handling, D-024)
- **Did:** `hi` returned the refusal; it now returns a greeting.
  `packages/rag/src/greeting.ts` — pure, no I/O — runs before the rewrite,
  embedding and search, so a greeting costs nothing and returns instantly.
- **Where it deliberately did NOT go:** the knowledge base. A greetings
  document would compete for the MATCH_COUNT slots on every search, so small
  talk in one of five slots is a chunk of the real answer that never reaches
  the prompt.
- **Designed around the worse failure:** a question mistaken for a greeting
  gets a canned hello with no sources and no explanation. The pattern is
  anchored at both ends, rejects anything with a question mark, and rejects
  anything over 24 normalised characters.
- **Verified:** 40 unit cases (most of them negative) and a live 6/6 check.
  The one that mattered: `hi, what is the Wi-Fi password?` still answers with
  three sources. Both refusal cases still refuse.
- **Next:** nothing required.

### 2026-09-22 — session 4, continued (Phase 6 signed off)
- **Did:** Ran `pnpm dev` and checked both screens by hand. All four steps of
  the `mvp.md` definition of done pass on the new stack — the document list and
  its chunks, the live estimate, a streamed answer with its sources panel
  arriving before the text, and the refusal after the document is deleted.
- **Why it mattered:** every other part of the migration was proved by diffing
  against the old implementation. The screens had no counterpart to diff once
  they became React, so using them was the only way to know.
- **Stopped at:** Phases 0–7 done and signed off. The migration is functionally
  complete.
- **Next:** nothing required. Phase 8 (deploy) is optional and D-013 still says
  local-only until someone decides otherwise.

### 2026-09-22 — session 4, continued (migration Phase 7 — cutover)
- **Decided first:** Phase 4's eval baseline was never captured, and deleting
  the POC would make any old-versus-new comparison impossible forever. Offered
  the choice; **closed Phase 4 on structural parity instead** (87/0 chunker,
  22/0 pipeline, 24/0 API). Recorded as a real limitation rather than a
  formality — retrieval and prompt assembly are proved identical, the model's
  half is not.
- **Captured before deleting:** `plan/baseline/parity-final.txt`, the two parity
  runs that cost nothing. They cannot be re-run now.
- **Deleted:** `apps/legacy-poc/`, the three parity tools that imported it, their
  scripts and turbo task, and `BUILD.md` (byte-identical to `CLAUDE.md` since
  the repo was created). **Kept:** the 13 vitest cases, which state what the
  chunker should do rather than what it used to do.
- **Verified after:** build, typecheck, 13 tests, db verify 10/10, and the
  § 2.1 secret grep — **0 files** for all six patterns.
- **Rewrote `CLAUDE.md`.** It said: no TypeScript, no framework creep, three
  dependencies, `server.js` at the root. Every one of those was false. A brief
  that lies to the next agent is worse than no brief.
- **Amended `decisions.md`:** D-009 superseded, D-013 noted, D-014 **reversed**
  with its original reasoning left intact, and D-020..D-023 added. D-020 records
  honestly that the TypeScript port caught nothing already broken — both real
  bugs were found by running things.
- **Bannered rather than rewrote** `architecture.md`, `flow.md`, `mvp.md`,
  `screens.md`: their content is still accurate, only file names moved, and
  rewriting them would destroy the record of what was planned.
- **Stopped at:** Phase 7 complete.
- **Next:** click the screens (Phase 6 sign-off), then Phase 8 deploy.

### 2026-09-22 — session 4, continued (migration Phase 6)
- **Did:** Both screens in React — `app/page.tsx` (S-1), `app/admin/page.tsx`
  (S-2), `components/sources-panel.tsx`, `lib/chat-stream.ts`, and
  `style.css` copied verbatim to `app/globals.css`.
- **The `chunker.js` static-serve hack is gone.** The admin page imports
  `@rag/chunker` directly, and the rendered HTML says **"0 characters · ≈ 0
  chunks (1000 chars, 150 overlap)"** — those numbers come from the package the
  server chunks with. One definition, no static route, no drift.
- **The § 2.1 grep finally means something,** because client components did not
  exist before this phase: `service_role`, `SUPABASE_SERVICE`, `sk-proj`,
  `eyJhbGci` and both live key prefixes all appear in **0 files** under
  `.next/static/`. `SUPABASE_SERVICE_ROLE_KEY` appears only in a server chunk.
- **The state distinction that had to survive the rewrite:** a failure arriving
  *after* the answer started keeps the partial text and puts the error beneath
  it; a failure before it replaces the turn with Retry. Throwing away text the
  model already produced is worse than showing it with a warning.
- **One React-specific fix:** scrolling belongs in `useLayoutEffect`, not
  `useEffect` — after paint means a visible jump on every delta.
- **`textContent` vs `innerHTML` is now free** (React escapes children) but the
  comment stays, because the rule returns the moment anyone adds markdown via
  `dangerouslySetInnerHTML`.
- **NOT verified:** anything needing a browser. Browser tooling was declined
  this session, so streaming render, click-to-expand, Retry and the delete
  confirm are compiled and reasoned about but unclicked. Checklist in
  `whats-done.md` § Phase 6.
- **Stopped at:** Phase 6 built, not signed off.
- **Next:** click the screens; then Phase 7 cutover.

### 2026-09-22 — session 4, continued (migration Phase 5)
- **Did:** The six endpoints as Route Handlers in `apps/web`, with `withRoute()`
  holding the error map, zod at the boundary, and the chat route doing both
  deliveries from one handler.
- **Verified properly:** ran the Express POC on **:3099** and Next on **:3000**
  at the same time and diffed every response — **24 comparisons, 0
  differences**, bodies as well as status codes, because the screens render the
  `error` string verbatim.
- **The dead key was useful here.** It is the cheapest way to exercise the two
  hardest paths: an upstream 401 reaching the client *as* a 401 with OpenAI's
  own sentence, and a failure after the headers have gone out arriving as an
  `error` event inside a 200. Both servers behaved identically.
- **Regression I introduced and fixed:** the env check began as a module-scope
  throw. A module that throws while loading never finishes loading, so the
  handler never exists, so `withRoute` never runs — the client got Next's
  generic 500 HTML and the real message went only to the log, which is exactly
  what `architecture.md` § 9 forbids. Now logged at import *and* thrown per
  request via `assertEnv()`.
- **Also:** `lib/limits.ts` split from `lib/env.ts`, because the admin page
  needs `MAX_CONTENT_LENGTH` in the browser and `env.ts` is `server-only`. That
  removes the POC's `// must match server.js` duplication.
- **Housekeeping:** killed an orphaned Express server still holding port 3000
  from the Phase 1 check — `TaskStop` had killed the pnpm wrapper, not the node
  child. The note about this in "Next up" is there for a reason.
- **Stopped at:** Phase 5 complete.
- **Next:** Phase 6, the two screens.

### 2026-09-22 — session 4, continued (migration Phase 4)
- **Did:** Ported all 645 lines of `rag.js` into `@rag/pipeline`, split five
  ways — `constants`, `types`, `ingest`, `prompt`, `retrieve`, `answer`. Ported
  both tools by changing **only their import lines**; the six eval cases and the
  scoring loop are byte-identical, because a gate rewritten alongside the thing
  it guards is not a gate.
- **Proved, with no API key — 22 comparisons, 0 differences:** all seven
  constants, `buildPrompt` on four inputs, `retrieve` on seven live queries, and
  `listDocuments` / `getChunks` / `getMessages`. The query vector is an
  embedding already stored in a chunk row, so the whole run is free.
- **Why that retrieve coverage matters:** the seven queries produce different
  shapes — `keyword:0` (pure vector), `keyword:4` with a chunk rescued by
  keyword alone, and `keyword:10` with heavy overlap. That exercises RRF fusion
  in every mode, which is where a porting mistake would have stayed invisible
  until someone asked about an identifier.
- **NOT proved, and why Phase 4 stays open:** `ingestDocument`,
  `rewriteQuestion`, `answerQuestion`, `answerQuestionStream` all call OpenAI.
  `pnpm eval` resolves every module, loads `server-only`, runs the pipeline and
  dies at the first `embed()` — which proves the wiring and nothing about the
  behaviour.
- **The key failed a third way today:** *"Incorrect API key provided"*, after
  *"expired"* and *"has been invalidated"*.
- **One fidelity slip, caught by reading an error dump:** every `OpenAIError`
  carried `partial: undefined`, because TS compiles a declared class field to a
  `defineProperty` under `target: ES2022`, where the JS left the property
  absent. Fixed with `declare`; verified the own properties are now `status,
  name` only.
- **Stopped at:** Phase 4 code complete, verification partial.
- **Next:** new key → baseline → close Phase 4 → Phase 5 (API routes).

### 2026-09-22 — session 4, continued (migration Phase 3)
- **Decided:** **single tenant.** The plan called Phase 3 the last cheap moment
  to add `tenant_id`; the answer was no, so the port stays a port and the
  Phase 4 eval comparison stays meaningful.
- **Did:** `@rag/db` — both `.sql` files moved in with `git mv`, the POC's
  `supabase.js` ported verbatim plus `createClient<Database>`, hand-written
  `database.types.ts`, `MatchRow` / `FtsRow` / `parseStoredVector`, a 10-check
  verification script, and a README.
- **Verified, 10/10, with no API key:** all four tables readable (8 / 30 / 153 /
  428 rows), embedding parses to 1536 finite numbers, `match_chunks` rows match
  `MatchRow`, and **a chunk searched against its own embedding returns itself at
  similarity 1.000000** — the cheapest possible proof that the column is a real
  vector rather than text that merely round-trips.
- **The guard, proven both ways:** plain `node` importing `@rag/db` throws
  *"This module cannot be imported from a Client Component module"*;
  `node --conditions=react-server` imports fine. So a Client Component leaking
  the service-role key is a build error, not a code review.
- **The cost of that, found by testing:** plain Node has no `react-server`
  condition either. **From Phase 4, `pnpm eval` and `pnpm scores` need
  `--conditions=react-server`** or they cannot run at all.
- **Deviation:** types are hand-written from the committed `.sql` files. The
  generator needs credentials this repo does not carry, and the direct database
  host no longer resolves (`getaddrinfo ENOTFOUND db.<ref>.supabase.co` —
  Supabase is IPv6-only for direct connections now). Writing them by hand forced
  two decisions a generator would have made silently: the vector column is typed
  `string` (what PostgREST actually returns), and `id` is `never` in Insert on
  the `generated always as identity` tables.
- **Stopped at:** Phase 3 complete.
- **Next:** replace the API key, capture the baseline, then Phase 4.

### 2026-09-22 — session 4 (migration Phase 2)
- **Did:** Ported `src/chunker.js` and `src/openai.js` to TypeScript as
  `@rag/chunker` and `@rag/openai`. Built `tools/parity.mjs`, 13 vitest cases,
  and wired `build` / `typecheck` / `test` / `parity` through turbo.
- **The number that matters:** parity is **87 comparisons, 0 differences** — 17
  documents (8 sample docs, the Northwind fixture, 8 synthetic shapes) across 4
  chunk configurations, plus `estimateChunkCount` and both constants. The
  synthetic shapes exist because no real document exercises the branches most
  likely to break: whitespace-only input, a 3,500-char wall with no blank lines,
  heading-plus-oversized-paragraph, CRLF, multi-byte characters.
- **One real change, deliberate:** `OpenAIError extends Error` with
  `readonly status: number`, replacing a property bolted onto a plain Error.
  Same behaviour; the route layer's whole error map is built on that property.
- **Still blocked:** `embed(['hello'])` → 1536. The key now reports *"Your API
  key has been invalidated."* rather than *"expired"* — same 401, different
  upstream sentence, both recorded. The failure did verify the error contract:
  `OpenAIError`, `status` the number 401, message formatted as before.
- **Build lesson worth keeping:** `rootDir`/`outDir` in a shared tsconfig
  resolve against **that file's** directory, not the package extending it
  (TS6059). The shared config now holds only path-independent options.
- **Stopped at:** Phase 2 complete.
- **Next:** Phase 3 (`@rag/db`) — needs no API key, but does need a tenancy
  decision before Phase 4 writes the queries.

### 2026-09-21 — session 3, continued (migration Phase 1)
- **Did:** Branched `feat/nextjs-migration`. Built the workspace — pnpm 12.5.1
  via corepack, turbo 2.11.2, `pnpm-workspace.yaml`, `turbo.json`,
  `packages/tsconfig`. `git mv`'d the POC into `apps/legacy-poc/`; all 15 files
  recorded as 100% renames, so `git log --follow` still works.
- **Verified:** every route and static asset serves from the new home;
  `/api/documents` returns real rows; all nine frozen constants read back
  correct; both tools pass `node --check`; express/supabase-js/dotenv resolve to
  **the same versions as the Phase 0 baseline**, so changing package manager did
  not move the dependency graph.
- **Found — the blocker:** the **OpenAI API key has expired**. The end-to-end
  question returned a 401 carrying OpenAI's own sentence. This is not fallout
  from the move; it is evidence the move worked, since the key was read from
  `.env` at the new path and rejected as *expired* rather than missing. It also
  proved the error map end to end: upstream 401 → client 401, real message
  intact.
- **Deviations, all recorded in `whats-done.md` with reasoning:** pnpm 12 not 9;
  the fixture stays at `fixtures/` until a package actually reads it;
  `--env-file=../../.env` in the launcher rather than moving `.env`, which keeps
  every source file byte-identical.
- **Also:** banners on `README.md`, `CLAUDE.md` and `BUILD.md` — they described
  root-level paths and forbade TypeScript. Rewritten properly at Phase 7.
- **Stopped at:** Phase 1 complete.
- **Next:** replace the API key; then Phase 2 (`@rag/chunker` first — its parity
  check needs no key).

### 2026-09-20 — session 2 (build start)
- **Also did (later in session):** Supabase project created and `schema.sql` ran
  clean. Hit the SQL editor's "creates tables without RLS" warning — anticipated
  by R-2. Enabled RLS on all four tables with no policies and wrote the
  `alter table` statements into `schema.sql`; amended D-006 and R-2 to record
  that the POC now ships with RLS on. Nothing about the server changes:
  `service_role` bypasses RLS.
  The first run missed the RLS statements (stale paste in the editor) — caught
  it by checking `pg_tables.rowsecurity`, re-ran the four alters, confirmed all
  four now true.
- **Did:** Read the full doc set. Verified the OpenAI model lineup against the
  official deprecations page (Q-3, R-8) — `text-embedding-3-small` is not
  deprecated, so `vector(1536)` and the schema stand unchanged. Wrote
  `schema.sql` (architecture.md § 4 verbatim, incl. `match_chunks`),
  `package.json`, `.gitignore`, `.env.example`. Installed the three
  dependencies and recorded actual versions in `techstack.md`.
- **Decided:** Keep `gpt-4o-mini` and `text-embedding-3-small` as specified —
  no reason found to deviate. Did not `git init` yet (not asked).
- **Stopped at:** Phase 0.7 complete. Everything local is ready.
- **Then:** `.env` filled. Ran all of Phase 1 — embedding returns 1536,
  a vector round-trips through Supabase with only float4 rounding drift,
  `match_chunks` scores a chunk against its own embedding at 1.0000, delete
  cascades, and a chat completion returns. All three items on `risks.md`
  § "What to validate before committing real time" are now green.
- **Then:** built all of Phase 2. Four modules plus `server.js`, ~330 lines.
  Ingest verified end to end by curl, including the two failure paths that are
  easy to get wrong and invisible when you do: the R-7 orphan rollback and the
  delete cascade. Left a 3-chunk test document (id 4) loaded for Phase 3.
- **Decided:** `listDocuments` uses PostgREST's `chunks(count)` aggregate so the
  admin list never fetches embeddings (~6 KB each). `chat()` sends
  `temperature: 0.2` — the task is faithful reporting of context, not invention.
  `embed()` sorts the response by its `index` field rather than trusting array
  order, so a reordered response can never silently pair chunks with the wrong
  vectors.
- **Then:** built all of Phase 3. Measured similarity scores before tuning
  anything, which changed the threshold from the planned 0.30 to 0.25.
  Verified grounded answers, the short circuit, multi-turn pronoun resolution,
  and the full delete-and-ask-again success criterion.
- **Decided:** refusals are persisted to `messages` too, which the flowchart in
  `architecture.md` § 3.2 does not show. A transcript with gaps would make a
  later "what about the second one?" resolve against the wrong turn.
  Also added `MAX_MESSAGE_LENGTH = 2000` at the chat route boundary — not in
  the plan, but a question is embedded as one unit and anything longer is a
  document pasted into the wrong box.
- **Observed limitation (not a bug):** a third-turn follow-up, "and what is the
  escort ratio for that group?", resolved "that group" to auditors rather than
  the violet-badge holders established in turn 2. Retrieval was correct; the
  model picked the wrong antecedent. Worth revisiting in Phase 5.
- **Then:** built all of Phase 4 — both pages, the sources panel, all states,
  hand-written CSS. Added the missing chunks route. Served `src/chunker.js` to
  the browser so the live estimate shares the server's constants rather than
  copying them.
- **Found (structural, not a bug):** a follow-up question with no nouns of its
  own — "When did they join?" after a turn about the Operations Director —
  retrieves **0 chunks** and gets the refusal, even though the answer is in the
  document. **Retrieval embeds only the raw question; conversation history goes
  to the generator, never to the retriever.** Query rewriting is the standard
  fix and is post-MVP. Worth a paragraph in `notes.md`.
- **Then:** user walked the UI in a real browser and confirmed it works. Phase 4
  closed; the whole MVP (F-1 through F-10) is now built and working end to end.
- **Then:** ran all of Phase 5 and wrote `notes.md`. Added setup and run
  instructions to `README.md` (the planning pitch was kept below them).
- **Learned, in short:** the threshold is a cost gate, not a correctness gate;
  the grounding instruction is the correctness gate and it is weaker than it
  looks when *part* of an answer is retrieved; retrieval quality is decided by
  chunk size more than by anything else; the entire project cost under a cent.
- **Then:** implemented hybrid search on request (D-015) — the first post-MVP
  feature. Wrote `schema-hybrid.sql`, added RRF fusion in `retrieve()`, and put
  a which-search-found-it badge in the sources panel.
- **Measured, and it is a smaller win than expected:** on 19 chunks, vector
  search already found the identifier chunk at rank #1 or #2 for every phrased
  question. Hybrid only changed the outcome for a **bare identifier typed
  alone** (`NL-220`), which vector-only missed completely. Its value scales
  with corpus size; on three chunks it is nearly invisible.
- **Then:** implemented query rewriting (D-016), the second post-MVP feature.
  It fixed the Phase 4 follow-up failure outright and costs 21% more per
  conversation, not the ~100% first estimated — the rewrite prompt carries only
  the transcript, while the answer prompt carries the retrieved chunks.
- **The pattern across both post-MVP features:** each one fixed *retrieval* and
  neither touched *generation*. The remaining wrong answers are all the model
  declining a one-step inference or choosing the wrong antecedent while holding
  the correct chunk. Prompt work, not retrieval work.
- **Then:** reworded the grounding instruction (D-017) against a fixed
  before/after battery rather than by eye. 4/6 → 5/6 with every refusal intact.
- **The most useful thing learned:** "Do not guess" reads to a model as "do not
  reason", and that one phrase was causing it to refuse questions whose answer
  was sitting in the retrieved chunk. Separating *connect* from *add* fixed it
  without loosening the refusals at all.
- **And the limit of prompting:** an instruction to admit a gap loses to the
  pull to finish a sentence. Under a starved retriever both `gpt-4o-mini` and
  `gpt-4o` still invented a reason. That one is fixed by retrieving enough
  context, not by wording.
- **Then:** implemented paragraph-aware chunking (D-018), the last retrieval
  improvement on the list. Re-ingested and re-measured rather than assuming:
  true-positive scores rose by 0.05–0.12 while absent and off-topic questions
  stayed flat, so the threshold's gap widened and 0.25 still holds.
- **Worth noting:** my first version of the new chunker had a real bug — the
  carried overlap tail was emitted as an extra chunk on input with no paragraph
  breaks. Caught only because I checked the new code against the old chunker's
  output on the same input. A regression check now covers it.
- **Then:** implemented streaming (D-019), the last item on the original
  post-MVP list. Content negotiation rather than a second route, so every curl
  example in the docs still works unchanged.
- **The bug worth remembering:** `req.accepts()` honours wildcards, and curl
  sends `*/*`. The "polite" negotiation helper silently did the opposite of
  what it looked like it did. An explicit header check is both more obvious and
  correct.
- **Next:** nothing. Every post-MVP item except auth and deployment is done,
  and those two are deliberate non-goals (D-006, D-013).

### 2026-09-20 — session 1 (planning)
- **Did:** Created the idea folder from a short Q&A. Wrote the full planning set:
  intake, README, architecture (incl. complete schema + `match_chunks`), mvp,
  screens, techstack, decisions, risks, costs, BUILD.
- **Decided:** No RAG framework and no `openai` SDK — raw `fetch`, hand-written
  chunking and retrieval (D-001, D-002), because the project's goal is
  comprehension, not velocity. pgvector in Supabase rather than a separate
  vector DB (D-003). Plain JS, no TypeScript, no build step (D-014). Local only,
  no auth, no deployment (D-006, D-013).
- **Stopped at:** planning complete; folder is a self-contained handoff package.
- **Next:** copy the folder into a new repo, then Phase 0 — OpenAI credits first.
