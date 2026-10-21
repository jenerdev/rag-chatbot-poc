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
>
> **Every price says which rate it is** since 2026-09-30 (D-082):
> `rate_kind()` (`sql/schema-rate-kind.sql`) is the ONE place a date is
> weekday, weekend, holiday or peak, and `unit_price()` asks it, so the label
> and the amount are the same branch. The tool's price TEXT carries it,
> "₱20,000.00 (weekend rate)"; the tool's definitions are unchanged. A price
> asked with no date gets fixed words in code, not the refusal (D-081). The
> amount quoted is the DAY price, a holiday's surcharge in
> (`check_room_availability().day_price`, `sql/schema-day-price.sql`, D-083):
> unit_quote()'s own price with no guest count, never the base rate alone.
>
> **A new chat can offer suggested questions** since 2026-09-30 (D-089): up to
> six per tenant, set by a super user on the platform tenant form, stored in
> `tenants.suggested_questions` (shape checked in SQL) and read through
> `tenant_public()`. A click sends the question as if typed.
>
> **Owners and admins manage slots** since 2026-09-30 (D-090), on the Slots
> screen. A slot's start time and length are fixed while an upcoming booking
> uses it (`slots_times_fixed`); a slot ever booked is RETIRED (`active =
> false`), not deleted, and a retired slot takes no new booking from anyone
> (`bookings_slot_active`). `listSlots()` returns active slots unless asked
> for history; availability leaves retired slots' rows out.
>
> **Lists in a reply are tables** since 2026-10-04 (D-091,
> [`plan/tables.md`](./plan/tables.md), Phases 0–5, all done, walk included).
> The chat draws ONE block syntax, a pipe table, with a hand-written parser
> (`apps/web/lib/tables.ts`) into elements, never HTML; everything else is
> still text. `packages/rag/src/tables.ts` writes the tables code makes (the
> D-087 room list, the rate card for an undated price, D-081 amended), and
> the tool instruction lines show the model one to write. The rate kind is
> named once in the sentence, not in every cell (D-082 amended). No tool
> definition and no base prompt changed; the battery judges `tableOk` on
> the list answers and its absence on a one-slot price (Rule 4).
>
> **Replies carry an emoji where one fits** since 2026-10-04 (D-092): one
> paragraph in `buildPrompt()`, so northwind's snapshot baseline is now
> `northwind-prompt-post-emoji.txt`; `isRefusal()` tolerates a decorated
> marker and `storedReply()` saves it exact. `**bold**` is drawn too
> (D-091 amended), still as elements, never HTML.
>
> **A booking is born pending** since 2026-10-04 (D-095): the staff route
> inserts `pending`, `PATCH /bookings/[id]` confirms (the whole group, one
> statement) or cancels, and confirming is what takes the span;
> `schema-pending-default.sql` is the column default. Every decision takes a
> **note** (D-096, `decision_note`, `schema-decision-note.sql`), shown on
> the row. Tools that seed bookings pass `status: 'confirmed'`.
>
> **A tenant defines promos** since 2026-10-04 (D-097,
> [`plan/promos.md`](./plan/promos.md), Phases 0–6; the walk owed). A promo
> is fixed or percent (an integer: centavos, or hundredths of a percent), a
> validity range over the STAY dates, an optional code, an optional usage
> limit. ONE SQL function, `promo_discount()`, makes every discount; the
> trigger and `request_booking()` store it and `price` net of it, the two
> quotes preview the same rows. A customer reaches a promo only through
> `promo_for_request()` (definer); a chat token reads nothing from `promos`.
> Uses are counted, never stored, and the limit holds under the request
> lock on both doors. Owners and admins manage them at
> `/t/<slug>/admin/promos`; the booking page takes a code, the staff form a
> picker. The chatbot is untouched: no prompt text, no tool text.
>
> **Every member has a dashboard** since 2026-10-05 (D-098,
> [`plan/dashboard.md`](./plan/dashboard.md), Phases 0–6; the walk owed).
> `/t/<slug>/admin/dashboard` (S-11, the FIRST staff link) draws ONE
> `jsonb` that `tenant_dashboard()` computes in SQL in the tenant's day
> (`sql/schema-dashboard.sql`, the 19th file): attention counts, today's
> arrivals, chat volume and refusals, the knowledge base, stays by status
> and source, occupancy (per_room), promo uses, and `money` for owners and
> admins only, withheld as `null` by the function itself. The screen never
> adds a figure; the charts are `bar-chart.tsx`, inline SVG, no library.
> `platform_dashboard()` (the eleventh definer function) gives `/platform`
> a counts-only Pulse strip. `?days=7|30|90`, clamped. The chatbot is
> untouched: the three baselines are byte-identical.
>
> **A pending booking cannot be born on a confirmed span** since 2026-10-05
> (D-099, [`plan/staff-clash.md`](./plan/staff-clash.md), Phases 0–4, all
> done, walk included). `bookings_pending_not_taken`
> (`sql/schema-taken-span.sql`, the 20th file) refuses the INSERT of a
> pending row whose unit and span overlap a confirmed one, `23P01` in
> words ("taken on <date>: <unit> is already confirmed for that slot");
> `taken.ts` passes those words through as the 409. A pending row still
> holds nothing (D-070, D-095): two pendings may share a night, the first
> confirmed wins, the other's Confirm is the 409. The staff list carries
> `clash`, and the Bookings screen warns and disables Confirm on such a
> row; the server stays the guard (trap 21). The customer door was
> SQL-guarded already (`request_booking()`'s own check).
>
> **Every stay is a group with one reference** since 2026-10-05 (D-100,
> [`plan/staff-requests.md`](./plan/staff-requests.md), Phases 0–4, all
> done, walk included). `booking_reference()` (`sql/schema-staff-requests.sql`,
> the 21st file; the twelfth definer function) is the ONE place the shape
> is written; `request_booking()` calls it, and a BEFORE INSERT trigger
> fills `group_id` and `reference` for any insert that brings none, one
> reference per statement's group. Every older row was backfilled. The
> Requests section lists every pending stay, web or staff ("by staff"),
> decided with the same buttons; the list row shows `ref …` and says
> "group booking" only for several rows (`groupSize`). A volatile function
> in an UPDATE's SET runs once per ROW: the backfill learned it.

> **Guests manage their stay, and staff verify payments,** since 2026-10-10
> (D-104–D-109, [`plan/manage-booking.md`](./plan/manage-booking.md),
> Phases 0–6 and 8; Phase 7, email, gated on deployment). `/t/<slug>/manage`
> (S-13, public) finds a stay by reference + email OR phone through ONE
> definer read, `guest_stay()`, and `guest_group()` is the one match every
> guest door uses; a miss is one sentence, 5 misses lock a reference for an
> hour. A stay (D-100's group) has a `stays` row: its reference, the
> amount it must have verified (set at birth), `pay_by`, `review_by`.
> Payment status is DERIVED (`stay_payment()`), `expired` is stored,
> `completed` derived. Proofs go to the PRIVATE `payment-proofs` bucket
> (insert-only for guests), staff verify or reject them on S-14
> `/admin/payments` (owners and admins: `payments:write`), and a tracked
> stay with nothing verified needs a note to be confirmed. A tenant may
> choose a HOLD (`none` by default): `schema-holds.sql` (the 24th file) makes
> `booking_takes()` the ONE taken test and `bookings_no_overlap` read a
> `held` flag. Guests ask to cancel or move; staff decide. Every decision is
> a `booking_events` row written by a trigger. Read that plan's § 0 before
> touching a payment, a hold, a guest door or the event log. Since D-110
> (`schema-stay-outcome.sql`, the 25th file) a declined, expired or taken
> stay says why on S-13 and takes no proof (`payments_refuse_taken`).
>
> **Staff book a stay on the booking page's rules** since 2026-10-12
> (D-111). New booking takes check-in + nights, guests per unit, name,
> mobile AND email (`parseRequest()`, `byStaff`), shows the page's
> night-by-night price (`priceStay()` and `StayLines`, shared), and inserts
> every unit × night as ONE pending stay (`staff-stay.ts`). A **Walk in**
> box labels the STAY (`schema-walk-in.sql`, the 26th file:
> `stays.walk_in`, set by the `bookings_ac_walk_in` trigger, refused on a
> web row). `createBookings()` is unchanged, for the tools.
> Since D-113 (`schema-staff-terms.sql`, the 27th file) a staff stay born
> pending is paid for like a web one (amount due and pay-by deadline, the
> countdown on S-13, expiry); a walk-in owes the amount with no deadline.
>
> **Staff read every chat** since 2026-10-13 (D-115,
> [`plan/conversations.md`](./plan/conversations.md), Phases 0–6, walk
> included). S-16 `/t/<slug>/admin/conversations` lists a tenant's chats
> (search over every message, 7/30/90 days, only-unanswered, keyset pages)
> from ONE `security invoker` function, `conversation_list()`
> (`sql/schema-conversations.sql`, the 28th file), which refuses a
> non-member itself, because a chat token may read every message by
> policy. S-16a `/admin/conversations/<id>` is one transcript as STORED,
> read-only: a refusal drawn as "Not answered" with the fallback the visitor
> saw, times in the tenant's zone. `conversations:read` is every member's.
> The open `/conversations/[id]/messages` route is GONE. Unanswered rows
> link in (`conversationId`, staff only). Transcripts are kept
> indefinitely (R-50). The chatbot is untouched: the three baselines are
> byte-identical.
>
> **Staff hear what waits on them** since 2026-10-14 (D-116,
> [`plan/notifications.md`](./plan/notifications.md), Phases 0–8; the phone
> walk owed). A guest's request, a proof, a change request: the
> `booking_events` log is the ONE source, and a trigger fills
> `notification_outbox` (`sql/schema-notifications.sql`, the 29th file).
> In the app, every staff tab polls `/admin/attention` every 30 s, HIDDEN
> too, and chimes (sound on by default; a click or key wakes it). On
> devices, Web Push by hand in `@rag/push` (VAPID, RFC 8291, `node:crypto`;
> `VAPID_PRIVATE_JWK` read in ONE function, unset = push off). The drain
> (`notify_claim()` / `notify_done()`, definers) runs in `after()` and in the
> poll, and decides recipients from the membership row at send time: a
> proof reaches owners and admins only. The payload has NO guest name,
> phone, email or amount. S-17 `/admin/notifications` holds the sidebar's
> ONE badge, what this member has not READ
> (`schema-notification-reads.sql`, the 30th). A tapped push marks itself
> read. "Turn off on all my devices" is R-51's answer to a lost phone. The
> chatbot is untouched.

> **A super user switches features per tenant** since 2026-10-14 (D-127):
> eight features in ONE registry, `apps/web/lib/features.ts` (Dashboard,
> Conversations, Unanswered, Calendar, Notifications, Suggested questions,
> Online booking page, Manage booking), on the platform form's Features tab.
> `tenant_features` (`sql/schema-features.sql`, the 33rd file): no row = ON.
> Off, the page and its routes 404 (`requireFeature()`, `lib/feature-flags.ts`)
> and its links go; Postgres refuses the stranger's writes by trigger (a web
> booking, a guest proof, a change request) and queues no notice. A new
> screen that should be switchable gets a key in both lists.
>
> **What each role may do is per tenant** since 2026-10-14 (D-128).
> - `lib/permissions.ts` is the DEFAULT. A super user changes it on the
>   platform form's Permissions tab, stored in `role_permissions`
>   (`sql/schema-role-permissions.sql`, the 34th file).
> - A configurable permission can be taken from a role, and a grantable
>   one (documents, rooms, holidays, slots, promos) given. Session,
>   payments:write and payments:settings are fixed.
> - `can(role, permission, overrides)` and SQL's `app_can()` agree, pinned
>   by `permissions.test.ts`.
> - Each role policy has a restrictive `<table>_may_<cmd>` twin; each
>   grantable one has a permissive `<table>_can_<cmd>` twin.
> - A new role-gated policy needs its twins, and a new permission needs
>   both lists.
> - The platform also reads and writes a tenant's knowledge base (its
>   Knowledge base tab, D-076 amended), and still no booking, message or
>   payment.
>
> **The legal groundwork** since 2026-10-14 (D-129–D-131,
> [`plan/legal.md`](./plan/legal.md); the Data Privacy Act, RA 10173).
> - **Texts:** `/t/<slug>/privacy` and `/terms` and the platform's own come
>   from ONE file, `apps/web/lib/legal.ts`. They are placeholders for a
>   lawyer, filled with the tenant's privacy contact, periods and policy
>   version (`tenant_public()`; never the DPA date).
> - **Consent:** the booking page's box is required by the route and
>   recorded on the stay by `request_booking_with_consent()`, a wrapper,
>   because `request_booking()` is not replaced.
> - **DPA gate:** bookings cannot be switched on without `dpa_signed_on`
>   (a trigger; service_role exempt).
> - **Retention:** `retention` removes chats and guest details past each
>   tenant's period.
> - **Chatbot:** the chat's notice is page text; no prompt changed.
>
> **A room is a TYPE with physical rooms** since 2026-10-20 (D-133,
> [`plan/room-types.md`](./plan/room-types.md), Phases 0–5 and 7; Phase 6's
> runs and the user's alteza walk owed).
> - `units` is the type (name, capacity, rates, photos, promos: no price
>   changed); `unit_rooms` holds its rooms, and the count is always active
>   ROWS, never a number typed beside them. Every unit was backfilled with
>   one room named like it.
> - `bookings.room_id` is required and `bookings_no_overlap` is per room.
>   ONE trigger, `bookings_room_assign`, picks a free room under a lock at
>   every door, and Confirm re-picks if the room was taken meanwhile.
> - Staff add, rename and retire rooms on S-5 and move a stay on S-15
>   (`move_room()`, a note, an event row; the price never moves). The
>   calendar says "1 of 2" and the dashboard counts rooms.
> - Guests see a count, never a room number: the booking page caps a
>   type's count by the quote's `free` ("1 of 2 left"), and the tool row
>   carries `left` for an open type of several rooms, in the RESULT only.
>   No prompt or tool text changed (R-52).
> - SQL files 37–40: `schema-room-inventory`, `-room-counts`, `-room-move`,
>   `-room-views`.
>
> **Every staff and super-user action is logged** since 2026-10-20 (D-138,
> [`plan/audit-log.md`](./plan/audit-log.md), Phases 0–5, all done, walk
> included). `audit_log` (`sql/schema-audit-log.sql`, the 43rd file) is
> written by Postgres alone: `audit_row()`, ONE trigger on the 16 tables a
> staff or platform token may change, and `audit_note()` for a login, a
> logout and a proof opened. No token inserts, updates or deletes a row.
> Bookings keep `booking_events` (one event, one table); the log holds the
> names of changed columns and a short allowlist per table, never a body
> or a guest detail. `activity:read` (owners; grantable) reads it on S-18
> `/t/<slug>/admin/activity`; a super user reads any tenant's on the
> platform's Activity tab and the platform's own on `/platform`. A new
> table that staff write needs a line in `audit_row()`'s case and the
> attach list; a cascade delete of a tenant is skipped by the trigger;
> verify and the walks sweep their own `system` rows (R-54).
>
> **The three guest pages link to each other** since 2026-10-20 (D-136):
> `navItems()` lists Chat, Book a stay and Manage booking (each only when
> the page exists); on a guest page the chat link reads "Need help? Ask
> <assistant>" (`chatLinkLabel()`, the ONE wording; `TenantNav` takes
> `assistantName`); a guest page's header shows the other two, the chat's
> welcome and the links under its field carry both, and the staff account
> menu names all three. A new guest page gets a `NavPage` and a line there.
>
> **Every note on the booking page offers quick notes** since 2026-10-20
> (D-135): three to five sentences per step (Confirm paid or unpaid,
> Decline, Cancel, a change request's decision, a proof's, a refund, a
> move, a staff note) in ONE table, `apps/web/lib/quick-notes.ts`, drawn
> by ONE component as chips above the field. A click fills the field; the
> text stays editable; a refusal's chips are the danger tone. The server
> still requires every note it did (D-096); nothing moved there. A new
> note field on S-15 gets a step in that table.
>
> **Guests can talk to the assistant** since 2026-10-20 (D-134,
> [`plan/voice.md`](./plan/voice.md); the user's phone walk and the runs
> after Phase 7 are recorded in status.md). A mic in the composer: the
> recording becomes text (`voice/transcribe`), sent as if typed; the whole
> reply is read aloud (`voice/speak`, which takes a `conversationId`,
> NEVER text). No prompt or tool text changed. When OpenAI's speech fails,
> the browser reads the same `speakable()` text with an ON-DEVICE voice, or
> stays silent. Nothing is recorded or kept. The `voice` feature is the one
> that is OFF with no row (`schema-voice.sql`, the 41st file).
>
> **The per-IP limit is ONE count in Postgres, and the chat has one,** since
> 2026-10-20 (D-137, [`plan/rate-limit.md`](./plan/rate-limit.md), Phases 0–5,
> all done, walk included). `rate_windows` + `rate_allow()`
> (`sql/schema-rate-limit.sql`, the 42nd file; the thirteenth callable
> definer): one statement bumps a (tenant, key, window) row and judges it,
> so every instance shares the count (R-39 closed). `allow(tenant, key,
> max?)` in `lib/rate-limit.ts` is async over it, throws when Postgres does
> not answer (never fail-open), and no token reads the table. The chat
> route is limited for the first time (30 turns per address per 10 min,
> before the Accept header is read: one JSON 429 in both deliveries, nothing
> spent); the chat and voice routes also meet `allowSpend()`'s per-tenant
> ceiling across addresses (600 per 10 min, R-53). Every number is policy, in
> one constant. A walk that probes a limit sends a FRESH `X-Forwarded-For`
> per run: the count outlives the process now. The chatbot is untouched.
>
> **The welcome line is per tenant** since 2026-10-21 (D-139,
> `schema-welcome-text.sql`, the 44th file): `tenants.welcome_text`, 1–200
> characters or null, read through `tenant_public()`, set by a super user on
> the platform form (Profile → Identity, "Welcome line"); null = the default
> in `apps/web/lib/welcome-text.ts`, the ONE place those words are written.
> The chat's fine print is ONE grid, `.composer-foot`: the links in their own
> `<nav class="composer-links">`; on a phone the notice spans the width and
> the links share the last row with Read aloud. `plan/welcome-text-walk.mjs`
> (4 checks) is its walk. The chatbot is untouched.
>
> **The sources behind a reply are staff's** since 2026-10-21 (D-140, amends
> D-012): `sources:read`, an admin's by default, configurable and grantable
> (both lists, and the three SQL lists in the 34th AND the 43rd file). The
> chat route asks `sessionCan()` (`lib/admin-auth.ts`, the non-throwing twin
> of `requireAdmin()`) before the answer and REMOVES `sources` and
> `searchQuery` from the JSON body and the `meta` event for anyone else; the
> screen draws nothing of the chunks when the list is absent. The tool
> evidence stays for everyone (rule 7). `plan/sources-access-walk.mjs` (4
> checks). The pipeline is untouched.
>
> **Tenants `northwind` and `harbor` were hard-deleted** on 2026-10-20, by
> the user's choice (`tenant:remove --yes`). Only `villa` and `alteza`
> remain. `pnpm eval`, both isolation suites and every harbor walk need
> them, so they cannot run as written
> until test tenants are rebuilt from `fixtures/` (northwind.json,
> harbor.json, harbor-units.json, harbor-bookings.json). Ask before
> rebuilding them (the user declined, 2026-10-20). `rooms` (56) and `verify`
> (223) run without them.

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
  app/page.tsx                   static root: the landing page (D-121), drawn with mockups — no tenant list, no redirect
  app/t/[tenant]/layout.tsx      tenant theme (style prop) + tab title
  app/t/[tenant]/page.tsx        S-1 chat — Server Component, resolves the tenant
  app/t/[tenant]/admin/page.tsx  redirects to admin/dashboard (D-098 amended); 404 on an unknown tenant
  app/t/[tenant]/admin/documents/page.tsx  S-2 knowledge base — same
  app/t/[tenant]/admin/bookings/page.tsx  S-3 bookings — 404 unless the tenant has the application
  app/t/[tenant]/admin/bookings/[reference]/page.tsx  S-15 one booking (D-114): EVERY action on a stay is here; lists link to it; its Staff notes card (D-132); every note field offers quick notes for its step (D-135, lib/quick-notes.ts the ONE table, components/quick-notes.tsx)
  app/t/[tenant]/admin/unanswered/page.tsx  S-4 unanswered questions — staff only, every tenant
  app/t/[tenant]/admin/conversations/page.tsx  S-16 conversations (D-115) — every member (conversations:read), every tenant; filters in the URL
  app/t/[tenant]/admin/conversations/[id]/page.tsx  S-16a one transcript, read-only; ?m= scrolls to a message; the route is /api/t/[tenant]/admin/conversations/[id]
  app/t/[tenant]/admin/activity/page.tsx  S-18 Activity (D-138): who did what, for activity:read (owners); the route is /api/t/[tenant]/admin/activity; filters in the URL
  app/t/[tenant]/admin/notifications/page.tsx  S-17 Notifications (D-116 § 8): the last 30 days, read or not; the sidebar's ONE badge is its unread count; 404 without bookings
  app/t/[tenant]/sw.js/route.ts, manifest.webmanifest/route.ts  the tenant's service worker (scope /t/<slug>/; source in lib/service-worker.ts) and staff app manifest (D-116)
  app/api/t/[tenant]/admin/attention, notifications, push  the poll (unread + newest), the feed and read marks, this device's subscription / all my devices (D-116)
  app/t/[tenant]/admin/accommodations/page.tsx  S-5 rooms — 404 unless the tenant books per_room
  app/t/[tenant]/admin/reset/page.tsx     where invite and reset emails land; the token is in the #fragment
  app/t/[tenant]/book/page.tsx   S-6 the customer booking page — PUBLIC; 404 unless the tenant has a priced unit
  app/t/[tenant]/admin/holidays/page.tsx  S-7 the holiday calendar — 404 unless the tenant has the application
  app/t/[tenant]/admin/members/page.tsx   S-8 the tenant's members — for OWNERS (members:manage); others see one sentence
  app/t/[tenant]/admin/slots/page.tsx     S-9 slots — owners and admins (slots:read/write); 404 unless the tenant has the application
  app/t/[tenant]/admin/promos/page.tsx    S-10 promos (D-097) — owners and admins (promos:read/write); 404 unless the tenant has the application
  app/t/[tenant]/admin/dashboard/page.tsx S-11 the dashboard (D-098) — every member (dashboard:read); every tenant; the route is /api/t/[tenant]/dashboard?days=
  app/t/[tenant]/manage/page.tsx S-13 Manage booking (D-104) — PUBLIC; 404 without the application; ?ref= pre-fills
  app/t/[tenant]/admin/payments/page.tsx S-14 Payments (D-107, D-108) — every member reads (payments:read); owners and admins decide
  app/platform/page.tsx          the platform: login → tenant list (with the Pulse strip, D-098) → the tenant form (super users only; not linked from /)
  app/platform/reset/page.tsx    where a super user's invite or reset email lands
  app/api/platform/**/route.ts   session, password(-reset), tenants, tenants/[id], /archive, /applications/[key], /members, dashboard — every one on withPlatformRoute() but the three session/password ones
  app/t/[tenant]/not-found.tsx   "No such workspace"
  app/api/t/[tenant]/**/route.ts the endpoints + admin/session, password-reset, password; chat/ does JSON and SSE
                                 book/quote and book/request are OPEN (no requireAdmin), like chat/
  components/                    tenant-nav (every tenant page's header links, by role and feature; a guest page shows the other guest pages, D-136), chat-screen, reply-text (the reply as text + tables, D-091), room-cards (a room-list reply as one card per room with its photos, D-094; short cells fact chips, sentences text, a sideways row on a phone, D-120), lightbox (the photo viewer: the room and count in a bar, thumbnails, Tab kept inside, D-120), admin-screen, bookings-screen (the list of stays, D-112), accommodations-screen, unanswered-screen, conversations-screen and transcript-screen (S-16, D-115), booking-page, holidays-screen, slots-screen, promos-screen, dashboard-screen (draws tenant_dashboard()'s JSON, D-098), bar-chart (inline SVG, no library), admin-login, reset-password (Client), brand-header, sources-panel,
                                 platform-screen, tenant-form (the theme preview is the page's own mechanism), members-panel (one panel, two callers), members-screen
  lib/route.ts           withRoute(): validation + the ONE error→status map
  lib/rate-limit.ts      the per-IP window on every open route (chat, book/request, manage/*, voice/*): ONE count in Postgres through rate_allow(), async, throws when the database is down (D-137); allowSpend() adds the per-tenant ceiling on the OpenAI routes; the numbers are policy, one constant each
  lib/tenant.ts          getTenant() + withTenantRoute(): slug → a CHAT TenantContext, 404 on a miss
  lib/admin-auth.ts      the staff session cookie; requireAdmin(request, tenant, permission) re-checks the membership and the ROLE → a STAFF context, or 401 / 403; sessionCan() the same three questions as a boolean, for the open chat route (D-140)
  lib/platform-auth.ts   the platform session cookie (rag_platform, /api/platform); requirePlatform() → { db, userId }; withPlatformRoute()
  lib/permissions.ts     the ONE table of what each role may do — pure, imported by routes (the guard) and screens (the courtesy)
  lib/nav-items.ts       navItems(): the header's links for a tenant's features and a role — pure, tested
  lib/nav.ts             loadNavFeatures(): which of those pages the tenant has, the same checks the pages 404 on
  lib/theme.ts           the five theme keys, the colour regex, themeVars() and parseTheme() — pure, shared by the page and the platform form
  lib/applications.ts    requireApplication(): 404 unless the tenant has it switched on
  lib/branding.ts        the five-key theme allowlist, https-only image URLs
  lib/env.ts             fail-fast config (D-023)
  lib/limits.ts          MAX_CONTENT_LENGTH — importable by the browser
  lib/voice.ts, lib/speakable.ts  D-134: the voice limits and sniffAudio(); a reply made sayable, shared by the speak route and the browser's fallback voice — pure, tested
  components/voice.tsx   D-134: useVoice() (record, transcribe, read aloud, the on-device fallback, Escape), the mic, the status line, "Read replies aloud"
  lib/money.ts           centavos ↔ pesos, by string, never × 100 — browser-safe
  lib/conversation-words.ts  S-16's filters ↔ the URL, times in the TENANT's zone — pure, tested
  lib/activity-words.ts  D-138: an audit row as a sentence (activityWords), who (actorWords), the filters ↔ the URL, the subject's screen — pure, tested; components/activity-list.tsx is the ONE list (S-18, the platform's tab, the platform's card)
  lib/tables.ts          parseSegments(): the ONE block syntax the chat draws, a pipe table → elements (D-091) — pure, browser-safe
  lib/welcome-text.ts    D-139: DEFAULT_WELCOME_TEXT, the welcome card's line when a tenant set none, and welcomeTextOf(); the bound lib/schemas.ts repeats — pure, browser-safe
  lib/resize-image.ts    canvas resize + WebP before upload; drops EXIF/GPS
  app/styles/            tokens.css (every colour, size, radius; dark mode; colours DERIVED from the five theme keys), base.css, chat.css, screens.css; globals.css imports them (D-101)
  components/staff-frame.tsx  every staff screen's frame (D-101, D-117): signed in, a sidebar of places in four sections (groupNavItems: Overview, Front desk, Assistant, Setup) that is a drawer below 900 px, and a top bar on every width (breadcrumb, the Notifications bell with the ONE badge, the account menu); signed out, the old header
  components/brand-header.tsx  every tenant header (D-118): the accent stripe, BrandMark (the logo or the initial on the accent); `hero` draws the brand band (the banner under a scrim, or an accent gradient) on the booking page and Manage booking; public-footer.tsx is their footer (Book a stay, Manage booking, Staff login)
  components/account-menu.tsx  the top bar's account menu (D-117): the role, the guest pages, this device's sound and push, Log out; a disclosure, not an ARIA menu; `label` for the platform's "Super user" (D-119, platform-screen.tsx's top bar)
  components/attention.tsx   the poll, the toast and the chime, the Sound toggle (D-116); push-control.tsx the device's subscription; notifications-screen.tsx S-17
  lib/attention.ts, lib/service-worker.ts, lib/notify.ts  the badge/title/news words (pure); the worker's source (pure, tested on a fake self); notifyAfter(), the drain in after()
  components/icons.tsx   the icons: hand-drawn inline SVG on a 20 px grid, currentColor, aria-hidden unless labelled (D-101)
  components/toast.tsx   useNotice(drawerOpen): a success or a refusal as a toast, a refusal in an open drawer stays in it; ONE queue, ONE <Toaster /> per page (StaffFrame, the platform), a popover in the top layer (D-102)
  components/load-state.tsx  LoadState (a skeleton, or an alert with Retry running the load that failed) and EmptyState (title, line, the page's own add button) (D-102)
  components/list-search.tsx the search field over a loaded list; lib/search.ts matches() and PAGE_SIZE, pure, tested (D-102)
  components/tabs.tsx    WAI-ARIA tabs, every panel mounted; the platform tenant form's Profile / Applications / Members / Archive (D-102)
  components/tooltip.tsx Tip: on hover AND keyboard focus, Escape closes it, hoverable; no HTML element keeps a native title (D-102)
packages/
  chunker/             @rag/chunker — pure, isomorphic, ZERO dependencies
  openai/              @rag/openai — embed, chat, chatStream over raw fetch; tool calls in, never run
  db/                  @rag/db — tenant-token clients, the types, sql/ (44 files; the 44th, schema-welcome-text.sql (the welcome line per tenant, D-139); the 43rd, schema-audit-log.sql (D-138); the 42nd, schema-rate-limit.sql (rate_windows and rate_allow(), the shared per-IP count, D-137); the 41st, schema-voice.sql (the voice switch, off with no row, D-134); the 37th–40th, schema-room-inventory.sql, schema-room-counts.sql, schema-room-move.sql and schema-room-views.sql (room types, D-133); the 36th, schema-stay-notes.sql (staff notes on a stay, D-132); the 35th, schema-legal.sql (consent, the DPA gate, retention, D-129–D-131); the 34th, schema-role-permissions.sql (role permissions per tenant, the platform's knowledge base, D-128); the 33rd, schema-features.sql (feature flags, D-127); the 31st and 32nd, schema-brand-images.sql (the brand-images bucket, super users only, D-123) and schema-assistant-avatar.sql (D-124); the 29th and 30th, schema-notifications.sql and schema-notification-reads.sql, D-116; the 28th, schema-conversations.sql, D-115; the 27th, schema-staff-terms.sql, D-113; the 26th, schema-walk-in.sql, D-111; the 25th, schema-stay-outcome.sql, D-110; the 22nd, schema-calendar.sql, D-103; the 23rd, schema-manage-booking.sql, D-104–D-109; the 24th, schema-holds.sql, D-106; the 16th, schema-pending-default.sql, D-095; the 17th, schema-decision-note.sql, D-096; the 18th, schema-promos.sql, D-097; the 19th, schema-dashboard.sql, D-098; the 20th, schema-taken-span.sql, D-099; the 21st, schema-staff-requests.sql, D-100), and server-only
    src/tenant-client.ts mintTenantToken and mintPlatformToken (ES256, D-039, D-076), one signer, scopedClient, anonClient
    src/service.ts       @rag/db/service: the RLS-BYPASSING client, for tools/ only (one exception: admin-auth.ts until auth-rls Phase 6)
    src/staff-auth.ts    signInStaff, staffClient (membership → { db, role }), platformClient (platform_admins → the platform token), password reset (Supabase Auth, D-040)
    tools/verify.mjs     242 checks (102c the welcome line: set by the platform, read by anon, '' and 201 characters refused, null clears, D-139; 230–241 the audit log: the trigger's rows, no token writes, RLS alone, activity_list() refuses, a grant, a super row, audit_note()'s refusals, a definer's write, no stay row, the keyset, retention, D-138; 225–229 the shared rate limit: ten in and the eleventh out with one row at 11, wall 2, no token reads the table, the sweep, keys apart, D-137; 196b voice off with no row, D-134; 212–223 room types: the backfill, RLS on unit_rooms, the per-room constraint, one room per stay, retire and delete, whole-resort keeps one, the counts, a type twice, staff pending, Confirm re-picks, the calendar and dashboard counting rooms, D-133; 16, 26 and 99 no longer need northwind; 207–211 staff notes on a stay: authorship, the walls, delete your own, a role override, retention, D-132; 202–206 the legal groundwork: consent recorded, the DPA gate, removing guest details, old chats, the public privacy columns, D-129–D-131; 197–201 role permissions per tenant: a row refuses the owner, a grant lets staff in, an impossible grant does nothing, only the platform sets them, the platform's documents, D-128; 192–196 feature flags: only a super user writes one, each tenant reads its own, the triggers refuse with the feature off, D-127; 188–191 the brand-images bucket and the assistant avatar, D-123–D-124; 173–187 notifications: devices, the outbox trigger, claim and done, the feed and read marks, D-116; 168–172 conversation_list(), D-115; 165–167 staff stay terms, D-113; 159–161 a stay that cannot go ahead: taken, declined, expired, D-110; 125–158 manage booking: stays, the event log, guest_stay, payments, review, holds, change requests; 119–124 the calendar; 117–118 the dashboard functions; 111–116 promos; 77–92 customer booking; 95–108 roles, the platform token, archive, the shapes, the lookups; 102b suggested questions), no API key
    tools/super.mjs      super:add / remove / list — who runs the platform; the bootstrap, on service_role
    tools/tenant.mjs     tenant:add, tenant:fallback, tenant:booking-type, tenant:archive, tenant:remove (the only hard delete; D-077) — the platform form does the first two and archive too
    tools/member.mjs     member:add [role] / role / remove / list / operator — who may administer a tenant, and as what (owners do this on the Members screen)
    tools/staff-cases.mjs  the six login cases and three role cases over HTTP, against pnpm dev
  bookings/            @rag/bookings — availability, bookings; admin routes AND the chatbot tool call it
    src/accommodations.ts  rooms and their rates (+ holiday_price), staff only (per_room)
    src/images.ts          room photos in the `unit-images` bucket, staff only
    src/requests.ts        the booking page's reads and its one write (chat token); staff list/confirm/decline; priceStay(), the ONE stay quote
    src/staff-stay.ts      D-111: a staff stay on the page's rules (quoteStaffStay, createStaffStay), Walk in
    src/calendar.ts        the holiday calendar: list (any token), set/remove/copy (staff)
    src/unit-rooms.ts      D-133: a type's physical rooms (add, rename, retire, delete a never-booked one); roomCounts()
    src/room-move.ts       D-133: moveOptions() and moveStay() over move_room(), the one way a stay changes room
    src/closed.ts          closed dates (D-080): the reads that say 'closed', the words a refused write gets
    tools/isolation.mjs    42 cross-tenant checks, no API key (16b room photos, 16c promos, 16d the calendar, 16e a type's rooms and a move, D-133, 30 manage booking, 31a–g push notifications, the Notifications feed, all my devices)
    src/slots.ts           slots (D-090): list for staff, create, edit, retire, delete; every refusal in words
    src/promos.ts          promos (D-097): list with uses, create, edit, retire, delete-unused; the quotes' two reads of the ONE discount function
    src/taken.ts           D-099: the trigger's "taken on <date>: <unit>…" passes through as the 409 (and, D-106, "is held for another guest"); the constraint's own 23P01 keeps the sentence
    src/guest.ts           D-104: guestStay(), the guest's one read, typed
    src/payments.ts        D-107: a guest's proof: checked by its bytes, uploaded insert-only, submit_payment()
    src/payment-review.ts  D-107: staff: the queue, signed proof URLs, verify/reject, refunds, settings, a stay's history
    src/deadlines.ts       D-105: expire_due_stays(), the sweep before every staff list
    src/changes.ts         D-108: cancel and reschedule requests: the guest asks, staff decide
    src/notify.ts          D-116: the drain (notify_claim → sendPush → notify_done) and pushMessage(), the ONE wording of a notification
    src/notifications.ts   D-116 § 8: the member's feed and read marks (notification_feed, notification_read)
    src/push-devices.ts    D-116: this member's devices: one, or all (R-51)
    tools/rooms.mjs        56 checks of rooms, groups, quotes, extra guests, photos, stays, holidays, rate kinds, requests, closed dates, slots, decisions, promos, the taken-span trigger (4d, 4e, 26b), references on staff stays (4f, 4g), moving a stay between rooms (38–41) and a type's rooms on S-5 and the staff form (42, 43)
    tools/storage-orphans.mjs  objects in the photo bucket with no row (R-30); dry run, `-- --remove` deletes, counted
    tools/photo-cache.mjs  every existing room photo on the one-year Cache-Control new uploads carry (D-141); dry run, `-- --apply` rewrites and reads the header back past the CDN
  rag/                 @rag/pipeline — ingest, retrieve, prompt, answer, tenant, applications, tools
    src/voice.ts           latestReply(): the speak route's one read, both walls (D-134)
    src/embed-cache.ts     embedQuery(): a question's vector remembered in-process, LRU of EMBED_CACHE_SIZE, keyed by text AND model (D-141); the query side only, ingest never reads it
    src/language.ts        the reply language, decided in code: Tagalog in → Taglish out (D-043)
    src/greeting.ts        small talk (greetings, thanks, "okay", goodbyes, English + Tagalog) answered in code, no retrieval (D-049)
    src/refusal.ts         NO_ANSWER is the internal marker; visitors see the tenant's fallback_messages[language] or a default (D-047, D-048)
    src/tables.ts          pipeTable(): the ONE writer of a table into a reply (D-091); the browser's parser draws exactly this shape
    src/dates.ts           relative dates ("bukas", "next Friday"), ranges ("from X to Y", "X for 2 nights") and a party size ("for 3 guests") resolved in code; availability AND price turns checked up front (D-046, R-15, D-074)
    tools/prompt-eval.mjs  the battery, 63 cases (10 + 9 tool-* + 10 lang-* + 11 date-* + 15 rt-* + 5 book-* + 3 price-*; rt-count and rt-count-full, D-133, never run yet), three tenants; seeds its own bookings
    src/activity.ts        listActivity() over activity_list(): a tenant's audit rows and stay log, or the platform's own, keyset-paged (D-138)
    src/conversations.ts   listConversations (over conversation_list()) and getTranscript, for staff: every message named question, answer, refusal, failed or interrupted (D-115)
    src/unanswered.ts      listUnanswered / resolve / reopen, one or many (the S-4 checkboxes): the questions answered with NO_ANSWER, for staff (D-045)
    src/platform.ts        what a super user does to tenants: list, get, create, edit, archive, applications; fromPostgrest(), the ONE code→status map
    src/members.ts         list (with emails), add an existing account, change a role, remove — shared by owners and the platform
    src/dashboard.ts       the dashboard's typed shapes over tenant_dashboard() and platform_dashboard(), the parser, the days clamp (D-098)
    tools/isolation.mjs    24 cross-tenant checks through the pipeline (21 and 22, RLS only: a platform token reads nothing, and gets 403 from a tenant's dashboard; 23: each tenant's dashboard counts equal its own truth; 24: a chat is listed and read by its own tenant's staff only)
  push/                @rag/push — Web Push by hand (D-116): encrypt.ts RFC 8291 (Appendix A's vector, byte for byte), vapid.ts RFC 8292, endpoint.ts the push-service allowlist (no SSRF), send.ts → ok | gone | retry; vapidKeys() the ONE reader of VAPID_PRIVATE_JWK; server-only, zero other dependencies
    tools/vapid.mjs        a new key pair for .env
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
plan/dashboard-phase4-walk.mjs 14 HTTP checks of the dashboard route by role (staff no money, admin money, the clamp), against pnpm dev
plan/tenant-management-phase0-shapes.mjs  the constraints of schema-roles.sql, dry-run against every live row
scripts/check-service-imports.mjs  run by `pnpm typecheck`: fails on @rag/db/service under apps/ or packages/*/src
```

## Commands

```sh
pnpm dev                        # http://localhost:3000
pnpm build · typecheck · test   # typecheck runs the service-import check first
pnpm --filter @rag/db verify    # 242 checks, no API key needed; sweeps its own system audit rows at the end
(cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/sources-access-walk.mjs)   # 4 checks of who gets a reply's sources (D-140): guest, staff, admin, owner, and the per-tenant rows; nothing spent; needs pnpm dev
(cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/welcome-text-walk.mjs)   # 4 checks of the welcome line (D-139): the platform route, tenant_public(), the card at 375, the audit row; a throwaway tenant and super user; needs pnpm dev
pnpm --filter @rag/db retention [-- --remove]   # D-131: chats and guest details past each tenant's period, and (D-138) audit rows past audit_retention_days; a dry run unless --remove, counted
(cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/audit-log-walk.mjs)   # 12 checks of S-18 and the platform's log on villa, HTTP and browser, shots in plan/audit-log/walk/; audit-log-a11y.mjs is axe over 16 states; needs pnpm dev
pnpm eval                       # the prompt battery, 63 cases  ⚠ see below (needs northwind and harbor, deleted 2026-10-20)
pnpm scores                     # real similarity scores for northwind, threshold off
pnpm --filter @rag/pipeline isolation   # 24 cross-tenant checks, on chat tokens (+ one platform token)  ⚠ rule 6
pnpm --filter @rag/pipeline isolation -- --filters-only   # 22 of them, code filters alone (RLS bypassed)
(cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/dashboard-phase4-walk.mjs)   # the dashboard route by role over HTTP, needs pnpm dev
pnpm --filter @rag/bookings isolation   # 42 cross-tenant booking checks, on operator staff tokens, no API key
pnpm --filter @rag/bookings isolation -- --filters-only   # the same 40, code filters alone
pnpm --filter @rag/bookings rooms       # 56 checks: rooms, groups, quotes, extra guests, photos, stays, holidays, rate kinds, requests, promos, closed dates, slots, the taken-span trigger, staff references; no API key
pnpm --filter @rag/bookings storage-orphans [-- --remove]   # photo AND proof objects with no row (R-30): list, or delete and count
pnpm --filter @rag/bookings storage-orphans -- --expired     # proof files 180 days after the stay: delete, keep the payment row (D-107)
pnpm --filter @rag/bookings photo-cache [-- --apply]     # D-141: every room photo on a one-year Cache-Control; count, or rewrite the same bytes with the header and read it back
(cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/manage-booking-phase2-walk.mjs)   # (and phase3, phase4, phase6) the Manage booking and Payments routes over HTTP, needs pnpm dev
(cd packages/rag && node --conditions=react-server --env-file=../../.env ../../plan/customer-booking-villa-rates.mjs)   # villa's rates and the nightly slots, idempotent
(cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/customer-booking-phase3-walk.mjs)   # the booking routes over HTTP, needs pnpm dev
node --conditions=react-server --env-file=../../.env tools/staff-cases.mjs   # (in packages/db) six login and three role cases, needs pnpm dev
(cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/conversations-walk.mjs)   # 12 checks of S-16 as a STAFF member, HTTP and browser, screenshots in plan/conversations/walk/; needs pnpm dev; conversations-a11y.mjs is axe over its four pages (16 states)
(cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/room-cards-check.mjs)   # the room cards and the photo viewer (D-120) on alteza's real reply: a 7-step walk and axe over 8 states; one OpenAI call per scheme; room-cards-shots.mjs <label> photographs them
(cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/platform-header-check.mjs)   # /platform's top bar (D-119): a 5-step walk and axe over 16 states, a throwaway super user; platform-header-shots.mjs <label> photographs it
(cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/public-brand-a11y.mjs)   # axe over the chat, the booking page and Manage booking for 4 tenants (one with a logo and banner, made and removed), 48 states (D-118); public-brand-shots.mjs <label> photographs them
(cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/nav-layout-walk.mjs)   # 19 checks of the staff frame (D-117): sections by role, the top bar, the account menu by keyboard and pointer, the phone drawer; nav-layout-a11y.mjs is axe over 10 states; nav-layout-shots.mjs <label> photographs it
(cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/notifications-inbox-walk.mjs)   # 12 checks in a browser: a HIDDEN tab chimes, the ONE badge, read on open, Mark all read; also notifications-sound-walk.mjs (5), notifications-devices-walk.mjs (4, HTTP), notifications-phase5-walk.mjs (real pushes, two Chrome profiles), notifications-a11y.mjs (8 states); needs pnpm dev with VAPID_* set
(cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/rate-limit-walk.mjs)   # 8 HTTP checks of the shared per-IP limit (D-137): the chat 30 then 429, the ceiling, a streamed 429, book/request and manage, the table's counts; needs pnpm dev; a fresh address per run
(cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/unanswered-bulk-walk.mjs)   # 11 HTTP checks of resolving several unanswered questions at once, needs pnpm dev; unanswered-bulk-browser-walk.mjs the same 12 in a browser
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
   `plan/baseline/northwind-prompt-post-emoji.txt` (`diff --strip-trailing-cr`;
   before D-092 it was the pre-bookings file, which differs by the emoji
   paragraph alone),
   villa's tool definitions must match
   `plan/baseline/villa-tools-post-villa-prices.txt` (D-074; before it, the
   pre-booking-types file), and harbor's
   `plan/baseline/harbor-tools-tables-phase0.txt` (since 2026-10-04: harbor
   gained a Day Tour slot on the Slots screen, and the slot list is in the
   tool text; before it, the pre-customer-booking file). The three `price-*`
   cases compare the reply with the TOOL's row, never a typed number; the
   `lang-*` cases ask facts that are still in the documents (the deposit,
   the extension, the cook), because the rates are not. Since D-091 the
   battery also prints `table:` on every rt-*, tool-* and price-* case and
   judges it on `rt-list`, `rt-guests`, `tool-partial` (true) and
   `price-villa` (false, Rule 4).
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
   - Before shipping, `grep -ri "service_role\|SUPABASE_SECRET\|TENANT_SIGNING_JWK\|guest_phone\|VAPID_PRIVATE"
     apps/web/.next/static/` must return nothing (D-116 added the last).
   - `VAPID_PRIVATE_JWK` is read in ONE function, `vapidKeys()` in
     `@rag/push`, which is `server-only`; the public key reaches the browser
     from `GET /admin/push`. Grep for the key VALUES too,
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
   demands a `platform_admins` row. Twelve functions are `security definer`
   (`tenant_public`, `check_availability`, `check_room_availability`,
   `request_booking`, `app_role`, `tenant_applications_validate`,
   `tenant_applications_no_delete_live`, `memberships_keep_an_owner`,
   `member_emails`, `user_id_by_email`, `platform_dashboard`,
   `booking_reference`; D-042 as amended by D-054, D-071, D-076, D-098
   and D-100), each with `search_path = ''` and each checking its caller
   itself. **Since manage booking, nine more callable ones** (D-104–D-108):
   `guest_stay`, `submit_payment`, `request_change`, `withdraw_change` (the
   guest's, each matching through `guest_group()`), `review_payment`,
   `record_refund`, `set_payment_settings`, `decide_change` (owners and
   admins, each asking `app_is_admin()`), `expire_due_stays` (staff or
   service_role); since D-116 two more, `notify_claim` and `notify_done`
   (any token of the tenant, each checking the token's tenant; a claimed
   row is consumed, so the claim cannot list devices twice); since D-137
   `rate_allow` (any token of the tenant, checking the token's tenant; the
   ONE way to `rate_windows`, which no token reads); and
   trigger-only definers that no token can call (the stay row, the event
   log, the terms, the holds, `booking_events_notify`) (`booking_reference` also admits a direct session, `session_user
   = 'postgres'`, where the backfill ran). `tenant_dashboard()` is NOT one: it
   is `security invoker`, so it reads under the token's own RLS, and it
   refuses a caller that is not staff of that tenant on top. `request_booking` is still the only one that writes for a
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
25. **"Safe to re-run" means safe to re-run IN ORDER, not alone.** To test
    a new guard, `schema-customer-booking.sql` was re-run by itself.
    - It put back a price trigger that `schema-promos.sql` had replaced
      with no guard, and three promo checks failed.
    - Re-applying every later file in order restored it.
    - `schema-manage-booking.sql` does not re-run at all: its
      `booking_events_kind` is narrower than the rows later files allow.
      The batch is one transaction, so it failed whole.

    Re-run an older file only to test today's guard, then re-apply
    everything after it (legal Phase 1).
26. **A walk that cleans up BY NAME deletes the real row once one exists.**
    `plan/room-types-walk.mjs` added a throwaway "Garden Room 2" and
    deleted it by name. Phase 5's loader then gave harbor a real Garden
    Room 2, and the next run of the walk deleted it (room types, 2026-10-20).
    Clean up by the ids the run itself created, never by a name.
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
  honeypot field, the per-IP window (ONE count in Postgres since D-137,
  `rate_allow()`; the chat, the Manage doors and the voice routes share it,
  and the OpenAI routes add a per-tenant ceiling), and the per-contact
  limit in SQL. A probe of a limit sends a fresh `X-Forwarded-For` per run.
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
- Styles (D-101, plan/ui-refresh.md): no CSS framework, no component
  library, no icon package. No file after `tokens.css` writes a colour or a
  size as a literal; a new shade is a `color-mix()` of the five theme keys,
  declared on `:root, .tenant-root, [data-scheme]` so a tenant's colours
  reach it. A theme that sets a surface key stays light in dark mode
  (`pinsLightScheme()`, `data-scheme="light"`). A fill under white text is
  `--accent-fill` / `--danger-fill`, never the bare colour: dark mode
  darkens it (white on the dark accent was 3.68:1). Dim with colour, never
  opacity. `plan/ui-refresh-a11y.mjs` (axe, 160 page states) ends at 0
  violations; keep it there.
- Feedback (D-102): an action's result is a toast (`useNotice()`), a
  standing fact a `.notice` banner; a list shows `LoadState` until its rows
  arrive and `EmptyState` when there are none; a reason is a `Tip` or
  visible text, never only a `title`.
- Frontend: never `dangerouslySetInnerHTML` for anything from the server or the
  model. React escapes children, which is what makes this free — adding
  markdown rendering is what would take it away. The two exceptions are a
  pipe table and `**bold**` (D-091, as amended): `lib/tables.ts` parses
  those two shapes alone, and `reply-text.tsx` renders every cell and every
  bold run as a child, so the rule still holds.
  Tenant branding follows the
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
