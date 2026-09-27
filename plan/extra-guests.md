# Extra guests plan — standard capacity, maximum capacity, a per-guest fee

> A per_room room gets a **standard capacity** (guests the base rate covers),
> a **maximum capacity** (more is refused), and an **extra-person rate** per
> guest above standard, per night. The price stays the database's: ONE SQL
> function computes base + extra, and the insert trigger, the staff quote and
> the chatbot's tool all call it, so the three cannot disagree.
>
> Written 2026-09-27 on `feat/booking-types` at `718dcd4`, before it is merged.
> **Status: agreed 2026-09-27, being built.** § 7 answered: the recommendations.
> It extends [`booking-types.md`](./booking-types.md): read that plan's § 0
> (Rule 2: the price is the database's, decided once) before this one.

---

## 1. What the request assumes, and what is here

| The request says | What the code has | What this plan does |
|---|---|---|
| "Store `maxCapacity`" | `units.capacity` already IS the maximum: the insert trigger refuses `guest_count > capacity` (23514, booking-types D-052), and the tool filters by it | Keep `capacity` as the maximum (no rename, no migration of meaning). The API and screen call it `maxCapacity` |
| "Store `standardCapacity`, `extraPersonRate`" | nothing | Two new `units` columns: `standard_capacity int`, `extra_person_rate bigint` (centavos) |
| "Standard 2, maximum 4, ₱250" | harbor's rooms hold 2, 6, 3 and 2 today; the Family Room is the only room for 5–6 (it is what `rt-guests` tests) | 2 / 4 / ₱250 are the **defaults for a new room**, not one rule for every room, because the request also says they are "configurable room properties". Existing rooms: § 7 question 1 |
| "Per night … number of nights booked" | **There are no multi-night bookings.** A booking is ONE slot on ONE date (`booked_date`, `during`); a three-night stay is three bookings | The fee is **per booking** (per slot, per date). For a Night slot that is per night. Multi-night stays as one booking are out of scope (§ 7 question 3) |
| "Validate the guest count before confirming" | `guest_count` is optional, and a null guest count skips the capacity check | For per_room, guest count becomes **required** (§ 7 question 2); without it, the extra fee cannot be computed |
| "Display base, extra, total separately" | a booking stores one `price`; the quote returns one price per room | The booking stores `base_price` and `extra_guest_price` beside `price` (the total); the quote returns all three per room |
| "The chatbot and the booking system use the same rules" | both already call SQL (`unit_price()`), not TypeScript | One new SQL function, `unit_quote()`, replaces `unit_price()` everywhere a price is made |
| whole-resort tenants | villa's own documents have exactly this rule ("₱250 per head above 30 guests"), priced from the documents by decision (booking-types § 8 q3) | **Unchanged.** Villa keeps its documents, its prompt and its tool text, byte-identical |

---

## 0. The rules

### Rule 1 — One function makes every price

`unit_quote(p_tenant_id, p_unit_id, p_slot_id, p_date, p_guests)` returns
`(base_price, extra_guests, extra_guest_price, price)`:

```
base_price        = the slot's weekday/weekend rate for that date   (unit_price() today)
extra_guests      = greatest(0, p_guests − standard_capacity)
extra_guest_price = extra_guests × extra_person_rate                (0 when the rate is null)
price             = base_price + extra_guest_price
```

The insert trigger stores all three amounts from it and overwrites anything
sent. The staff quote and the chatbot's tool call it. There is no second copy
of the arithmetic in TypeScript, so there is nothing to drift (request § 5).

### Rule 2 — More than the maximum is refused by the database

It already is (23514, "more guests than the room holds"). The screen and the
tool also filter on it, so they can say so first, but the trigger is what
refuses, whatever path the insert took.

### Rule 3 — Whole-resort tenants see no change

Villa's tool definitions and prompt stay byte-identical (diffed against
`plan/baseline/villa-*-pre-booking-types.txt`), and so does Northwind's.

---

## 2. Traps

### 2.1 Changing the defaults changes future prices, not stored ones

Giving an existing room a standard capacity of 2 and a ₱250 rate makes its
NEXT 4-guest booking ₱500 dearer. Bookings already made keep their stored
price (booking-types Rule 2); the trigger keeps a booking's old price when it
is re-saved without moving. Only a new booking, or one moved to another
room, date or slot, is repriced.

### 2.2 A guest-count change must reprice

Today a re-save that does not move the booking keeps its price. With extra
guests, changing `guest_count` from 2 to 4 must add ₱500. So the trigger's
"keep the old price" branch also requires the same guest count.

### 2.3 standard ≤ maximum

`check (standard_capacity between 1 and capacity)` when both are set. A room
with a standard of 4 and a maximum of 2 would silently never charge extra.

### 2.4 The tool must price the party, not the room

With `guests` given, a room's row shows base, extra and total for that many
guests. Without it, the row shows the base price and what it covers ("up to 2
guests, ₱250 per extra guest, up to 4"), so the model can explain the fee
without inventing a total. The instruction lines change for per_room tenants
only, so the battery is re-run (CLAUDE.md rule 1), and new `rt-*` cases
check that a quoted total equals the tool's.

---

## 3. The data model

`packages/db/sql/schema-extra-guests.sql`, idempotent, after
`schema-booking-types.sql`.

```sql
alter table units add column if not exists standard_capacity int;      -- null = no extra-guest pricing
alter table units add column if not exists extra_person_rate bigint;   -- centavos per extra guest per booking
-- checks: standard_capacity between 1 and capacity (when both set); extra_person_rate >= 0

alter table bookings add column if not exists base_price bigint;       -- null for whole_resort and old rows
alter table bookings add column if not exists extra_guest_price bigint;

-- unit_quote(p_tenant_id, p_unit_id, p_slot_id, p_date, p_guests)
--   returns table (base_price bigint, extra_guests int, extra_guest_price bigint, price bigint)
--   stable, search_path = ''. unit_price() stays, as the base_price step.

-- bookings_compute_during(): per_room → base_price, extra_guest_price, price
--   from unit_quote(); guest_count required for per_room (§ 7 q2); the
--   keep-old-price branch also needs the same guest_count (§ 2.2).

-- check_room_availability(... p_guests): rows gain standard_capacity,
--   extra_person_rate, and, when p_guests is given, extra_guest_price and total.
--   Still no guest data. Still definer, same checks (D-054).
```

New rooms get the request's defaults in `createAccommodation` (standard 2,
maximum 4, ₱250), not as column defaults, so no existing row changes by
accident.

---

## 4. Affected files

| Area | File | Change |
|---|---|---|
| SQL | `packages/db/sql/schema-extra-guests.sql` | **new**, § 3 |
| DB types | `packages/db/src/database.types.ts` | the new columns and `unit_quote` |
| Checks | `packages/db/tools/verify.mjs` | 1, 2, 3, 4, 5 guests in a 2/4/₱250 room: 3500, 3500, 3750, 4000, refused; a guest-count change reprices; a forged `base_price` is overwritten; standard > maximum refused |
| Domain | `packages/bookings/src/*` | `quote` returns base/extra/total per room; `createBookings` requires guests for per_room; accommodations get `standardCapacity`, `maxCapacity`, `extraPersonRate` with the defaults; `BookingSummary` gains the breakdown; `checkRoomAvailability` rows gain the fee fields |
| Routes | `accommodations`, `bookings/quote` schemas | the three new fields |
| Screens | `accommodations-screen.tsx`, `bookings-screen.tsx` | three inputs per room; the quote shows base, extra and total per room and for the group; each booking row shows the breakdown |
| Tool | `packages/rag/src/tools.ts` (per_room branch only) | the new row fields, a description line for the fee, instruction lines for quoting a party |
| Battery | `packages/rag/tools/prompt-eval.mjs`, `fixtures/harbor-units.json` | harbor's rooms get standard/extra values; new cases: `rt-extra` (3 guests: base + ₱250, the tool's total), `rt-over` (5 guests in a 4-guest room: refused, another room offered), `rt-standard` (2 guests: no fee) |
| Isolation | `packages/bookings/tools/isolation.mjs` | A cannot change B's standard capacity or rate |

---

## 5. The phases

1. **Schema.** The SQL file; verify's new checks; villa's availability and
   tool definitions diff clean.
   > **Done 2026-09-27.** verify 75/75 (checks 69–74 new): 1–4 guests quote
   > 350000 / 350000 / 375000 / 400000; 3 guests stored as 350000 + 25000
   > with a forged breakdown ignored; 5 refused (23514); 2 → 4 guests
   > repriced, the same count kept; no guest count refused; standard 3 above
   > a maximum of 2 refused. Villa's availability and tools identical to
   > Phase 0. One failure on the first run was my check's hard-coded "3
   > rates" (the new Quad Room made 4), not the schema.
2. **`@rag/bookings`.** Types, quote, create, accommodations; `rooms.mjs`
   grows the 1–5 guest cases through the package.
   > **Done 2026-09-28.** `rooms.mjs` 19/19 (4 new): a room created with only
   > a name gets standard 2, maximum 4, ₱250; the quote for 1–4 guests is
   > 350000 / 350000 / 375000 / 400000 and 5 is refused before booking ("Quad
   > holds at most 4 guests."); 3 guests stored and listed as 350000 + 25000;
   > no guest count is a 400 while another tenant's room, also without one,
   > still says "No such unit or slot.". **Deviations:** the maximum keeps its
   > column name, `capacity`, and `maxCapacity` is accepted as input for it;
   > the guest count is NOT pre-checked in TypeScript, because the trigger
   > checks the unit first, and a pre-check would make "not yours" and "no
   > count" say different things. Four older scripts now send a guest count.
3. **Routes and screens.** The walk script grows the forged-price and
   over-capacity cases; the screens show the breakdown.
   > **Done 2026-09-28 (routes and screen code; the browser look is part of
   > the owed walk).** Walk 11/11 against dev: a room posted with only a name
   > is 201 with 2 / 4 / 25000; a 3-guest quote is 350000 + 25000 = 375000;
   > 5 guests in a 4-guest room is a 400 at the quote ("Quad holds at most 4
   > guests.") and at the booking; no guest count and a standard of 5 over a
   > maximum of 4 are 400s. The Rooms screen has Included / Max guests / Per
   > extra guest; the booking form's quote shows each room's rate, extra
   > guests and total, then the total; Book waits for every room's guest
   > count; a booking row shows "base + extra guests = total".
4. **The tool, then measure.** Full battery: the original 48 unchanged
   (46/48 expected, 47 when `lang-followup` passes), plus the new `rt-*`;
   villa and Northwind diff clean.
   > **Done 2026-09-28.** Harbor's rooms got standard 2 and ₱250 through the
   > fixture (maximums unchanged). The per_room tool rows carry
   > `included_guests` and `extra_guest_fee`, and with a guest count
   > `extra_guest_charge` and `total`, all from unit_quote(); two instruction
   > lines say to quote that total and never add one up. Full battery
   > **49/51**: the original 48 at 46/48 as expected, `rooms 13/13`, and 13/13
   > on two more runs. Villa's and Northwind's prompts and villa's tools
   > identical. **Found and fixed:** `rt-tagalog` fell to 1 pass in 7 after the
   > new lines. Cause: `dates.ts` knew "bakante" but not "bakanteng" (the
   > Tagalog linker), so the up-front check (D-046) never ran for "May
   > bakanteng kwarto…". Fixed in `dates.ts` with a test; that file is prompt
   > text, so the whole battery was re-run (the 49/51 above).
5. **Isolation and the record.** Both walls; D-065–D-068, R-36–R-37
   (D-057–D-064 and R-31–R-35 are reserved by `plan/payments.md`).

It is small enough to finish on `feat/booking-types` before the merge, so the
owed Phase 4 browser walk covers it too.

---

## 6. Decisions and risks

| | | |
|---|---|---|
| **D-065** | `capacity` stays the maximum; `standard_capacity` and `extra_person_rate` are new, per room | No rename; the existing capacity checks keep working |
| **D-066** | `unit_quote()` is the only price arithmetic; the trigger, quote and tool call it | The request's § 5, by construction |
| **D-067** | The fee is per booking (per slot, per date); one booking is one night | There is no multi-night booking to multiply |
| **D-068** | The breakdown is stored on the booking | Display shows what was charged, even after a rate or fee edit |
| **R-36** | Backfilling existing rooms raises their future prices for 3+ guests | § 2.1; the user decides (§ 7 q1) |
| **R-37** | The model quotes a party total it computed itself | The tool gives the total when it knows the guests; `rt-extra` compares the reply with it |

---

## 7. Questions before Phase 1

**Answered 2026-09-27 by the user: all three recommendations.**
- **1:** harbor's rooms get standard 2 and ₱250 each; their maximums stay
  (Garden 2, Family 6, Loft 3, Sea View 2). Done through
  `fixtures/harbor-units.json` and its loader, not the schema, which knows
  no tenant. New rooms default to 2 / 4 / ₱250.
- **2:** guest count is REQUIRED for a per_room booking, in the database.
- **3:** one booking is one night; no multi-night booking here.

1. **Existing rooms.** Harbor's Garden Room (max 2), Family Room (max 6), Loft
   (max 3) and Sea View Suite (max 2) exist. Should they get standard 2 and
   ₱250 now, keep their maximums, or all be set to maximum 4? Recommended:
   standard 2 and ₱250 for each, **maximums unchanged**, so the Family Room
   still takes a family of 5–6.
2. **Guest count required.** For a per_room booking, may staff leave the
   guest count empty (priced as the standard number of guests), or must they
   enter it? Recommended: **required**, because the price depends on it.
3. **Multi-night stays.** Is "per night × nights" meant for one booking
   covering several nights? Today that is several one-night bookings, each
   charged its own fee, which gives the same total. Recommended: keep it that
   way here; a real multi-night booking is its own plan.
