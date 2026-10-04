# Promos plan: discounts a tenant defines, applied by the ONE price function

> A tenant's owners and admins define **promos** on a new screen: a name
> ("Off season discount"), a type (fixed amount or percentage), a value, a
> validity range, an optional **code** the customer must type, and an
> optional **usage limit** ("only 10 customers can avail"). A valid promo
> takes its discount off the price of a booking, on the public booking page
> and on the staff screen, and the amount is computed and stored by the
> database, in the same place every other price is: `unit_quote()` for the
> night, `request_booking()` for the stay. Nothing adds up a discount in
> TypeScript, and a code is never readable by a customer.
>
> Written 2026-10-04, against `b6c81b6` on `master`. **Status: in progress,
> Phase 0 started 2026-10-04** on `feat/promos`. § 7's five questions were
> answered 2026-10-04: every recommendation taken, by the user's instruction.
>
> Read [§ 0](#0-the-five-rules) first. Rule 1 is booking-types' Rule 2 again,
> applied to a discount: the price is the database's, decided once.

---

## What this plan covers

| | |
|---|---|
| **In scope** | A `promos` table and its RLS (staff read and write; a customer reaches a promo only through one definer function); `bookings.promo_id` and `bookings.discount` so a booking records what it got; the discount computed in SQL for the stay and stored per row; a usage limit counted in SQL under the tenant's advisory lock; a Promos screen at `/t/<slug>/admin/promos` (owners and admins) with the usage count on every promo; a promo code field and a discount line on the customer booking page's quote and receipt; a promo picker on the staff booking form; `promos:read` / `promos:write` in the permission table and the header nav; verify, rooms and isolation checks; the record |
| **Out of scope** | Per-room or per-slot promos (every promo is tenant-wide; § 7 q4); stacking two promos on one stay (one promo per request, § 7 q3); the chatbot knowing promos (no prompt text and no tool changes, Rule 5; a tenant may describe a promo in its documents and the chat will answer from them); a customer-facing "available promos" list (a code is secret; an automatic promo shows itself in the quote); first-come guarantees across tenants' clocks beyond the advisory lock; refunds or re-pricing a confirmed booking when a promo is edited (Rule 4) |

---

## 1. What the request assumes, and what is actually here

| The request says | What the code has | Consequence |
|---|---|---|
| "discount type is [fixed amount, percentage], discount value based on type" | Money is bigint **centavos** everywhere, text once for a person (`lib/money.ts`, `money()` in `tools.ts`); no float arithmetic | `kind in ('fixed', 'percent')`; `value` is centavos for fixed, hundredths of a percent for percent (`1250` = 12.50 %), so both are integers and the SQL never multiplies a float. The screen types "12.5" and `lib/money.ts`-style string parsing turns it into `1250` (§ 2.1) |
| "validity date range" | A stay is N nights, one `bookings` row per night with its own `booked_date`; `rate_calendar` already decides a surcharge per DATE | The range applies to the STAY DATES: every night of the request must fall inside `valid_from..valid_to`, or the promo does not apply at all (§ 7 q1). Not to the day the request was made |
| "requires promo code?" | The public booking page runs on the CHAT token; `tenants` is unreadable to it except through `tenant_public()`, because the column list is the boundary (D-042) | The same shape: `promos` has NO select policy for a chat token. The page sends the code to the quote route, and ONE `security definer` function, `promo_for_request(p_tenant_id, p_code, p_from, p_to)`, answers with the promo's public fields or nothing; a code that exists at another tenant is "nothing". A promo with no code is **automatic**: the function returns it when no code is typed and it is valid |
| "limit of usage, e.g. max of 10. only 10 customers can avail" | "Check, then insert" double-books (trap 8); `request_booking()` already takes `pg_advisory_xact_lock('request_booking:<tenant>')` for the whole insert | The usage count is `count(distinct group_id)` of pending or confirmed bookings with that `promo_id`, counted INSIDE `request_booking()` under that lock, and the 11th request is refused in words (`promo_exhausted`). A cancelled or declined request gives its use back (§ 2.3) |
| "discount/promo management page" | Owners and admins already manage rooms, holidays and slots on screens gated by `requireAdmin(request, tenant, permission)` from the ONE table in `lib/permissions.ts`, with Postgres asking the same role (D-079); a slot ever booked is RETIRED, not deleted (D-090) | `promos:read` / `promos:write` for ADMIN (owners inherit), a screen at `/t/<slug>/admin/promos`, policies on `promos` that ask `app_is_admin()`; a promo ever used is retired (`active = false`), never deleted, because bookings point at it |
| the price of a booking | ONE function, `unit_quote()`, returns `(base_price, extra_guests, extra_guest_price, surcharge, price)` per night; the insert trigger stores its parts; `request_booking()` stores every night's parts; a receipt's total is the sum of what was STORED (customer-booking Rule 3) | `unit_quote()` is unchanged. A new function, `promo_discount(p_tenant_id, p_promo_id, p_price)`, gives one night's discount, and both writers call it and store `discount` beside the other parts; `price` becomes `base + extra + surcharge − discount`, never negative (§ 4) |

---

## 0. The five rules

### Rule 1 — The discount is the database's, decided once

`promo_discount()` is the only arithmetic. The trigger (`bookings_compute_during`)
calls it on a staff insert that names a `promo_id`; `request_booking()`
calls it for every night of a customer's stay; `quote()` and
`quoteRequest()` call it the same way for the preview. No TypeScript
multiplies or subtracts a discount, and a screen never adds one up. A
receipt shows what was stored.

### Rule 2 — A customer never reads a code and never names a promo id

`promos` has select, insert, update and delete policies for `app_is_admin()`
only. A chat token sees nothing in the table. The customer's only door is
`promo_for_request()`, `security definer` with `search_path = ''`, which
takes the tenant id FROM THE ROUTE (wall 1), refuses one that is not the
token's (wall 2, the `request_booking()` pattern), and returns the public
fields (name, kind, value) of ONE promo: the one whose code matches
(case-insensitive, trimmed), or the automatic one when no code was typed.
`request_booking()` takes `p_promo_code text`, not an id, and resolves it
itself. The model never sees a promo either (Rule 5).

### Rule 3 — The usage limit holds under the lock, not in a check-then-insert

`request_booking()` already serialises a tenant's requests with an advisory
lock. The count of uses is taken inside that lock, after the lock, before
the insert, and the refusal is a `raise exception` with `errcode
'check_violation'` and a message in words, mapped to a 409 by
`@rag/bookings` like the overlap. A staff insert goes through the same
count in the trigger, under the same lock (the trigger takes it, as
`closed_days` does). "10 customers" means 10 distinct `group_id`s, pending
or confirmed; a cancelled or declined one no longer counts.

### Rule 4 — A stored discount never changes

Editing a promo's value, range or limit changes FUTURE quotes only. A
booking keeps `promo_id` and `discount` as stored, the booking-types rule
("a booking stores its price when made"). The trigger's "keep the old
price" branch keeps `discount` with the rest. Retiring a promo stops new
uses; the bookings that used it are unchanged and still show its name.

### Rule 5 — The chatbot does not change

No prompt text, no tool definition, no tool result field. The battery's
three baselines stay byte-identical, and the 61 cases are run once at the
end only because `@rag/bookings` is shared. If a tenant wants the chat to
mention a promo, it writes it into a document, and the chat answers from
the document as it answers everything else.

---

## 2. Traps

### 2.1 Floats in a percentage

`12.5 %` of `₱16,000.00` is `₱2,000.00`; `0.125 * 1600000` in JavaScript
is `200000.00000000003`. The value is stored as hundredths of a percent
(`1250`), the discount is `(p_price * value) / 10000` in bigint, rounded
to the centavo in SQL (`round()` on a numeric, then `::bigint`), and
TypeScript only ever formats what SQL returned. The screen's input is
parsed like money: by string, never `* 100`.

### 2.2 A fixed amount on a multi-night stay

A fixed `₱1,000.00` off a three-night stay is `₱1,000.00` off the STAY,
not off each night, and not spread. It is stored on the FIRST night's row
(`discount = 1000.00`, the other nights `0`), so `sum(price)` over the
group is right and no row is negative: `promo_discount()` caps a night's
discount at that night's price. A percentage applies to every night.

### 2.3 Counting uses, and giving them back

A use is a request, not a night and not a room: `count(distinct group_id)`
where `promo_id = p and status in ('pending', 'confirmed')`. A declined
request frees its use the moment it is declined; so does a cancelled
booking. This is counted, never stored, so it cannot drift (the same
reason `unit_quote()` is a function and not a column).

### 2.4 "Valid until" is a date, inclusive

`valid_to` is the last stay date the promo covers, inclusive, in the
tenant's calendar. A 3-night stay checking in on the last valid day is NOT
covered: its second and third nights fall outside. The quote says so in
words ("the promo covers stays ending by 30 September") instead of
applying it to one night.

### 2.5 An automatic promo must not surprise staff

A promo with no code applies by itself to every eligible request. The
Promos screen says so on the row ("automatic"), and the staff booking form
shows the automatic promo pre-selected, with "none" one click away.
Two automatic promos valid on the same date would be ambiguous: the
function takes the one with the larger discount for THIS stay, and the
screen warns when two automatic promos overlap in time (§ 7 q3).

### 2.6 A code is the customer's secret and the tenant's

Codes are unique per tenant, case-insensitive (`unique (tenant_id,
lower(code))`). Another tenant may use the same word. The quote route
answers "no such promo" for a wrong code and for another tenant's code in
the same words, so a code cannot be probed across tenants. The per-IP
window on `book/request` (R-39) already slows a guessing loop; the quote
route gets the same window.

### 2.7 The eval seeds bookings with no promo

The battery's fixtures, the isolation suite and the rooms suite insert
bookings through `createBookings()` with no `promoId`, so their prices
are unchanged. `rooms.mjs` gets its own promo checks on the probe tenant,
and it must delete the probe's promos with the tenant (cascade).

---

## 3. The data model

`packages/db/sql/schema-promos.sql`, idempotent, after
`schema-decision-note.sql` (the 18th file).

```sql
create table if not exists promos (
  id          bigint generated always as identity primary key,
  tenant_id   bigint not null references tenants(id) on delete cascade,
  name        text   not null,                              -- "Off season discount"
  kind        text   not null,                              -- 'fixed' | 'percent'
  value       bigint not null,                              -- centavos, or hundredths of a percent
  valid_from  date   not null,
  valid_to    date   not null,
  code        text,                                         -- null = automatic
  max_uses    int,                                          -- null = unlimited
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint promos_kind        check (kind in ('fixed', 'percent')),
  constraint promos_value       check (value > 0 and (kind <> 'percent' or value <= 10000)),
  constraint promos_range       check (valid_to >= valid_from),
  constraint promos_max_uses    check (max_uses is null or max_uses > 0),
  constraint promos_code_shape  check (code is null or code ~ '^[A-Za-z0-9_-]{3,32}$'),
  constraint promos_name_length check (char_length(name) between 1 and 80)
);
create unique index if not exists promos_code_per_tenant on promos (tenant_id, lower(code)) where code is not null;

alter table bookings add column if not exists promo_id bigint references promos(id);
alter table bookings add column if not exists discount bigint;              -- centavos, part of price; null for old rows
-- bookings_promo_tenant: promo_id's tenant must be the booking's (a trigger, like the unit/slot checks)

-- promo_discount(p_tenant_id, p_promo_id, p_price, p_first_night boolean) returns bigint
--   fixed: least(value, p_price) on the first night, 0 after; percent: round(p_price * value / 10000)
-- promo_for_request(p_tenant_id, p_code, p_from, p_to)  security definer, search_path = ''
--   returns table (id, name, kind, value) — one row or none; checks the caller's tenant claim
-- promo_uses(p_tenant_id, p_promo_id) returns int — count(distinct group_id), pending or confirmed
-- request_booking(..., p_promo_code text default null): resolves the code under the lock,
--   checks uses < max_uses, stores promo_id and discount on every night, price net of it
-- bookings_compute_during: with new.promo_id, discount from promo_discount(); price net of it;
--   the keep-old-price branch keeps discount too
-- RLS: promos_select/insert/update/delete for app_is_admin() on the tenant; NO chat-token select
```

The `Database` type in `packages/db/src/database.types.ts` gains the table
and the two columns; `Insert` for `discount` is `never` (the trigger
writes it), `promo_id` is a plain column.

---

## 4. The price, in one place, with a discount in it

For one night at `(unit, slot, date, guests)`:

```
base_price        unit_quote()           as today
extra_guest_price unit_quote()           as today
surcharge         unit_quote()           as today
subtotal          base + extra + surcharge
discount          promo_discount(promo, subtotal, first_night)   0 with no promo
price             subtotal − discount                              ≥ 0 by construction
```

`request_booking()` applies it night by night in date order, so "first
night" is well defined; the receipt's total is `sum(price)` of the stored
rows, as it is today. `quoteRequest()` returns the same lines plus
`promo: { name, kind, value } | null` and the sum of discounts, so the page
can show "Off season discount −₱2,000.00" under the lines, from the same
function the request will use.

---

## 5. Phases

### Phase 0 — Baseline

Every suite on `b6c81b6` (after the two owed SQL files are in): verify,
rooms, both isolation suites both ways, tests, typecheck; the three
prompt baselines diffed; the battery once. The counts to hold.

### Phase 1 — Schema

`schema-promos.sql` as § 3, with the `request_booking()` change guarded on
`to_regclass('public.promos')` so an older file re-run cannot put the old
function back (trap 20). verify gains: a chat token selects 0 promos and
cannot insert one; an admin token inserts, updates, retires; the code
index refuses a duplicate per tenant and allows the same code at another
tenant; `promo_for_request()` answers another tenant's code with nothing.
`plan/promos-phase1-shapes.mjs` dry-runs the constraints.

### Phase 2 — `@rag/bookings`

`promos.ts`: `listPromos` (with `uses` from `promo_uses()`), `createPromo`,
`updatePromo`, `retirePromo`, `deletePromo` (unused only; refused in words
when a booking points at it). `quoteRequest()` and `requestBooking()` take
`promoCode`; `quote()` and `createBookings()` take `promoId` (staff);
`BookingSummary`, `RequestQuote`, `RequestReceipt`, `RequestLine` carry
`promo` and `discount`. `rooms.mjs` checks: a percent and a fixed promo
quoted and stored to the centavo; the fixed amount on the first night
only; a wrong code and another tenant's code are "no such promo"; the
11th request is refused and a declined one gives its use back; a retired
promo is refused; an edited value leaves a stored booking alone.

### Phase 3 — Routes and permissions

`promos:read` / `promos:write` in `lib/permissions.ts` (ADMIN);
`app/api/t/[tenant]/promos/route.ts` and `/[id]/route.ts` on
`withTenantRoute()` + `requireAdmin(…, 'promos:write')`; `book/quote` and
`book/request` accept `promoCode` (zod, the code shape) and keep their
limits; `bookings/quote` and `bookings` (POST) accept `promoId`. The error
map gains nothing: `promo_exhausted` and "no such promo" are the existing
409 and 400.

### Phase 4 — Screens

`/t/<slug>/admin/promos` (`promos-screen.tsx`): the list with name, kind
and value, range, code or "automatic", uses / limit, active; a form to
add or edit; Retire; Delete only when unused. `nav-items.ts` gains Promos
for `promos:read`. The booking page: a "Promo code" field beside the
guests, a discount line and the promo's name on the quote and the
receipt, and the words of § 2.4 when the dates miss the range. The staff
form: a promo picker (automatic one pre-selected).

### Phase 5 — The walls and the walk

Bookings isolation: A cannot list, edit, retire or quote with B's promo;
B's code at A is nothing. Both ways. verify, rooms, the battery once
(Rule 5: unchanged count, three baselines byte-identical). The walk, by
the user: create a percent promo and a coded fixed promo; book on the
page with the code and see the line and the receipt; hit the limit; retire.

### Phase 6 — The record

D-097, CLAUDE.md (the header paragraph, the layout lines, the sql count),
flow.md § 5, status, whats-done.

---

## 6. What must not change

- `unit_quote()`'s signature and every amount it returns; the three
  prompt baselines; the battery count; no tool text, no prompt text.
- Every booking made before this plan: `promo_id null`, `discount null`,
  `price` as it was.
- A chat token still reads `promos` not at all; `tenants` still only
  through `tenant_public()`.
- "Not yours" and "not there" still one answer, for promos and for codes.

---

## 7. Questions, each with a recommendation · **answered 2026-10-04, every recommendation taken**

1. **Validity: stay dates or booking date?** "Off season discount" means
   the stay; "early bird" would mean the booking date. **Recommend stay
   dates** (every night inside the range), and if an early-bird promo is
   wanted later, a second column `book_by date` is a small addition.
2. **Does a staff booking count against the limit?** A staff member
   applying a promo on the phone is still a customer availing it.
   **Recommend yes**: one count, `promo_uses()`, for both doors.
3. **One promo per stay, and which automatic one?** **Recommend one**: a
   typed code wins over an automatic promo; with two automatic promos
   valid, the larger discount for this stay wins, and the screen warns on
   overlapping automatic promos so a tenant notices.
4. **Tenant-wide only?** Per-room or per-slot promos double the form and
   the function. **Recommend tenant-wide for v1**; a `unit_id` nullable
   column later is the natural extension.
5. **Round a percentage to the centavo how?** **Recommend round half up**
   (`round()` in Postgres on numeric), the way a receipt is read, and
   write it in the function's comment so nobody "fixes" it to floor.
