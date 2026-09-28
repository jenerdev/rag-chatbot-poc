# Customer booking plan: a booking page per resort, holiday pricing, multi-night stays

> Every tenant with the bookings application gets a public page,
> `/t/<slug>/book`, where a customer picks a date (or a stay of several
> nights), sees the price the database computes, and sends a **booking
> request** with their name, phone and email. Staff confirm or decline it on
> the bookings screen. The chatbot does not book; it tells people how to, and
> the chat screen gets a "Book" button that opens the page.
>
> Two pricing changes come with it, because a page that shows a price must
> show the right one:
> - **holiday pricing:** a per-tenant calendar of holiday and peak dates, and
>   a per-date surcharge, read by `unit_price()`, so `unit_quote()` stays the
>   ONE function that makes every price;
> - **villa gets prices in the database.** A `whole_resort` tenant is priced
>   the same way as a room: its one unit ("Whole property") gets rates per
>   slot. This reverses booking-types § 8, question 3.
>
> And **multi-night stays** ("3 days 2 nights"), for a room or for the whole
> resort: N consecutive nights of the tenant's overnight slot, stored as N
> rows in one group, each priced for its own date.
>
> Written 2026-09-28, against `08f78b8` on `master`. **Status: agreed
> 2026-09-28, nothing built.** § 8 answered: every recommendation taken.
> [`payments.md`](./payments.md) is on hold; this plan takes the parts of it
> that a request with no payment needs (the public write, the reference) and
> leaves the rest (payment statuses, proofs, email, expiry) out.
>
> Read [§ 0](#0-the-five-rules) before anything, and § 1, which lists where
> the request and this codebase disagree.

---

## What this plan covers

| | |
|---|---|
| **In scope** | A public booking page per tenant (both booking types); a read-only quote from `unit_quote()`; booking requests (`pending`) written by one `security definer` function; a reference for people; multi-night stays of the overnight slot, for one room, several rooms or the whole resort; a holiday calendar with per-date surcharges; villa's rates, capacity and extra-guest fee in the database; a staff "Requests" view that confirms or declines a whole request at once; a staff Holidays screen; abuse limits on the one new open write; a "Book" button in the chat; verify, isolation and battery cases |
| **Out of scope** | Payment of any kind, proof upload, payment statuses (payments.md, on hold); email or SMS to anyone (no sender exists; § 8 q6); a guest page to look up or change a request; the chatbot booking or quoting (D-037 stands); multi-night discounts or minimum stays (§ 8 q3); extensions, pets, security deposits (villa's staff handle those as now); subdomains (status.md backlog) |

---

## 1. What the request assumes, and what is actually here

| The request says | What the code has | Consequence |
|---|---|---|
| "The chatbot only gives instructions on how to book" | Chat tools are read-only (D-037), and villa's documents already say how to book (by Viber) | **No change to `buildPrompt()` and no new tool.** The chat screen gets a "Book" button (UI, not model), and each tenant's "how to book" document is edited to point at the page. Rule 1 |
| "A separate page for customer booking", **every resort tenant** | No public write exists. Every booking insert is on a **staff** token (`bookings_insert` needs `app_is_admin()`) | The page's write is the first time a stranger's input becomes a `bookings` row. It goes through ONE definer function that can only insert `pending` rows (Rule 2, § 2.1) |
| Prices on the page, for villa too | `whole_resort` has **no price**: the trigger sets `price := null`, and villa's rates are prose in `sample-documents/02-rates-and-schedules.md` | Villa's one unit gets `unit_rates`, and the trigger prices `whole_resort` too **once rates exist** (§ 2.4). Until then a whole_resort tenant has no page |
| "Holiday pricing" | Weekday/weekend only. Holidays and surcharges were declined on purpose (booking-types § 2.2, § 8 q2; **R-24 accepted**) | A `rate_calendar` table and an optional `holiday_price` per rate (§ 2.3). R-24 closes |
| "A room or the resort booked for 3 days 2 nights" | A booking is **one unit × one slot × one date**. `group_id` already ties several rows into one booking (booking-types § 2.5) | A stay is N rows of the overnight slot on consecutive dates, one `group_id`. No new availability model: `bookings_no_overlap` already refuses a clash on any night (§ 2.2) |
| "Villa does not hold a date on a messaged promise" (villa's own `04-booking-and-payment.md`) | `bookings_no_overlap` holds every status except `cancelled`, so a `pending` row would block the date | A request **does not hold** the date; only `confirmed` does (§ 2.5, § 8 q1). That is also the defence against fake requests blocking a calendar |
| Name, phone and email | `guest_name`, `guest_phone` exist; no email column | `guest_email` is added. None of them can be *verified* as real by this plan (§ 2.7) |

---

## 0. The five rules

### Rule 1 — The chat does not change, and the prompt text proves it

No tool is added and no tool text changes. `buildPrompt()`, `language.ts`
and `dates.ts` are not edited. Northwind's prompt snapshot must match
`northwind-prompt-pre-bookings.txt`, and villa's and harbor's tool
definitions must match their Phase 0 baselines byte for byte. The battery
must still read 49/51 (± the known flips). The one allowed change is what
`check_availability` *returns* for a date that has only a `pending` request
(§ 2.5), and today no such row exists.

### Rule 2 — The public write is one function, and it can only ask

`request_booking()` is the only way a chat token writes to `bookings`. It
inserts `status = 'pending'`, `source = 'web'`, and nothing else can be
chosen by the caller: not the status, the price, the tenant or the group.
It takes `p_tenant_id` (wall 1) and refuses one that is not the token's
(`app_tenant_id()`, wall 2), exactly as
`check_availability` does (D-042). No RLS insert policy is added for chat
tokens, so a direct PostgREST insert on a chat token still fails.

### Rule 3 — Every price is `unit_quote()`, including holidays

The page's quote, the request's stored price, the staff quote and the chat
tool all come from `unit_quote()`. Holidays enter through `unit_price()`,
which `unit_quote()` already calls, so nothing adds a price up anywhere else
(CLAUDE.md header, extra-guests plan). A stay's total is the **sum of its
nights' stored prices**, read back after the insert, never computed in the
browser. What the browser sends as a price is ignored because it is never
sent.

### Rule 4 — A customer sees only what they sent, and "not there" looks like "not yours"

The page never lists bookings. It reads availability (open or taken, no
names), rooms and rates (already readable by any token of the tenant), and
the calendar. `request_booking()` returns a reference, the nights and the
stored prices, and nothing about any other booking. A clash says "no longer
available", never whose booking it is.

### Rule 5 — Both walls, and no `service_role`, for everything new (CLAUDE.md rules 2 and 6)

`rate_calendar` carries `tenant_id`, a composite FK where it points at a
unit, and its own policies: any token of the tenant reads, admins write.
Every query filters on `tenant_id`. The page runs on a chat token; the
Holidays and Requests screens on staff tokens. Both isolation suites grow,
and each new check has its positive twin (trap 12).

---

## 2. The traps that will actually cost you time

### 2.1 An open write is an unauthenticated write

D-037 kept chat tools read-only because the chat route is open. The booking
page is open too, and it writes. What keeps that acceptable:

- it writes **one kind of row**: a `pending` request that holds nothing
  (§ 2.5), so the worst a stranger can do is add noise to a staff list;
- `request_booking()` validates everything a form could lie about: dates in
  the future and within `MAX_BOOKING_ADVANCE_DAYS`, nights between 1 and
  `MAX_STAY_NIGHTS`, guests within each unit's `capacity`, units active and
  this tenant's, the slot this tenant's and nightly for a stay (§ 2.2);
- **limits:** at most `MAX_OPEN_REQUESTS_PER_CONTACT` open requests per phone
  or email per tenant, checked in the function (so it holds whoever calls
  it), plus a per-IP limit in the route and a hidden honeypot field. The
  per-IP limit is **in memory**, so on Vercel it is per instance and weak
  (R-39). The per-contact limit is the real one;
- the route is wrapped in `withTenantRoute()` (CLAUDE.md rule 3), and there
  is no `requireAdmin()`: it is open by design, like chat.

### 2.2 A stay is N rows, and the gap between nights is harmless

Villa's Overnight and harbor's Night are both 14:00 + 22 h, so they end at
12:00 the next day. Two nights from 10 Oct are:

```
night 1  booked_date 10 Oct  during [10 Oct 14:00, 11 Oct 12:00)
night 2  booked_date 11 Oct  during [11 Oct 14:00, 12 Oct 12:00)
```

- `bookings_no_overlap` checks each row, so a stay that clashes on any night
  is refused **whole**: the rows go in one `insert`, one statement, and a
  `23P01` on any row saves none (booking-types § 2.5, trap 8);
- the 12:00–14:00 gap on 11 Oct could in theory be sold. No slot fits in it
  (villa's Day Tour 08:00–17:00 overlaps both nights), so it cannot. If a
  tenant ever adds a two-hour slot, a stay would need to be one range, not
  N rows. That is R-40, not a reason to build a range now;
- each night is priced **for its own date**: a Thursday–Friday stay is one
  weekday night and one weekend night, and 24–25 Dec is two holiday nights
  with the surcharge on each. That is how villa's own rate sheet reads, and
  it needs no new pricing rule (§ 8 q3 asks about a multi-night discount);
- which slot is "the night" is data: `slots.nightly boolean`, true for
  villa's Overnight and harbor's Night. A stay can only be made of a nightly
  slot. Villa's Day Tour and 22-Hour stay single-date bookings;
- the check-out time shown is `upper(during)` of the last night, in the
  tenant's timezone. It is never typed.
- **rooms × nights:** harbor, 2 rooms for 3 nights, is 6 rows in one group.
  `MAX_REQUEST_ROWS` bounds it (5 rooms × 14 nights = 70 is the ceiling).

### 2.3 A holiday is a date, not a rule

Holy Week moves every year; the Philippines declares special non-working days
by proclamation, sometimes weeks ahead; the Calamba fiesta is villa's alone.
None of it can be computed, so it is **data staff type in**:

```
rate_calendar (tenant_id, date, kind 'holiday' | 'peak', label, surcharge bigint default 0)
unit_rates.holiday_price bigint null   -- null = use weekend_price
```

`unit_price()` becomes: a date in `rate_calendar` → `holiday_price`, or
`weekend_price` when that is null; otherwise weekday/weekend as now. The
surcharge is added once per night, as a fourth part of the breakdown:

| Villa, Overnight, 24 Dec 2026 (Thursday), 32 guests | |
|---|---|
| base: holiday → weekend rate | ₱20,000 |
| peak surcharge (24 Dec) | ₱4,000 |
| extra guests: 2 × ₱250 | ₱500 |
| **night total** | **₱24,500** |

- villa's holiday rate **is** its weekend rate ("weekends and holidays"), so
  villa leaves `holiday_price` null. Harbor's documents say only "rates may
  be higher on public holidays", which is the case `holiday_price` is for;
- `bookings.surcharge` is a new stored column beside `base_price` and
  `extra_guest_price`, and `price = base + extra + surcharge`. The existing
  `bookings_breakdown_nonnegative` check grows by one term;
- a calendar change **never reprices** a request or booking already stored.
  The trigger keeps the old breakdown unless the row moves (it does so
  today), and a status change fires nothing;
- the Holidays screen has "copy last year's fixed dates" (24, 25, 31 Dec,
  1 Jan, 12 Feb), because re-typing them every year is how one gets
  forgotten. Holy Week is typed, never copied: it moves.

### 2.4 Villa's rates move from a document into the database

- **villa's unit** "Whole property" gets `standard_capacity 30`,
  `capacity 45` and `extra_person_rate ₱250`, and three `unit_rates` rows
  (Day Tour 9,500 / 12,000; Overnight 16,000 / 20,000; 22-Hour 22,000 /
  27,000), from `02-rates-and-schedules.md` and `08-faq.md`. Loaded by a
  script (`plan/customer-booking-villa-rates.mjs`), idempotent, as harbor's
  were;
- the trigger's `whole_resort` branch prices from `unit_quote()` **when the
  unit has a rate for that slot**, and stays `null` when it has none. So
  every past villa booking keeps `price null`, and a whole_resort tenant
  with no rates behaves exactly as today;
- **two sources of one price.** Villa's `02-rates-and-schedules.md` still
  states the rates, and the chat still answers from it. If staff change a
  rate on the screen and not in the document, the page and the chat
  disagree. § 8 q4: recommended, the document keeps the rates and says
  "the booking page shows the exact price for your date", and a staff
  screen note says to update both. Harbor already has this problem the
  other way round and solved it in its document (booking-types R-23);
- "children aged three and below are not counted" is not a price rule; it
  is a hint by the guest-count field, from the tenant's page settings (§ 3,
  `booking_page.guest_hint`).

### 2.5 A request does not hold the date

Villa's own words: "A date is only held once the reservation fee is paid."
So:

- `bookings_no_overlap` becomes `where (status = 'confirmed')`. Today it is
  `status <> 'cancelled'`, and there are **no** `pending` rows (checked
  2026-09-28: villa 3 confirmed and 2 cancelled, harbor 3 confirmed), so
  re-adding it cannot fail and changes nothing that exists;
- two customers can request the same night. The first one staff confirm
  wins; confirming the second fails with `23P01`, mapped to 409 "This date
  was confirmed for another booking". That is the constraint deciding, not
  a check (trap 8);
- `check_availability` and `check_room_availability` count `confirmed` only,
  to match the constraint. The chat and the page then say "open" for a date
  with requests on it, **which is true**: nobody has it yet. The page says
  "Requests are confirmed by the resort; a date is yours once they
  confirm";
- staff bookings are created `confirmed`, as now, so they hold immediately;
- the booking-type switch guard (`tenant_applications_validate`) keeps
  counting everything but cancelled, so an open request still blocks a
  type switch. That is the safe side;
- **why not hold:** a holding request is a free, anonymous, unverifiable
  way to block every date on the calendar with fake names (§ 2.7). Holding
  needs an expiry job and a verified contact, and both are in payments.md.

### 2.6 Confirming a stay confirms all of it

A request is one `group_id`. Confirm and decline are **one** `update ...
where tenant_id = $1 and group_id = $2`, one statement, so a three-night
stay cannot end up with two nights confirmed. A clash on any night refuses
the whole update. Staff see the stay as one row: "Garden Room + Loft,
10–13 Oct, 3 nights, 4 guests, ₱X", with the nights inside.

### 2.7 A phone number cannot be proven real by a form

The earlier question, answered here so the plan is honest about it: the page
checks **format** (a PH mobile, `09XXXXXXXXX` or `+639XXXXXXXXX`; an email
shape; a name of 2–100 characters) and nothing more. Proving a contact is
real needs a code sent to it (SMS OTP or an email link), which needs a
sender this project does not have (R-21; Resend is in payments.md). Until
then, staff call or message the number before confirming, which is what
villa does today with Viber. § 8 q6 asks whether email verification should
be in this plan.

### 2.8 The page is a tenant page like any other

- `/t/<slug>/book` is a Server Component that resolves the tenant (404 on a
  miss), and `requireApplication('bookings')` (404 without it). A
  `whole_resort` tenant whose unit has no rates also gets 404: a page with
  no prices is the thing this plan exists to avoid;
- it uses the tenant's theme (`lib/branding.ts`), and props, never a
  `TenantContext`, reach the Client Component;
- room photos are already public URLs (booking-types § 2.8), so the page can
  show them. R-27 (5 GB egress a month) now includes customers, not only
  staff;
- "today" is the tenant's (`localDate(timezone)`, trap 9). The date picker
  starts there, and the function checks it again.

---

## 3. The data model

`packages/db/sql/schema-customer-booking.sql`, idempotent, run after
`schema-extra-guests.sql`. Every step guarded so a re-run changes nothing
(the review-fix lesson of 2026-09-28).

```sql
-- 1. slots.nightly boolean not null default false.
--    villa 'Overnight' and harbor 'Night' set true by the load script.

-- 2. rate_calendar (tenant_id, date, kind, label, surcharge bigint not null default 0)
--    primary key (tenant_id, date); kind in ('holiday','peak'); surcharge >= 0;
--    label 1..100 chars. RLS: any token of the tenant reads; admins write.

-- 3. unit_rates.holiday_price bigint null, check >= 0.

-- 4. bookings: guest_email text, source text not null default 'staff'
--    check (source in ('staff','web')), reference text, surcharge bigint.
--    unique (tenant_id, reference). Old rows: source 'staff', reference null.
--    bookings_breakdown_nonnegative gains surcharge.

-- 5. unit_price(): the calendar, then weekend/weekday (§ 2.3).
--    unit_quote(): returns surcharge too; price = base + extra + surcharge.
--    Same signature plus one output column: the trigger, staff quote and
--    tool read it by name.

-- 6. bookings_compute_during(): whole_resort priced when a rate exists (§ 2.4);
--    surcharge stored beside the breakdown.

-- 7. bookings_no_overlap re-created: where (status = 'confirmed') (§ 2.5).
--    check_availability / check_room_availability: status = 'confirmed'.

-- 8. request_booking(p_tenant_id bigint, p_slot_id, p_unit_ids bigint[], p_guests int[],
--                    p_check_in date, p_nights int,
--                    p_name text, p_phone text, p_email text, p_notes text)
--    returns one row per unit per night: reference, date, unit, slot,
--    starts_at, ends_at, guests and the stored breakdown. The total is the
--    sum of those stored prices (Rule 3).
--    security definer, search_path = ''; p_tenant_id must equal app_tenant_id().
--    Validates (§ 2.1, § 2.2), enforces the per-contact limit, makes the
--    reference and group_id, inserts rooms × nights rows in ONE insert,
--    returns the stored prices. Granted to authenticated only.
--    A fourth definer function: D-042 amended again (D-071).

-- 9. booking_page settings: tenant_applications.config.booking_page
--    { instructions, guest_hint }, validated by a second trigger so the
--    existing one is not redefined. No `enabled`: every tenant with the
--    bookings application and a price has the page (§ 8, "every resort").
--    'instructions' is what the customer reads after sending (e.g. villa's
--    GCash steps); plain text, rendered as text, never HTML.
```

The reference is `<3 letters of the slug>-` plus 6 characters from a
30-character alphabet with no `0/O/1/I/L/8` (payments.md § 2.4), unique per
tenant, retried on collision. Several rows share one reference, so an index
cannot keep it unique; `request_booking()` does, under a per-tenant advisory
lock that also makes the per-contact limit safe under concurrency.

**Built in Phase 1, not in the first draft:** the file also guards the five
definitions it replaces in `schema-booking-types.sql` (steps 5, 7) and
`schema-extra-guests.sql` (steps 3–5), keyed on `rate_calendar` existing, so
re-running an earlier file cannot put an older price function back. And
`bookings_compute_during` gets `search_path = ''` with every name qualified:
a trigger fired from inside `request_booking()` inherits its empty
search_path. It is for people to quote on Viber. **It grants
nothing**: no page takes it.

---

## 4. Affected files

| Area | File | Change |
|---|---|---|
| SQL | `packages/db/sql/schema-customer-booking.sql` | **new**, § 3 |
| DB types | `packages/db/src/database.types.ts` | new table, columns, function |
| Checks | `packages/db/tools/verify.mjs` | `rate_calendar` RLS both ways; a chat token cannot insert into `bookings` directly; `request_booking` on a chat token makes `pending` rows only, for its own tenant, each with a positive twin |
| Domain | `packages/bookings/src/requests.ts` | **new**: `quoteRequest`, `requestBooking`, `listRequests`, `confirmRequest`, `declineRequest` |
| Domain | `packages/bookings/src/calendar.ts` | **new**: list, add, remove, copy fixed dates (staff) |
| Domain | `packages/bookings/src/bookings.ts`, `accommodations.ts` | surcharge in the breakdown; `nightly` on slots; `holiday_price` on rates |
| Constants | `packages/bookings/src/constants.ts` | `MAX_STAY_NIGHTS`, `MAX_BOOKING_ADVANCE_DAYS`, `MAX_OPEN_REQUESTS_PER_CONTACT`, `MAX_REQUEST_ROWS` |
| Routes | `apps/web/app/api/t/[tenant]/book/quote/route.ts`, `book/request/route.ts` | **new**, open, `withTenantRoute()` |
| Routes | `apps/web/app/api/t/[tenant]/admin/bookings/requests/**`, `admin/holidays/**` | **new**, `requireAdmin()` + `requireApplication()` |
| Pages | `apps/web/app/t/[tenant]/book/page.tsx` + `components/booking-page.tsx` | **new**, S-6 |
| Pages | `apps/web/app/t/[tenant]/admin/holidays/page.tsx` + `components/holidays-screen.tsx` | **new**, S-7 |
| Pages | `components/bookings-screen.tsx` | a Requests tab; stays shown as one row |
| Pages | `components/chat-screen.tsx` or `brand-header.tsx` | the "Book" button, when the page exists |
| Data | `plan/customer-booking-villa-rates.mjs` | villa's unit, rates and nightly slot; harbor's nightly slot |
| Docs | `sample-documents/04-booking-and-payment.md`, `fixtures/harbor.json` | "how to book" points at the page (§ 8 q5) |
| Checks | `packages/bookings/tools/isolation.mjs`, `rooms.mjs` | requests and the calendar across tenants; holiday and stay prices |

---

## 5. The phases

### Phase 0 — Baseline

Save `plan/baseline/*-pre-customer-booking.txt`: the battery (expect 49/51),
Northwind's snapshot, villa's and harbor's tool definitions, verify 76/76,
pipeline isolation 20/20 both ways, bookings isolation 23/23 both ways,
rooms 20/20, the test counts, and villa's and harbor's availability for the
next 14 days. **Done when** all are saved from one commit.

> **Done 2026-09-28, from `9bacea7`** on `feat/customer-booking`. Tests
> 13 / 14 / 72 / 301, typecheck green; verify 76/76; pipeline isolation
> 20/20 both ways; bookings isolation 23/23 both ways; rooms 20/20. Northwind's
> snapshot byte-identical to `northwind-prompt-pre-bookings.txt`; villa's
> tool definitions byte-identical to `villa-tools-pre-booking-types.txt`;
> villa's prompt differs from its booking-types baseline only in the
> `Today is …` line. Availability 2026-09-28..10-11: villa 42 of 42 open,
> harbor 56 of 56 (4 active rooms × 14). Battery **49/51**
> (`original 9/10 · tool 9/9 · lang 9/10 · date 9/9 · rooms 13/13`), the
> known two: `antecedent` and `lang-followup`.

### Phase 1 — Schema

Run `schema-customer-booking.sql` (the user runs it, as before), then the
load script. verify grows by the new checks. **Done when** verify passes,
a second run of the file changes nothing, villa's and harbor's availability
equal Phase 0's, and villa's **past** bookings still have `price null`.

> **Done 2026-09-28.** The user ran `schema-customer-booking.sql` (twice, as
> asked); then the load script: villa's unit 30/45 +₱250, three rates, and
> `nightly` on villa's Overnight and harbor's Night. Its read-back, 32 guests:
> Overnight ₱16,500 on a Monday and ₱20,500 on a Saturday; a second run of the
> script changes nothing. verify **92/92** (16 new, 77–92), including villa's
> 24 Dec at exactly 2000000 + 50000 + 400000 = 2450000, a 2-night request
> stored as 2 pending rows priced 1650000 and 2050000, and a confirm over a
> confirmed night refused whole (23P01). Villa's and harbor's 14-day
> availability identical to Phase 0; villa's 5 older bookings still unpriced.
> Isolation 20/20 and 23/23 both ways, rooms 20/20; Northwind's, villa's and
> harbor's prompts and villa's and harbor's tool definitions byte-identical
> to Phase 0. Tests unchanged (13 / 14 / 72 / 301), typecheck green.

### Phase 2 — `@rag/bookings`

`requests.ts`, `calendar.ts`, the surcharge, `nightly`. rooms.mjs gains:
a weekday + weekend stay; a holiday night at `holiday_price`, and at the
weekend rate when it is null; a peak night with its surcharge; villa's
24 Dec example from § 2.3 (₱24,500 exactly); a stay that clashes on its last
night refused whole; confirm of a clashing request → 409. **Done when**
rooms, isolation both ways and verify pass, and unit tests cover the
validation in `request_booking`.

### Phase 3 — Routes

Quote and request (open), Requests and Holidays (staff). An HTTP walk
script against `pnpm dev`: the six-ish cases, including a chat token
posting straight to PostgREST (refused), the per-contact limit, and a
request for another tenant's unit (refused, same answer as "not there").

### Phase 4 — Screens

S-6 the booking page, S-7 Holidays, the Requests tab, the chat's "Book"
button. **Browser walk, by the user:** villa stay over a weekend, villa
single Day Tour, villa 24 Dec, harbor two rooms two nights, a clash on
confirm, a declined request, a phone in the wrong format.

### Phase 5 — The chat, measured

Edit villa's and harbor's "how to book" documents (§ 8 q5), re-ingest them,
then the full battery. **No prompt change**, so Northwind's snapshot and
both tool definitions must be byte-identical to Phase 0. New cases: "how do
I book?" answered with the page (villa, harbor, in English and Taglish);
"book it for me" refused rather than faked. **Done when** the battery is at
its Phase 0 number plus the new cases.

### Phase 6 — Isolation and the bundle

Both isolation suites both ways, including `rate_calendar` and
`request_booking`; the bundle grep (CLAUDE.md rule 2), with `guest_email`
added to the list it greps for.

### Phase 7 — The record

D-069–D-073, R-24 closed, R-38–R-41, CLAUDE.md (header, layout, rules 6 and
8, the definer count), flow.md, status.md, whats-done.md.

---

## 6. Decisions to log

| | Decision |
|---|---|
| **D-069** | Booking moves out of the chat: a public page per tenant, the chat only explains (2026-09-28, the user). Supersedes payments.md § 2.1 while that plan is on hold |
| **D-070** | A web request is `pending` and holds nothing; only `confirmed` is in `bookings_no_overlap` (§ 2.5) |
| **D-071** | `request_booking`, a fourth `security definer` function. Amends D-042 / D-054 |
| **D-072** | Holidays are a per-tenant calendar with a surcharge, read by `unit_price()`. Reverses booking-types § 8 q2; closes R-24 |
| **D-073** | A stay is N rows of a nightly slot in one group, each priced for its own date. `whole_resort` is priced when its unit has rates. Reverses booking-types § 8 q3 |

## 7. Risks

| | Risk | Honest assessment |
|---|---|---|
| **R-38** | Fake requests with real-looking contact details | Cannot be prevented without verification (§ 2.7). Bounded: they hold nothing, and the per-contact limit caps each contact. Staff contact the guest before confirming |
| **R-39** | The per-IP limit is per server instance on Vercel | Weak by design; the per-contact limit in SQL is the one that holds. A shared limiter (a table, or Vercel's firewall) when abuse is seen |
| **R-40** | The 12:00–14:00 gap inside a stay | Unsellable today because no slot fits in it. A new short slot would make it sellable; then a stay must become one range |
| **R-41** | Villa's rates in two places (database and document) | They can drift; the chat would then quote the old one. § 8 q4 |
| **R-24** | Holiday rates not modelled | **Closed** by § 2.3, once the calendar is filled. An empty calendar prices holidays as ordinary days, exactly as today |

---

## 8. Open questions (before Phase 1)

**Answered 2026-09-28 by the user: every recommendation taken.**

1. ~~Does a request hold the date?~~ **No** (§ 2.5). Only `confirmed` is in
   `bookings_no_overlap`. Two customers may request the same night; the one
   confirmed second is refused with 409. D-070.
2. ~~Holiday rate = weekend rate?~~ **An optional `holiday_price`**, null
   by default, meaning the weekend rate (villa's rule). Harbor may set a
   higher one. D-072.
3. ~~How is a multi-night stay priced?~~ **The sum of its nights**, each
   for its own date. No multi-night discount, no minimum stay. D-073.
4. ~~Villa's rates in the document?~~ **Kept**, with a line saying the
   booking page shows the exact price for a date. R-41 stays open: staff
   update both.
5. ~~How to book, in the chat?~~ **Each tenant's "how to book" document
   names the page, and the chat screen gets a "Book" button.** No prompt or
   tool change (Rule 1).
6. ~~Email verification?~~ **Later.** It needs Resend and a public URL.
   Staff contact the guest before confirming. R-38 stays open.
7. ~~Which contact fields are required?~~ **Name, phone and email, all
   three.**
8. ~~Limits?~~ **`MAX_STAY_NIGHTS` 14, `MAX_BOOKING_ADVANCE_DAYS` 365,
   `MAX_OPEN_REQUESTS_PER_CONTACT` 3.** Policy, not measurements, so they
   live in `packages/bookings/src/constants.ts` with that said beside them.
