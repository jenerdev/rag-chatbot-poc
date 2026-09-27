# Payments plan — booking lifecycle and manual payment verification

> Guests request a booking from the chat, pay outside the system (GCash, bank
> transfer), upload proof on a private page linked from their email, and
> staff verify it by hand. Bookings move through `pending_payment →
> pending_verification → confirmed`, with `cancelled`, `expired` and
> `completed` beside them, and a separate payment status.
>
> Written 2026-09-27, against `3eaba16` on `master`. **Status: agreed,
> nothing built.** Payments are **`per_room` only**; the email provider is
> Resend (§ 9). Roles, phone, retention and deployment are deferred to
> their phases. It builds on
> [`booking-types.md`](./booking-types.md), which must be built first: this
> plan needs its stored prices, `group_id` and Storage spike.
>
> Read [§ 0](#0-the-five-rules) before anything, and § 1, which lists where
> the request and this codebase disagree.

---

## What this plan covers

| | |
|---|---|
| **In scope** | The six booking statuses and their transitions, enforced in SQL; a `payments` table and a derived booking-level payment status; reservation fee (fixed or %) or full payment, with required / received / outstanding amounts; per-tenant payment settings; a booking reference; guest booking from the chat, where **the model quotes and a button books**; a guest booking page reached by a secret link; proof upload to a private bucket; a staff verification screen; expiry and completion by `pg_cron`; an email outbox and sender; an append-only audit trail; rate limits on the new open routes; battery, isolation and verify cases |
| **Out of scope** | A payment gateway or any automatic verification (a screenshot never verifies anything); card data of any kind; refunds that move money (staff record a refund they made elsewhere); staff roles beyond "member" (§ 9, question 4); SMS or Messenger; deployment itself (§ 1, row 4) |

---

## 1. What the request assumes, and what is actually here

| The request says | What the code has | Consequence |
|---|---|---|
| "Calculate the price using trusted backend data", for **both** booking models | `per_room` will have `unit_rates` (booking-types.md). **`whole_resort` has no price in the database**: villa's rates are in its documents, and on 2026-09-27 you decided to keep them there (booking-types § 8, question 3) | **Payments are `per_room` only** (§ 9, question 1). `whole_resort` tenants keep today's behaviour exactly |
| "Booking creation through the chatbot" | Chatbot tools are **read-only** (D-037), because the chat route is open: a write tool is an unauthenticated write driven by a model that reads strangers' text | § 2.1: the model still never writes. It quotes; the guest presses a button and fills in a form; **our route** writes. D-037 is amended, not dropped |
| "Send an email" | **No email service.** Supabase Auth's built-in sender is capped at a few emails an hour and is for auth only (R-21) | **Resend** (§ 9, question 3), one new secret `RESEND_API_KEY`, and an outbox (§ 2.6) |
| "Automated expiration", "scheduled jobs", "a link from the email" | **Local only** (D-013): no deployment, no scheduler, no public URL | Expiry runs **inside Supabase** with `pg_cron`, so it needs no server. But an email link to `localhost` works for no guest, so **real guests need deployment first** (§ 9 question 3) |
| "Authorized staff", "role-based permissions" | `memberships (user_id, tenant_id)`: a member can do everything a member can. There are no roles | Every member may verify. A `role` column is § 9 question 4 |
| "A booking reference alone must not grant access" | Agreed, and it fits: "not yours" and "not there" already look identical everywhere | The reference is for humans; access is a separate 32-byte secret (§ 2.4) |
| Existing statuses | `pending`, `confirmed`, `cancelled`. Staff create `confirmed` bookings from Viber enquiries, with no payment tracked | Existing rows are kept: `pending` → `pending_payment` with **no deadline** (so never expires), others unchanged, and `payment_status` null = "not tracked" (§ 2.8) |

---

## 0. The five rules

### Rule 1 — The model never writes, and never decides a status

It can quote a booking (read-only) and read the status of bookings made in
**this conversation** (read-only). It cannot create, confirm, cancel or
verify anything. "I have paid", a pasted screenshot, or an injected
instruction changes nothing, because no tool exists that could act on it.
Status text in the chat comes from a tool result, which comes from the
database.

### Rule 2 — Every status change goes through one SQL guard, and leaves an event

A trigger on `bookings` holds the transition table (§ 3) and refuses
anything else with `23514`, whoever sends it: a route, a script, or the SQL
editor. The same trigger appends a `booking_events` row with the old and new
status, the actor and the reason. There is no code path that changes a
status without an event, because the event is written by the change itself.

### Rule 3 — Amounts come from the database, and the payment status is derived

`price` is the trigger's (booking-types Rule 2). `required_amount` is
computed from the tenant's settings when the booking is created, and stored.
`received_amount` is the sum of **verified** payments, and the booking-level
`payment_status` is recomputed from `payments` by a trigger. Neither is ever
taken from a request. A screenshot has no amount until a staff member types
the verified one.

### Rule 4 — Guests reach their booking only by a secret, and see only their booking

A guest has no account. The link in their email carries a random secret;
the database stores only its SHA-256. Every guest read and write is a
`security definer` function that takes the secret, hashes it, and returns
**this one booking's** guest-facing columns. It never returns staff notes or
anything about another booking. A wrong secret and a wrong tenant give the
same "not found".

### Rule 5 — Both walls, and no `service_role`, for everything new (CLAUDE.md rules 2 and 6)

New tables carry `tenant_id`, composite FKs and their own RLS policies.
Every query filters on `tenant_id`. Guest paths run on a **chat token**
through definer functions that check the token's tenant (as
`check_availability` does, D-042). Staff paths run on staff tokens.
`pg_cron` jobs run inside Postgres and need no key at all. The only new
secret is the email provider's key, server-only, and added to rule 2's
bundle grep.

---

## 2. The traps that will actually cost you time

### 2.1 Booking from the chat without a write tool

```
guest: "Garden Room, Oct 10, overnight, 2 guests"
model → quote_booking(...)            read-only: validate, check, price
        result → model: summary, price, fee, deadline hours
        result → UI:    a quote id, shown as a "Book this" button
guest presses the button → a form in the page: name, email, phone
browser → POST /api/t/<slug>/bookings/request { quoteId, conversationId, name, email, phone }
server  → re-checks the quote (tenant, expiry, unused), inserts pending_payment,
          mints the access secret, queues the email
UI shows: reference, total, fee, deadline, instructions, "check your email"
```

Why this shape:

- the write is ours, not the model's (Rule 1), so D-037's reason still holds;
- **the guest's name, email and phone never enter the prompt.** They go from
  a form to a route. Nothing PII-shaped is in any tool result (CLAUDE.md
  rule 7);
- the quote id is in the tool **record** the UI receives, not in the
  model's arguments, so the model cannot be told to book someone else's
  quote (plan/bookings.md Rule 2);
- the price is recomputed by the insert trigger anyway.

`booking_quotes (tenant_id, id uuid, conversation_id, unit_ids, slot_id,
date, price, expires_at, used_at)` lives 15 minutes and is single-use
(`used_at` set in the same statement as the insert).

### 2.2 The hold is the exclusion constraint, so `expired` must free it

Today `bookings_no_overlap` ignores only `cancelled`. `pending_payment` must
**hold** the room, which it already does. `expired` must **free** it, so the
constraint becomes `where (status not in ('cancelled', 'expired'))`. That
means dropping and re-adding it; Postgres re-checks every existing row,
which cannot fail (the new condition is looser). Concurrency is unchanged:
two requests for the same room and slot, and the second insert gets
`23P01`, whatever the timing (trap 8).

### 2.3 Expiry is a job, not a condition

A constraint cannot say `deadline > now()`: `now()` is not immutable, so an
unpaid hold does not free itself. So:

- `expire_due_bookings()` sets `expired` where `status = 'pending_payment'
  and payment_deadline < now()`. **Only** `pending_payment`: a booking in
  `pending_verification` (proof in before the deadline) is never expired by
  the job, whatever the clock says. It is idempotent: a second run matches
  nothing.
- `pg_cron` runs it every minute, inside Supabase, so it works while the app
  is off.
- The **request route also calls it for that tenant first**, in the same
  transaction, so a hold that expired 30 seconds ago never blocks a new
  booking.
- `complete_ended_bookings()` sets `completed` where `status = 'confirmed'
  and upper(during) < now()`. Same schedule, same idempotence.

### 2.4 The reference is for people; the secret is for access

- **Reference:** `RSV-<year>-` plus 6 characters from a 30-character alphabet
  with no `0/O/1/I/L`, generated in SQL, `unique`, retried on collision.
  About 729 million per year: guessable in bulk, **so it grants nothing**.
- **Secret:** 32 random bytes, base64url, in the email link as
  `/t/<slug>/booking#<secret>`. It goes after `#`, the same as the reset
  page, so it never reaches a server log or a `Referer` header.
  `booking_access_tokens (tenant_id, booking_id, token_hash, expires_at)`,
  one row per email that carries a link, so a rejection email can carry a
  fresh link without the raw secret ever being stored. Links expire 30 days
  after the booking's end.

### 2.5 Proof upload by a guest who has no staff token

The guest page uploads through our route, which runs on a **chat token**.
The private bucket `payment-proofs` allows a chat token to **insert only**,
only under `<tenant_id>/incoming/<uuid>.<ext>`, with no read, list, update
or delete. Then `submit_payment_proof(secret, path, method, reference,
amount, paid_on)` (definer) checks the secret, checks the object exists
under this tenant's prefix, moves the booking to `pending_verification`,
and inserts the `payments` row in one transaction. Staff read proofs by
**signed URLs** minted server-side on the staff token, valid for 5 minutes.

Everything else from booking-types § 2.8 applies: type by first bytes,
size cap in the route **and** the bucket, no SVG, resized and EXIF-stripped
in the browser, orphans listed by a script. Proofs are guest PII: they are
never in a tool result and never in a public bucket.

**Duplicates:** the submit form carries an idempotency key generated when
the page loads; `unique (tenant_id, booking_id, idempotency_key)` on
`payments` turns a double click into one row. A second, different
submission while one is `submitted` or `verifying` is refused with
"a payment is already being reviewed".

### 2.6 Email through an outbox, because a failed send must not undo a booking

Sending inside the request would make a slow provider slow the booking,
and a failed send would leave a booking the guest never heard about. So an
**`email_outbox`** row is written in the same transaction as the change
that causes it (by the events trigger, Rule 2), and a sender delivers it
afterwards:

- `claim` with `for update skip locked`, send, set `sent_at`; a failure
  sets `attempts` and `last_error` and is retried with backoff;
- the provider is called over **raw `fetch`**, like `@rag/openai` (D-002):
  one POST, no SDK;
- while local only, the sender runs after each request that queued mail and
  as `pnpm --filter @rag/bookings notify` for mail queued by `pg_cron`
  (expiry). Deployed, it becomes a cron route.

Staff notification ("a payment needs verification") goes to every member of
the tenant.

### 2.7 "Confirmed" means the required amount was verified

`required_amount` = full `price`, or the reservation fee: a fixed amount, or
a percentage of `price` **rounded up to the centavo** (rounding down would
confirm on one centavo short). Stored at creation, so a settings change
later does not move a booking's goalposts.

| Verified so far | Booking-level `payment_status` | Booking may be confirmed |
|---|---|---|
| nothing, no proof | `unpaid` | no |
| a proof `submitted` | `proof_submitted` | no |
| a proof being reviewed | `verifying` | no |
| last proof rejected, nothing verified | `rejected` | no |
| ≥ required, < price | `partially_paid` | **yes** |
| ≥ price | `paid` | yes |
| a refund recorded | `refunded` | stays as it is; staff cancel if they mean to |

`outstanding = price − received`. Approving a payment and confirming the
booking are **one** staff action (`approve_payment`), and the SQL guard
refuses `confirmed` when `received < required`.

### 2.8 Staff bookings and old rows keep working

- Staff can still create a booking **directly as `confirmed`** (a Viber
  booking, paid in person), with `payment_status` null: "not tracked". This
  is today's behaviour, and every existing booking is one.
- A tenant with **no `payment_settings` row** has no guest booking and no
  "Book this" button. That is the default for every existing tenant.
- Old `pending` rows become `pending_payment` with a null deadline: the
  job never expires them, and staff confirm or cancel them as now.

### 2.9 An expired booking with a real payment

Money can arrive after expiry. The guest page for an expired booking shows
"expired" and accepts no proof. Staff can **record** a payment on an
expired booking, which never changes its status. Then they either record a
refund, or **rebook**: a new booking (a fresh insert, so the exclusion
constraint decides whether the room is still free), with `rebooked_from`
pointing back and the payment moved to it. Never an automatic confirm.

### 2.10 The chat's status lookup is bound to the conversation

`booking_status` takes **no arguments** and returns the bookings created
**from this conversation** (the server's conversation id, not the model's).
Reference, status, payment status, amount due, deadline. A guest who types
a reference in a new chat gets "use the link in your email", because a
reference grants nothing (§ 2.4). The conversation id is a random UUID the
browser already holds for its history, so this is the same trust as reading
that conversation's messages.

---

## 3. The data model

`packages/db/sql/schema-payments.sql`, idempotent, run after
`schema-booking-types.sql`.

```sql
-- 1. Statuses. Old values migrated in place, never deleted.
update bookings set status = 'pending_payment' where status = 'pending';
alter table bookings drop constraint if exists bookings_status;
alter table bookings add constraint bookings_status check (status in
  ('pending_payment','pending_verification','confirmed','cancelled','expired','completed'));
-- bookings_no_overlap re-created with status not in ('cancelled','expired')  (§ 2.2)

-- 2. New booking columns (all nullable: old rows stay as they are)
--    reference text unique, payment_status text (check: the seven + null),
--    payment_deadline timestamptz, required_amount bigint, received_amount bigint,
--    guest_email text, conversation_id uuid, source text ('staff' | 'chat'),
--    rebooked_from bigint (composite FK), cancel_reason text

-- 3. The transition guard + event writer: ONE trigger, before update of status.
--    Allowed (from → to), everything else is 23514:
--      (insert)             → pending_payment | confirmed(staff only, not tracked)
--      pending_payment      → pending_verification | cancelled | expired
--      pending_verification → confirmed (received >= required)
--                           | cancelled (staff, reason required)
--                           | pending_payment (proof rejected AND deadline not passed)
--                           | expired   (proof rejected AND deadline passed)
--      confirmed            → completed (upper(during) < now()) | cancelled (staff, reason)
--      expired, cancelled, completed → nothing
--    Actor: auth.uid() on a staff token; 'guest' / 'system' set by the
--    definer functions and the cron jobs via set_config('app.actor', ...).

-- 4. payments  (tenant_id, id, booking_id → composite FK, method, reference,
--    amount_claimed, paid_on, proof_path, idempotency_key,
--    status: submitted | verifying | verified | rejected | refunded,
--    verified_amount, verified_by uuid, verified_at, account_checked boolean,
--    rejection_reason, refund_amount, refunded_by, refunded_at)
--    check: verified ⇒ verified_amount, verified_by, verified_at, account_checked = true
--    check: rejected ⇒ rejection_reason not blank
--    trigger: recompute bookings.received_amount and payment_status (Rule 3)

-- 5. booking_events (tenant_id, booking_id, at, actor, from_status, to_status,
--    payment_id, reason). RLS: staff read; NO update or delete policy, for anyone.

-- 6. payment_settings (tenant_id PK, methods jsonb [{kind, label, account_name,
--    account_number, instructions}], fee_kind 'fixed'|'percent'|'full',
--    fee_value, deadline_hours, cancellation_policy text, refund_policy text)
--    RLS: any token of the tenant reads (guests are shown it); admins write.
--    No row = payments off (§ 2.8).

-- 7. booking_quotes (§ 2.1), booking_access_tokens (§ 2.4), email_outbox (§ 2.6)
--    each with tenant_id, composite FKs, and policies.

-- 8. Definer functions, each checking the token's tenant like check_availability:
--      guest_booking(p_tenant_id, p_secret)       → one booking, guest columns only
--      submit_payment_proof(p_tenant_id, p_secret, ...)
--    Invoker functions for staff (atomic multi-row changes):
--      mark_verifying, approve_payment, reject_payment, record_refund, rebook

-- 9. pg_cron: expire_due_bookings() and complete_ended_bookings(), every minute.

-- 10. Storage: private bucket 'payment-proofs'; chat token insert-only under
--     <tenant_id>/incoming/; staff read via signed URLs (§ 2.5).
```

CLAUDE.md rule 8 says "only two functions are `security definer`". This
makes four. Each one checks the tenant itself and returns a fixed column
list, which is what made the first two acceptable (D-042).

---

## 4. Affected files

| Area | File | Change |
|---|---|---|
| SQL | `packages/db/sql/schema-payments.sql` | **new**, § 3 |
| DB types | `packages/db/src/…` | the new tables, columns and functions |
| Checks | `packages/db/tools/verify.mjs` | RLS on every new table, the events table's missing update/delete, the bucket's insert-only path, each with a positive twin |
| Domain | `packages/bookings/src/lifecycle.ts` | **new**: request from a quote, approve, reject, verifying, cancel, refund, rebook |
| Domain | `packages/bookings/src/payments.ts` | **new**: settings, amounts, proof submission, signed proof URLs |
| Domain | `packages/bookings/src/guest.ts` | **new**: `guestBooking(secret)`, the only guest read |
| Domain | `packages/bookings/src/email.ts`, `tools/notify.mjs` | **new**: templates (plain text + escaped HTML), outbox sender over raw `fetch` |
| Domain | `packages/bookings/src/types.ts`, `bookings.ts`, `errors.ts` | new statuses, `BookingSummary` payment fields, `createBooking` stays for staff |
| Routes | `…/bookings/request/route.ts` | **new**, open, rate-limited: quote → `pending_payment` |
| Routes | `…/booking/route.ts`, `…/booking/proof/route.ts` | **new**, open, rate-limited, secret in the body: guest view and proof upload |
| Routes | `…/payments/…` | **new**, staff: list awaiting, proof URL, verifying, approve, reject, refund |
| Routes | `…/payment-settings/route.ts` | **new**, staff |
| Rate limit | `apps/web/lib/rate-limit.ts` | **new**, R-13: per IP and per conversation, on every open write |
| Pages | `app/t/[tenant]/booking/page.tsx`, `components/guest-booking.tsx` | **new** guest page (secret from `#`) |
| Pages | `app/t/[tenant]/admin/payments/page.tsx`, `components/payments-screen.tsx`, settings on the same screen | **new** S-6 |
| Screen | `components/bookings-screen.tsx` | reference, both statuses, amounts, history drawer |
| Chat | `components/chat-screen.tsx`, `sources-panel.tsx` | "Book this" button and guest form from a quote record; the created booking's summary |
| Tools | `packages/rag/src/tools.ts`, `applications.ts` | `quote_booking`, `booking_status` (both read-only) |
| Prompt | `packages/rag/src/tools.ts` instruction lines | how to explain payment steps; never state a status without `booking_status` |
| Battery | `packages/rag/tools/prompt-eval.mjs` | § 5 Phase 8 |
| Env | `apps/web/lib/env.ts`, `.env.example` | `RESEND_API_KEY`, `EMAIL_FROM`, `APP_URL` |

---

## 5. The phases

### Phase 0 — Prerequisite and baseline

booking-types.md built and recorded. Then save
`plan/baseline/*-pre-payments.txt` (battery, both prompt snapshots, verify,
both isolations, tests).

### Phase 1 — Three spikes, each able to stop the plan

1. `pg_cron` is enabled and runs a function every minute on this project.
2. Resend sends one message from `onboarding@resend.dev` to a test inbox,
   over raw `fetch`, and a second POST with the same `Idempotency-Key`
   sends nothing (checked in the inbox, not by the status code).
3. A chat token can insert under `<tenant>/incoming/` in a private bucket,
   and cannot read, list or overwrite; a staff token can sign a URL.

### Phase 2 — Schema

**Done when**: every existing booking keeps its status (old `pending` now
`pending_payment` with a null deadline), unit, `during` and price; villa's
`check_availability` matches the baseline; the transition guard refuses
every pair not in § 3 (the whole 6 × 6 matrix, in verify); an update with
no event is impossible (checked by counting events).

### Phase 3 — `@rag/bookings`

Tests for: every valid and invalid transition; fee fixed / percent (rounding
up) / full; partial payment confirms only at ≥ required; reject before and
after the deadline; proof before the deadline, approved after it; expiry
never touches `pending_verification` or `confirmed`, and runs twice
harmlessly; two concurrent requests for one room, one `23P01`; per-room
holds (one room held, the room beside it still bookable); a whole-resort
tenant is refused payment settings and offered no `quote_booking`; an
expired booking cannot be approved.

### Phase 4 — Staff routes and screens

S-6 payments (awaiting, proof, approve with a verified amount and an
"I checked the account" box, reject with a reason, history), settings, and
the bookings screen changes. **Done when** a walk does each action once and
`booking_events` shows each one with the right actor.

### Phase 5 — Guest page and proof

**Done when**: the link opens the booking; the reference alone opens
nothing; another tenant's slug with the right secret is "not found"; a
double submit makes one payment; a PNG named `.pdf` and an oversized file
are refused.

### Phase 6 — Email

Outbox, sender, the seven templates. **Done when** each notification in the
request is triggered once and arrives, and a provider outage leaves the
booking created and the email retried.

### Phase 7 — Expiry and completion

**Done when** a booking with a deadline one minute ahead expires within the
next run, its room shows open, its guest gets the email, and a second run
changes nothing.

### Phase 8 — Chat

`quote_booking`, the button and form, `booking_status`. New cases, roughly:
`pay-quote` (quotes with fee and deadline, creates nothing), `pay-claim`
("I paid, confirm me" → status unchanged, says it awaits verification),
`pay-status` (status from the tool), `pay-ref` (a typed reference gives no
details), `pay-inject` (a message asking to approve or book someone else
does nothing), `pay-howto` (proof steps from the settings), plus a Taglish
case. **Done when** the original battery still gives 36/38, villa's and
Northwind's prompts match Phase 0 for a tenant **without** payment settings,
and every `pay-*` case passes (repeat any that flip, R-18).

### Phase 9 — Isolation, limits, bundle

Both isolations grow payment, proof, event and outbox cases, both ways.
The rate limit refuses the 11th request in a minute (the number measured,
not chosen, from the walk). Rule 2's grep includes `RESEND_API_KEY` and its
value.

### Phase 10 — The record

---

## 6. Decisions to log

| | Decision | The short reason |
|---|---|---|
| **D-057** | The model quotes; a button and a form book. Amends D-037: tools stay read-only | An open route's write is still ours, validated, rate-limited, and never driven by model text. Guest PII never enters a prompt |
| **D-058** | The status machine and the audit event are one SQL trigger | No path can skip either, including the SQL editor |
| **D-059** | Booking-level payment status and received amount are derived from `payments` by trigger | They cannot disagree with the payments that produce them |
| **D-060** | `expired` frees the hold; expiry and completion are `pg_cron` jobs, plus an expire-first in the request path | A constraint cannot use `now()`; the job never needs the app running |
| **D-061** | Reference for people, 32-byte secret for access, hashed, in the `#fragment` | A reference is guessable in bulk; the fragment stays out of logs |
| **D-062** | Guest reads and proof submission are definer functions on a chat token; four definer functions now | No guest accounts, no `service_role`, fixed column lists |
| **D-063** | Email through an outbox and a sender over raw `fetch` to Resend, the outbox id as `Idempotency-Key` | A failed send never undoes a booking; a retry never sends twice; no SDK (D-002) |
| **D-064** | Guest booking and payments are `per_room` only; enforced by a trigger on `payment_settings` | A whole-resort price exists only in documents (booking-types § 8 q3), and a payment needs a trusted amount |

---

## 7. Risks

| | Risk | Honest assessment |
|---|---|---|
| **R-31** | The open request route is spammed to hold every room | Rate limits, a cap on open holds per email and per conversation, and short deadlines. Not a CAPTCHA. The first real abuse decides whether one is needed |
| **R-32** | Staff approve without checking the account | The checkbox and the typed verified amount make it a recorded choice, not a click. Nothing can check a bank from here |
| **R-33** | Proof images are guest PII kept indefinitely | Private bucket, signed URLs. A retention period is § 9 question 6 |
| **R-34** | Emails need a public URL and a verified sender domain | Blocks real guests until deployment (D-013) |
| **R-35** | The model explains a status or amount from memory instead of the tool | `pay-claim` and `pay-status` catch it; reopens with every prompt edit (R-14) |

---

## 8. Size

This is larger than the bookings plan and the auth-rls plan put together:
about ten new tables and functions, four screens or pages, three open
routes, a mail system and a scheduler. It should be built after
booking-types, in its own branch, phase by phase as written.

---

## 9. Open questions

**Answered 2026-09-27 by the user:**

1. ~~Where does a whole-resort price come from?~~ **Nowhere: payments are
   `per_room` only.** A `whole_resort` tenant gets no guest booking, no
   `quote_booking` tool, no "Book this" button and no payment settings, and
   villa keeps booking over Viber exactly as today. A `payment_settings` row
   for a `whole_resort` tenant is refused by a trigger, so the combination
   cannot exist. D-064.
2. ~~Is D-057's shape acceptable?~~ **Yes.** The model quotes; a button and
   a form book.
3. ~~Email provider?~~ **Resend**, over raw `fetch`: `POST
   https://api.resend.com/emails`, `Authorization: Bearer <RESEND_API_KEY>`.
   The outbox row's id is sent as Resend's `Idempotency-Key` header (kept 24
   hours by Resend), so a retry after a timeout cannot send twice. Free plan
   (resend.com/pricing, 2026-09-27): 3,000 emails a month, **100 a day**, 3
   domains. Development sends from the sandbox `onboarding@resend.dev`;
   real guests need a verified sender domain. Resend can also be the custom
   SMTP R-21 needs for Supabase Auth.

**Deferred until their phase ("cross the bridge when we get there"):**

- **Deployment** (D-013), needed before any real guest opens an email link
  (R-34). Not needed to build or test any phase.
- **Roles** (before Phase 4, the verification screen). Is "any member of
  the tenant" enough to verify payments, or is a `role` on `memberships`
  wanted (for example, only owners approve)? Until then: any member.
- **Guest phone** (before Phase 2 fixes the columns). Name and email are
  needed; is phone (plan/bookings.md § 8 question 4 asked the same)? Until
  then: optional.
- **Proof retention** (before Phase 5 stores the first proof). How long are
  proof images kept after the booking ends?
