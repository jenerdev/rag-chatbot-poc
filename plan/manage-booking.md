# Manage booking plan: a guest finds their stay, pays, and asks for changes; staff verify and decide

> Today a guest sends a request from `/t/<slug>/book`, gets a reference
> (`VIL-FJK939`) and the tenant's instructions ("pay the reservation fee by
> GCash to …"), and then nothing: there is no page to come back to, no
> place to show that they paid, and no way to ask for a change but a
> phone call. Staff confirm or decline on the Requests section with no
> record of payment, no record of who decided, and no deadline, so an
> unpaid request waits until someone declines it by hand.
>
> This plan adds a public **Manage booking** page (reference + email or
> phone), **payment proof** submitted there and **verified by staff**,
> **payment deadlines** (and, per tenant, a **temporary hold**), guest
> **cancellation and reschedule requests** that staff approve, and an
> **audit trail** of every decision. It keeps three things apart that one
> `status` column would tangle: the **booking** status, the **payment**
> status, and the **change requests**.
>
> It **supersedes [`payments.md`](./payments.md)** (on hold since
> 2026-09-28, nothing built). That plan was written before the booking
> page, roles, D-070, D-095, D-099 and D-100; what still holds from it
> (proof bucket, derived payment status, the events trigger, the outbox)
> is carried over here and re-checked against today's code.
>
> Written 2026-10-10, against `ec8108c` on `master`. **Status: agreed,
> nothing built.** § 9's seven questions were answered 2026-10-10: every
> recommendation taken, by the user's instruction ("take all your
> recommendations").
>
> Read [§ 0](#0-the-six-rules) first.

---

## What this plan covers

| | |
|---|---|
| **In scope** | A public page `/t/<slug>/manage` (S-13): look up a stay by reference + email or phone, through ONE definer function that returns guest-facing columns only; per-tenant **payment settings** (methods and account details, fee: full / fixed / percent, payment window, review window, cancellation and reschedule rules); a `payments` table with a submission history and a **derived** payment status per stay; proof upload to a **private** bucket, staff reading it by signed URL; a staff **Payments** screen (S-14): verify with a typed amount and "I checked the account", reject with a reason; `expired` as a booking status and a deadline that produces it; an optional **hold** (§ 9 q1); guest **cancel** and **reschedule** requests, one open per stay, priced by `unit_quote()` and decided by staff; `booking_events`, written by triggers, so no decision is unrecorded; attention counts on the dashboard; checks in verify, rooms and both isolation suites |
| **Out of scope** | A payment gateway or any automatic verification (a screenshot verifies nothing); refunds that move money (staff record a refund they made elsewhere); guest accounts; changing rooms or guest count in a reschedule (dates only, the same units); SMS / Messenger; **sending email** until deployment and a sender domain exist (Phase 7 is gated, § 2.9); the chatbot: no prompt text, no tool text |

### What the request says, and what is here

| The request says | What the code has | What the plan does |
|---|---|---|
| Separate booking, payment and request statuses | `bookings.status` in `pending, confirmed, cancelled` (`schema-bookings.sql:119`); nothing else | `bookings.status` gains `expired` only. Payment status is **derived** from `payments` (Rule 3). Change requests are their own table with their own status. `completed` is **derived** from the date, never stored (§ 2.6) |
| Look up by reference + email or phone | References exist for every stay (D-100), `VIL-` + 6 of 30 letters; web rows always carry email and phone (`bookings_web_request`), staff rows may not | `guest_stay(tenant, reference, contact)` matches either; a stay with no contact on file cannot be looked up (staff stays usually), and the page says only "not found" (Rule 4) |
| OTP before cancel / reschedule | No email sending at all; Supabase Auth's sender is capped (R-21); local only (D-013) | MVP: every guest action is a **request** staff decide, so reference + contact is enough to *ask*, not to *change*. OTP joins Phase 7 with email (§ 2.2) |
| A temporary hold with an expiry | D-070: a request holds nothing, because an anonymous hold blocks dates with fake names | A per-tenant choice, `hold: none | on_proof | on_request`, default `none` (today). § 2.4 and § 9 q1 |
| Payment deadline, auto-expiry | No `pg_cron`, no scheduler | Correctness needs **no job**: reads compare with `now()`; writes release due holds first under the tenant lock. A `pg_cron` job only tidies statuses (§ 2.5) |
| Upload proof | One **public** bucket, `unit-images`, admin-write; no signed URLs anywhere | A new **private** bucket `payment-proofs`; a chat token may insert under `<tenant>/incoming/` only; staff read by 5-minute signed URLs (§ 2.7) |
| Audit log; who approved, when, why | `decision_note` only; no `decided_by`, no `decided_at`, no event table | `booking_events`, append-only, written **by triggers** on bookings, payments and change requests (Rule 2) |
| Notifications | None | Phase 7, gated on deployment + Resend (payments.md § 9 q3 already chose Resend). Until then the page and the screens are the notification |

---

## 0. The six rules

### Rule 1 — The guest asks; staff decide; Postgres refuses

A guest can submit proof, ask to cancel, ask to reschedule, and withdraw
an open request. Nothing a guest does confirms, cancels, moves or verifies
anything. Staff decisions go through SQL functions that check the
transition themselves, so a stale tab, a script or the SQL editor meets
the same refusal (trap 21).

### Rule 2 — Every decision leaves an event, written by the change itself

Triggers on `bookings` (status), `payments` (status) and
`change_requests` (status) append a `booking_events` row: stay, kind,
from, to, actor (`guest`, `system`, or the staff user from `auth.uid()`),
note, at. `booking_events` has a SELECT policy for staff and **no**
UPDATE or DELETE policy for anyone. A route cannot forget to log, because
no route logs.

### Rule 3 — Amounts come from the database; the payment status is derived

`price` is still `unit_quote()`'s (stored by the insert trigger). A stay's
`required_amount` is computed from the settings **when the stay is
created** and stored, so a settings change never moves a guest's
goalposts. `received` is the sum of **verified** payments minus recorded
refunds, and the payment status is a function of the `payments` rows,
never a column anyone writes. A screenshot has no amount until staff type
the verified one.

### Rule 4 — A guest reaches one stay, by two facts, and a miss says nothing

Every guest read and write is a `security definer` function that takes the
tenant, the reference and the contact (email, case-folded; or phone,
normalised as `request_booking()` does), and returns that one stay's
guest-facing columns: never `notes`, `decision_note`'s staff text, another
stay or another guest. Wrong reference, wrong contact, another tenant's
reference, a staff stay with no contact: the same `null`, the same words,
the same timing class. Failures are counted in SQL per reference (§ 2.2).

### Rule 5 — The confirmed span stays the only thing that blocks, unless the tenant chose a hold

`bookings_no_overlap` keeps `status = 'confirmed'` for a tenant with
`hold: none`. A hold, where chosen, is a **flag the constraint reads**
(`held`), never a time comparison inside a constraint (§ 2.4). D-070,
D-095, D-099 and D-100 stand for every tenant that does not opt in.

### Rule 6 — Both walls, no `service_role`, and the chatbot untouched

New tables carry `tenant_id`, composite FKs and their own policies (R-22);
every query filters on `tenant_id`; guest paths run on the **chat token**
through definer functions, staff paths on staff tokens. No new token
shape (rule 8): the guest has no session, only the two facts, sent with
each call. No prompt text, no tool text: the three baselines stay
byte-identical; the battery runs once because availability reads change
for a tenant with a hold.

---

## 1. The model

```
                 booking status (bookings.status, per row, same for a stay)
  request ──► pending ──confirm──► confirmed ──(end date passes)──► "completed" (derived)
                 │  └─decline/cancel─► cancelled ◄──approve cancel request──┘
                 └─deadline passes, nothing verified─► expired

                 payment status (derived per stay from payments)
  not_tracked | unpaid → submitted → verified (≥ required: "paid enough") | partially_paid | rejected → submitted …
                                                                          refunded / partially_refunded

                 change requests (change_requests.status, ≤ 1 open per stay)
  pending → approved | rejected | withdrawn          kind: cancel | reschedule
```

Verifying a payment and confirming a stay are **two** operations, offered
together as one button when the verified amount reaches `required`
("Verify and confirm"), because deposits and balances make them differ
(the request's own warning). Whether Confirm alone stays allowed with
nothing verified is allowed with a required note (§ 9 q3).

---

## 2. Traps

### 2.1 A stay is a group; most of this plan is per group

`bookings` has one row per unit per night. Payments, deadlines, required
amounts and change requests belong to the **stay** (`group_id`, one
reference, D-100). So the plan adds `stays` (`tenant_id, group_id` PK,
`reference`, `required_amount`, `pay_by`, `review_by`, `held`…), filled
by the same BEFORE INSERT path that fills the reference
(`bookings_aa_fill_group_and_reference`, insert … on conflict do
nothing), and a counted backfill for every existing group. Status stays
on the rows (D-095's one-statement group update keeps them equal); a
check in verify asserts no group has two live statuses.

### 2.2 Lookup is an enumeration target, so the strong limit is in SQL

A reference is 3 known letters + 30⁶ ≈ 729 million: not guessable one by
one, but email is often guessable once a reference leaks (a screenshot,
a forwarded message). Limits, weakest first, the booking page's pattern:
the in-memory per-IP window (`lib/rate-limit.ts`, R-39), then
`guest_lookup_failures (tenant_id, reference, at)`: after 5 misses in an
hour a reference answers `null` even to the right contact, for an hour.
The page says "We could not find that booking" for every miss and for
the lockout alike. Because every guest action is a request (Rule 1), the
worst a stranger with both facts can do before OTP exists is read the
stay and file a request staff will see; R-45 states it.

### 2.3 Every guest call re-sends both facts

No guest session, no cookie, no new token (rule 8). The page keeps the
reference and contact in React state only; a reload asks again. Upload,
cancel, reschedule and withdraw each call a definer function that runs
the same match first. One function, `app_guest_group(tenant, reference,
contact)`, is the match, and every guest function calls it.

### 2.4 A hold cannot be a time comparison in a constraint

`now()` is not immutable, so `where status = 'confirmed' or hold_until >
now()` cannot be an exclusion predicate. The mechanism, if a tenant opts
in:

- `bookings.held boolean not null default false`; the constraint becomes
  `where (status = 'confirmed' or held)`. Re-created; it can fail only if
  two live holds already overlap, which no row can be before this plan.
- **Reads** (`check_availability`, `check_room_availability`,
  `calendar_bookings`, the booking page's quote) treat a row as taken when
  `confirmed or (held and hold_until > now())`: a read may use `now()`.
- **Writes** that could meet a hold (`request_booking()`, staff insert,
  Confirm, approve-reschedule) first call `release_due_holds(tenant)`
  under the tenant's advisory lock: `held = false` where `hold_until <=
  now()`. So an expired hold never blocks a write, and no job is needed
  for correctness.
- `bookings_pending_not_taken` (D-099) and `request_booking()`'s own
  confirmed check treat a live hold like a confirmed row: "held on
  <date>".
- `on_request` sets the hold at insert for the payment window;
  `on_proof` sets it when proof is submitted, for the review window;
  verifying extends nothing (Confirm takes the span); rejecting clears it
  unless the payment window is still open.

Changing `bookings_no_overlap` and four functions is the riskiest step in
the plan; it is Phase 5, alone, after everything else works without it.

### 2.5 Expiry: a status, a sweep, and the same rule at read time

`expired` means: pending, the payment deadline (`pay_by`) has passed, and
nothing verified. Stated in one SQL function, `stay_is_due(…)`, used by
the read paths (the guest page and the Requests list show "expired"
before any sweep has run) and by `expire_due_stays(tenant)`, which writes
the status (and its events). The sweep runs on every staff list load and
every request write for that tenant, and, if Phase 0's spike finds
`pg_cron` available, every 5 minutes. A stay with proof **submitted
before** `pay_by` is never expired while that proof is under review
(`review_by` governs it instead). `pay_by` null (every old row, every
staff stay unless staff set one) never expires.

### 2.6 `completed` is derived

A stored `completed` needs a job to set it and buys nothing a date
comparison does not give. The page and the screens say "completed" when
confirmed and the last night has ended, in the tenant's day (trap 9).

### 2.7 Proof upload without a staff token

The route matches the stay first (wall 1), then uploads on the **chat
token** to the private bucket `payment-proofs` under
`<tenant_id>/incoming/<uuid>.<ext>`; the bucket's policies give a chat
token INSERT only, under its own tenant's folder, and no SELECT, UPDATE
or DELETE (wall 2). The chat token never reaches the browser, so only our
route holds it. Then `submit_payment(tenant, reference, contact, path,
method, claimed_amount, paid_on, payer_reference, idempotency_key)`
(definer) checks the object exists under that prefix and is not already
claimed, inserts the `payments` row, and sets a hold if `on_proof`.

- JPEG, PNG, WebP, PDF; 5 MiB; type by first bytes in the route **and**
  the bucket's `allowed_mime_types`; images resized and EXIF-stripped in
  the browser (`resize-image.ts`), PDFs passed as they are.
- `unique (tenant_id, group_id, idempotency_key)`: a double click is one
  row. A second submission while one is `submitted` is refused in words.
- Staff read a proof by `createSignedUrl` on the staff token, 5 minutes,
  never stored. Unclaimed objects (an upload whose submit failed) are
  listed by `storage-orphans.mjs`, which grows the bucket.
- Proofs are guest PII: never in a tool result, never public (R-48).

### 2.8 A reschedule is new rows, the old ones kept until the new ones exist

The price is set by the insert trigger, never by an update (Rule 2 of
booking-types), and `during` is computed on insert. So approving a
reschedule is one function, `approve_change(id)`, under the tenant lock:
insert the new nights for the **same units** in the **same group** (the
fill trigger reuses the reference), with the old rows' status; then
cancel the old rows with the note "rescheduled to …". The insert meets
`bookings_no_overlap` first: taken dates are the 409 and nothing changes,
the request stays pending. The quote the guest saw (`unit_quote()` +
`promo_discount()` for the new dates) is stored on the request; the
approval re-prices for real and the **difference** moves the stay's
`required_amount` (§ 9 q5). A promo that is not valid on the new dates
is lost, and the quote says so before the guest submits.

### 2.9 Email needs three things the project does not have

A sender (Resend, chosen in payments.md § 9 q3), a verified domain, and a
public URL for links (D-013, R-34). Phase 7 builds the outbox (written by
the events triggers, so a failed send never undoes a decision) and the
sender over raw `fetch` (D-002), and sends only when `RESEND_API_KEY` is
set. Every phase before it works with no email: the guest checks the
page; staff see counts.

### 2.10 Replacing `request_booking()` again

Its latest body is in `schema-staff-requests.sql`. This plan's file
replaces it (live holds in its check, `stays` terms, the sweep), so the
staff-requests file's step is guarded on this file's marker (trap 20),
as that file guarded the promos file's.

---

## 3. The data model

New files, each idempotent, each run by the user:
`schema-manage-booking.sql` (Phases 1, 3, 4, 6) and
`schema-holds.sql` (Phase 5, alone, because it re-creates the constraint).

```sql
-- stays (tenant_id, group_id PK, reference, required_amount bigint null (null = not tracked),
--        pay_by timestamptz null, review_by timestamptz null, hold_until timestamptz null,
--        created_at). Composite FK from bookings (tenant_id, group_id). Backfilled, counted.
-- bookings.status check gains 'expired'. bookings.held boolean default false (schema-holds.sql).

-- tenant_applications.config.bookings.payments (validated by the existing trigger):
--   { methods: [{ kind: 'gcash'|'bank'|'other', label, account_name, account_number, instructions }] (1–5),
--     fee: { kind: 'full'|'fixed'|'percent', value }   -- centavos, or hundredths of a percent (promos' shape)
--     pay_within_hours 1–168, review_within_hours 1–168,
--     hold: 'none'|'on_proof'|'on_request',
--     cancellation: [{ days_before, refund_percent }] (ordered), reschedule_until_days_before,
--     terms text ≤ 4000 }
--   No 'payments' key = the tenant has no payment flow; the manage page still looks up stays.

-- payments (tenant_id, id, group_id → stays, kind 'payment'|'refund', method, payer_reference,
--           claimed_amount, paid_on, proof_path unique, idempotency_key,
--           status 'submitted'|'verified'|'rejected', verified_amount, account_checked,
--           reviewed_by uuid, reviewed_at, rejection_reason, created_at)
--   checks: verified ⇒ verified_amount > 0 and account_checked and reviewed_by;
--           rejected ⇒ rejection_reason not blank; refund ⇒ entered by staff, verified.
-- stay_payment(tenant_id, group_id) → (required, received, outstanding, status)   ONE function (Rule 3)

-- change_requests (tenant_id, id, group_id, kind 'cancel'|'reschedule', status
--   'pending'|'approved'|'rejected'|'withdrawn', new_check_in, new_nights, quoted_price,
--   quoted_difference, refund_due, guest_reason, decision_note, decided_by, decided_at, created_at)
--   unique (tenant_id, group_id) where status = 'pending'          -- one open per stay

-- booking_events (tenant_id, id, group_id, at, actor_kind 'guest'|'staff'|'system', actor_user,
--   kind, from_value, to_value, payment_id, change_request_id, note)
--   staff SELECT only; no UPDATE / DELETE policy. Triggers on bookings, payments, change_requests.
-- guest_lookup_failures (tenant_id, reference, at)   -- § 2.2; no policy for any token, definer-only

-- Definer functions (each the D-042 shape: search_path '', checks the token's tenant):
--   guest_stay(tenant, reference, contact)                          the only guest read
--   submit_payment(…), request_change(…), withdraw_change(…)        the guest writes
-- Invoker functions for staff (atomic, under RLS):
--   review_payment(id, verify|reject, amount, account_checked, note, confirm boolean)
--   record_refund(group, amount, note), decide_change(id, approve|reject, note),
--   expire_due_stays(tenant), release_due_holds(tenant)

-- Storage: private bucket 'payment-proofs', 5 MiB, jpeg/png/webp/pdf;
--   chat token INSERT under <app_tenant_id()>/incoming/; staff SELECT (for signing) under their tenant.
```

That is four more definer functions (sixteen); each returns a fixed
column list and matches the stay itself, which is what made the first
twelve acceptable (D-042).

---

## 4. The screens

**S-13, `/t/<slug>/manage` (public).** A lookup form: reference, then
"email or phone". Then one card for the stay: dates, units, guests,
price lines, the booking status and the payment status in words, and
**one next action**, by state:

| State | The card's action |
|---|---|
| pending, unpaid, before `pay_by` | the payment methods and amount due by `<time>`; "Upload proof of payment" |
| proof submitted | the submission (amount, date, file name) and "being checked"; nothing else to do |
| proof rejected | the reason; upload again (until `pay_by`) |
| confirmed | "Request a change": reschedule (dates, a live quote with the difference) or cancel (the refund the policy gives, shown before sending) |
| a change request pending | the request; "Withdraw" |
| cancelled / expired / completed | the final status; contact details |

The booking page's "Request sent" panel gains "Manage this booking" with
the reference filled in. The submission history is listed under the card.

**S-14, `/t/<slug>/admin/payments` (staff).** Three tabs (`tabs.tsx`):
*To verify* (oldest first: reference, guest, claimed amount, method,
payer reference, submitted ago, the proof in a lightbox from a signed
URL; Verify with a typed amount and "I checked the account", Verify and
confirm when it reaches the required amount, Reject with a required
reason), *Change requests* (the request, the quote or refund due, the
policy that produced it; Approve / Reject with a note), and *Settings*
(admins: the § 3 keys). A stay's **history** (its `booking_events`) opens
from any row here and from the Bookings screen.

The Bookings list and the Requests section show the payment status and
`pay_by` beside each pending stay; the calendar (S-12) draws held nights
apart from confirmed ones; the dashboard's attention strip gains "proofs
to verify" and "change requests".

Permissions (`lib/permissions.ts`): `payments:read`, `payments:write`,
`payments:settings`: every role reads; owners and admins write and
change settings (§ 9 q4).

---

## 5. Phases

### Phase 0 — Baseline and spikes

*Baseline done 2026-10-10* on `feat/manage-booking` (status.md has the
numbers; files in `plan/manage-booking/phase0-*`). *Spike (a) passed
14/14* (`phase0-spike.txt`): § 2.7 stands. *Spike (b):* `pg_cron` 1.6.4 is
available, not enabled; only § 2.5's sweep would use it.

Every suite on the branch's first commit, the three baselines saved, the
battery once. Spikes, each able to change the plan: (a) a private bucket
where a chat token can insert under its folder and cannot read, list or
overwrite, and a staff token can sign a URL; (b) whether `pg_cron` can be
enabled on this project (only tidiness depends on it, § 2.5).

### Phase 1 — SQL: stays, statuses, events, lookup

*Done 2026-10-10:* the user ran `schema-manage-booking.sql`; stays 28 =
groups 28; verify 125–132 pass; every other suite and baseline unchanged.
`stays` + backfill (counted: groups before = stays after), `expired`,
`booking_events` and the bookings trigger, `guest_lookup_failures`,
`guest_stay()`. **Done when** verify proves: the right pair finds the
stay; every wrong pair, another tenant's reference and a 6th miss give
`null` (each with its positive twin); a confirm and a decline each leave
one event with the staff user; no event can be updated or deleted by any
token.

### Phase 2 — S-13, read-only

*Done 2026-10-10:* walk 6/6 (`plan/manage-booking-phase2-walk.mjs`).
The route (`withTenantRoute`, open, rate-limited), the page, the link
from the booking page. **Done when** a walk finds a web stay by email and
by phone, fails the same way on every miss, and shows no staff note.

### Phase 3 — Payment settings and proof

*Done 2026-10-10:* verify 133–138, walk 6/6 (`plan/manage-booking-phase3-walk.mjs`); the checks went to verify and the walk, not rooms.
The config keys and validator, `payments`, `stay_payment()`,
`submit_payment()`, the bucket, the upload route. **Done when** rooms
proves fee full / fixed / percent (rounded **up** to the centavo); a
double submit is one row; a PNG named `.pdf` and a 6 MiB file are
refused; a second submission while one is open is refused in words.

### Phase 4 — S-14 verification

*Done 2026-10-10:* verify 139–144, walk 5/5 (`plan/manage-booking-phase4-walk.mjs`). The note rule (§ 9 q3) applies to TRACKED stays only. Owed: the Bookings screen's payment badge and the dashboard's two counts (§ 4).
`review_payment()`, `record_refund()`, the screen, the signed URL, the
history drawer. **Done when** verify-and-confirm is one statement with
two events; a rejected proof shows its reason on S-13; partial payment
confirms only at ≥ required; an expired stay cannot be verified-and-
confirmed; a Confirm with nothing verified is refused without a note
and accepted with one (q3); a `staff` member's verify is a 403 and
Postgres refuses it too (q4); staff of tenant A cannot sign B's proof (isolation, both ways).

### Phase 5 — Deadlines and holds (`schema-holds.sql`)

*Done 2026-10-10:* verify 145–150; with `none`, availability and the three baselines byte-identical to Phase 0; battery 55/61, the three new misses the model's (identical tool results, trap 24). Not enabled: pg_cron (the sweep runs before each staff list).
`pay_by` / `review_by` at creation, `stay_is_due()`, the sweep, then the
hold (§ 2.4) behind the setting. **Done when**: with `hold: none`
everything matches Phase 0 (availability, the three baselines, the
battery); with `on_request`, a second request for the held night is
refused in words until `hold_until`, and accepted one second after it
with no job having run; two concurrent requests for one night give one
hold and one 23P01; `on_proof` holds only from the upload; expiry never
touches a stay whose proof arrived before `pay_by`.

### Phase 6 — Cancel and reschedule requests

*Done 2026-10-10:* verify 151–156; every other suite, the walks and the baselines unchanged.
`change_requests`, `request_change()`, `withdraw_change()`,
`decide_change()`, the quote, the S-13 forms, the S-14 tab. **Done
when**: one open request per stay; the refund due matches the policy row
for that day count; a reschedule to a taken date is the 409 with the old
nights intact; an approved reschedule keeps the reference, re-prices,
and moves `required_amount` by the difference; a cutoff refuses in
words.

### Phase 7 — Email (gated)
Only after deployment and a sender domain (§ 2.9, § 9 q6): outbox,
sender, OTP for change requests. Until then, skipped and recorded so.

### Phase 8 — Walls, walk, record
Both isolation suites grow stays, payments, proofs, events, change
requests, both ways; verify and rooms counts; the bundle grep; the axe
audit over S-13 and S-14; `storage-orphans --expired` (q7); the browser walk by the user. The record:
D-104–D-109, CLAUDE.md, flow.md § 5, payments.md marked superseded,
status, whats-done.

---

## 6. What must not change

- With `hold: none` (every tenant until it opts in): D-070, D-095,
  D-099, D-100 exactly; `bookings_no_overlap`'s behaviour; availability.
- `unit_quote()`, `promo_discount()`, `rate_kind()` remain the only
  places a price, a discount or a rate is made.
- The chatbot: no prompt text, no tool text, the three baselines
  byte-identical, no tool result field added (rule 7).
- No request holds a key that bypasses RLS; no new token shape.

---

## 7. Decisions to log

| | Decision | The short reason |
|---|---|---|
| **D-104** | A guest manages a stay by reference + email or phone, through one definer read; misses are counted in SQL | No accounts, no new token; a reference alone grants nothing |
| **D-105** | Booking, payment and change requests are three statuses; payment is derived, `completed` is derived, `expired` is stored | A column nobody writes cannot disagree with what produced it |
| **D-106** | A hold is per tenant (`none` / `on_proof` / `on_request`), a flag the constraint reads, released before every write | `now()` cannot be in a constraint; no job is needed for correctness. Amends D-070 for tenants that opt in |
| **D-107** | Proof goes to a private bucket on the chat token, insert-only; staff verify with a typed amount; verify and confirm are two operations, one button | A screenshot proves nothing; deposits make them differ |
| **D-108** | Cancel and reschedule are requests; approval inserts new rows before cancelling old ones | The original stay is never lost to a failed change |
| **D-109** | Every decision is a `booking_events` row written by a trigger | No route can forget; the first record of who decided |

## 8. Risks

| | Risk | Honest assessment |
|---|---|---|
| **R-45** | Someone with a leaked reference and the guest's email reads the stay and files requests | Read: yes, until OTP. Change: no, staff decide every request. Lockout after 5 misses |
| **R-46** | Staff verify a fake screenshot | The typed amount and the checkbox make it a recorded choice; nothing here can check a bank |
| **R-47** | `on_request` holds let strangers block dates | The per-contact cap (3), short windows, and the default `none`. The first abuse decides |
| **R-48** | Proof images are guest PII kept indefinitely | Private bucket, signed URLs; deleted 180 days after the stay ends (§ 9 q7) |
| **R-49** | Guests are never told anything until email exists | The page is the notification; the booking page says to check back |

---

## 9. Questions, answered 2026-10-10

All seven answered by the user: "take all your recommendations". Each
answer below is now the plan.

1. ~~The hold: does a new request block its dates while the guest pays?~~
   **The setting is built with `none` as the default; real tenants use
   `on_proof`.** `on_request` stays available but is not recommended: it
   lets anyone with a phone number block three stays for the payment
   window, the exact reason for D-070. `on_proof` holds from the moment
   someone has plausibly paid, the case that hurts (paid, then lost the
   date). One mechanism serves all three values (§ 2.4, D-106).
2. ~~Lookup by email OR phone, or require both?~~ **Either.** Guests
   remember one; the lockout and "requests only" carry the risk (§ 2.2,
   R-45).
3. ~~May staff Confirm a stay with nothing verified, once a tenant has
   payments on?~~ **Yes, with a required note** ("paid in cash",
   "Viber"), kept in the stay's history. Postgres refuses the confirm
   with no note when the tenant has payments on and nothing is verified.
4. ~~Who verifies payments?~~ **Owners and admins verify and change the
   settings; staff read the queue.** `payments:read` for every role,
   `payments:write` and `payments:settings` for owner and admin;
   `review_payment()` asks `app_is_admin()` again (D-079).
5. ~~A reschedule that costs more?~~ **Approved now; the difference
   becomes outstanding** on the stay. A cheaper one records a refund due,
   never automatic (§ 2.8).
6. ~~Email now or after deployment?~~ **After deployment.** Phase 7 is
   skipped and recorded as skipped until then; Phases 1–6 stand alone.
7. ~~How long are proofs kept?~~ **180 days after the stay ends**, then
   deleted by `storage-orphans --expired` (built in Phase 8); the
   `payments` row (amounts, reviewer) is kept.
