# Room types plan: a room type has several rooms, and the chat and the booking page know how many are left

> A per_room tenant sells room TYPES, and a type can have several
> physical rooms: alteza has 2 Casa Uno and 3 Loft Suite. Today one
> `units` row is one physical room. `bookings_no_overlap` refuses a second
> confirmed booking on it, so once one Casa Uno is booked on 1 December,
> the chatbot and the booking page say "taken", although a second Casa Uno
> is free. The only workaround is a row per physical room (alteza's
> "Kubo A" and "Kubo B"), which lists the same type twice to the guest.
> The user: "casa uno was book dec 1. so in chatbot and booking page casa
> uno still available for 1 more booking. but the chatbot and booking
> dosnt know how many casa uno are available."
>
> Written 2026-10-16, against `ac6179e` on `master`. **Status: Phase 0
> started 2026-10-16 on `feat/room-types`.** § 7's four questions were
> answered 2026-10-16: every recommendation taken. The user chose three
> things on 2026-10-16:
> - **room types over physical rooms**, not a quantity column (the
>   double-booking guarantee stays per physical room);
> - **the system assigns a free room and staff can move a booking**;
> - **this plan first**, reviewed before any code.
>
>
> Read [§ 0](#0-the-five-rules) first.

---

## What this plan covers

| | |
|---|---|
| **In scope** | A new table of physical rooms under a unit, `unit_rooms`, and `bookings.room_id`. `bookings_no_overlap` moves from `unit_id` to `room_id`. ONE assigning trigger gives every booking row a free room of its unit when the insert names none, at every door: the booking page, staff, `decide_change()`'s reschedule and the tools. Confirming a pending row whose room has since been taken moves it to another free room of the same unit before it gives up with a 409. Every availability read counts rooms: `taken` means no room of that unit is free, and the rows carry `rooms_free` and `rooms_total`. On the booking page a guest asks for a type up to its free count ("Casa Uno ×2"), through the same `request_booking()` signature. S-5 gains a type's rooms (add, rename, retire), S-15 a "Move to room" action. The calendar shows counts and the dashboard's occupancy uses rooms. The record is D-133 |
| **Out of scope** | Prices, quotes, holidays, promos and photos: they stay per UNIT (= the type), so `unit_price()`, `unit_quote()`, `promo_discount()` and `unit_images` do not change. Whole-resort tenants: one unit, one room, a trigger keeps it so. Merging alteza's Kubo A and Kubo B into one type, which is the owner's call (§ 7 q1). The tool's DEFINITION text: no prompt text and no tool text change, and the three baselines stay byte-identical (Rule 5). A guest choosing a specific room number |

### What the user asked, and what the plan does with it

| The user's words | What exists today | What the plan does |
|---|---|---|
| "2 casa uno, 3 Loft Suite" | One `units` row is one room. Two Casa Uno means two rows with two names, two rate cards and two photo sets | `Casa Uno` stays ONE unit: one rate card, one set of photos, one entry in the guest's list. Under it, `unit_rooms` holds "Casa Uno 1" and "Casa Uno 2" |
| "casa uno was book dec 1 … still available for 1 more" | `check_availability` says `taken` for Casa Uno on 1 December | It says `available`, with `rooms_free 1` of `rooms_total 2`. The second booking is given "Casa Uno 2" |
| "the chatbot and booking dosnt know how many" | No read anywhere carries a count | The tool result says "1 of 2 left" (only when a type has more than one room). The booking page offers up to the free count |
| "the room quantity only visible on admin" | There is no quantity anywhere, admin included (checked on the live rows 2026-10-16) | S-5 shows each type's rooms. The quantity is how many active rooms the type has, never a number typed separately (Rule 2) |

---

## 0. The five rules

### Rule 1 — Postgres refuses a double booking per PHYSICAL room, and nothing else does

`bookings_no_overlap` becomes `exclude (room_id =, during &&) where
(status = 'confirmed' or held)`. It is the same guarantee, one level down.
Nothing in code counts rooms and then inserts (trap 8):
- the assigning trigger PICKS a room under a lock;
- the constraint is still what refuses a loser.

`bookings_pending_not_taken` and `request_booking()`'s own check change
from "this unit has a taking row" to "every active room of this unit has
a taking row". A pending row still holds nothing (D-070).

### Rule 2 — The unit is the type; the count is rows, never a number

Everything a guest sees about a room stays on `units`: its name,
capacity, rates, photos and promos. That is why no price changes.

`unit_rooms` holds only the physical rooms:
- `id`, `tenant_id`, `unit_id`, `name`, `active`, `sort_order`;
- unique `(unit_id, name)`;
- a composite foreign key, so a room belongs to its unit's tenant.

The count is how many active rows there are, never a `quantity` column
that could disagree with the rows. Each existing unit gets one room named
like the unit (the backfill), so every tenant behaves exactly as today
until staff add a second room.

### Rule 3 — One assigner, in SQL, at every door

`bookings_assign_room()` is a BEFORE INSERT trigger. When `new.room_id`
is null, it takes `pg_advisory_xact_lock` on (tenant, unit) and then
picks, in this order:
1. a room the same `group_id` used for this unit on the previous night
   and does not already use on THIS night, so a stay keeps one room, and
   a stay of two Casa Uno keeps its two (§ 2.2). Cancelled rows do not
   count, because `decide_change()` re-inserts into the group it has just
   cancelled;
2. the first active room by `sort_order` with no TAKING row on that span;
3. among those, one with no PENDING row on the span, so two requests do
   not pile onto one room while another sits empty.

A pending row whose unit has no free room at all is refused, as today.
A room named by the caller (a move, the tools) is checked to belong to
`new.unit_id` by the foreign key.

The same function picks the new room when Confirm finds the assigned
room taken. That is a BEFORE UPDATE trigger on `pending → confirmed`, so
the 409 now means "every room of this type is taken", not "this one
is".

### Rule 4 — A move changes the room, never the price or the type

Staff move a booking with `PATCH …/bookings/[id]/room { roomId }`, on
`bookings:write`, the permission Confirm uses:
- the new room must be one of the SAME unit's (the composite foreign
  key);
- the constraint refuses a taken one with `23P01`, in words;
- `bookings_compute_during` keeps the stored price, because `unit_id`,
  `slot_id`, `booked_date`, `guest_count` and `promo_id` are unchanged
  (`schema-promos.sql`'s keep-price branch). rooms asserts the price
  does not move.

A move of a whole stay moves every night of the group in one statement.
`bookings_pending_not_taken` also fires on UPDATE OF `room_id`, so a
pending row cannot be moved onto a confirmed room (today it is INSERT
only). The move is a `booking_events` row (`room_moved`) with the note
D-096 requires.

### Rule 5 — The chatbot learns a count in the RESULT, not in its text

The tool's definition, its room list and its instruction lines do not
change, so harbor's, villa's and northwind's baselines stay
byte-identical. The precedent is `closedNote()`: in D-080, a word in the
description moved `rt-leak-2` from 3 of 4 to 0 of 6.

The result row gains `left: "1 of 2"`, field by field (Rule 7 of
CLAUDE.md). It is added only when the type has more than one active
room, so a one-room tenant's results are unchanged. The battery runs
anyway, because the result reaches the prompt.

---

## 1. What changes, by layer

| Layer | Change |
|---|---|
| SQL (`schema-room-inventory.sql`, the 37th file) | `unit_rooms` with its policies: any token reads, `rooms:write` writes, `_may_`/`_can_` twins (D-128). Backfill one room per unit; `bookings.room_id` filled from it, then `not null`, with FK `(room_id, unit_id, tenant_id)`. Swap `bookings_no_overlap` to `room_id`. Add `bookings_assign_room` (insert) and the confirm re-pick (update). `bookings_pending_not_taken` and `stay_taken()` count rooms. `request_booking()` allows a unit listed several times, up to its free rooms, and drops the "listed twice" refusal; the signature and `request_booking_with_consent()` are unchanged. `check_availability` and `check_room_availability` gain `rooms_free` and `rooms_total`, and `taken` means 0 free. `calendar_*` carry counts; `tenant_dashboard` occupancy uses active rooms. Two more triggers: a whole-resort unit keeps one active room, and a room with an upcoming booking cannot be retired; an ever-booked room is retired, never deleted (the D-090 pattern) |
| `@rag/bookings` | `rooms.ts` (new): list, add, rename, retire, delete-unused for a unit's rooms. `moveBooking()`. `validate.ts` drops the distinct-unit check in `parseRooms` / `parseRequest` and caps each unit at its rooms instead. `priceStay()` and `clashes()` read the count, not a name match. `stayDetail()` carries the room per night. `takenMessage()` carries the new words |
| `@rag/pipeline` | `tools.ts`'s executor maps `left` when `rooms_total > 1`. No definition text changes |
| apps/web | S-5: a type's "Rooms" list (add, rename, retire). S-15: the room per night and "Move to room" (a select of the same type's rooms that are free for the whole stay). Booking page: a count stepper per type, up to the free count, guests per room. Staff New booking: the same stepper. Calendar: "1 of 2 booked" per type. The route `bookings/[id]/room` |
| Not touched | Prices, quotes, promos, photos, holidays, the prompt, the tool text, Manage booking (the guest sees the type, not the room number, § 7 q4) |

---

## 2. Traps

### 2.1 Swapping the constraint is one transaction

A moment with no constraint lets a double booking in. The drop, the
`not null` and the add run in ONE transaction in the file, after the
backfill. Before the swap, the file asserts that no two taking rows share
a room and a span, or it raises. With one room per unit, that is the old
constraint's own truth.

### 2.2 Which rows of the same statement a trigger sees

A stay is ONE multi-row insert, a row per night. To keep a stay in one
room, the assigner looks for the room that earlier rows of the same
`group_id` took. **Phase 0 spikes it:** does a BEFORE ROW trigger's
query see the rows inserted earlier in the same `INSERT … VALUES` /
`insert … select`? If it does not, `request_booking()` and
`createStaffStay()` pick ONE room for the whole stay first (the same
function, called with the stay's span) and pass it on every row.

### 2.3 Trigger order is name order

The assigner needs `during` (from `bookings_compute_during`) and
`group_id` (from the reference trigger). Phase 0 lists the BEFORE INSERT
triggers on `bookings` by name, and the new one is named to sort after
both. rooms asserts on a real insert, never on a row with `during` set by
hand (staff-clash § 2.2, trap 12).

### 2.4 An older file can put an old constraint back (trap 25)

`schema-holds.sql` and `schema-customer-booking.sql` re-create
`bookings_no_overlap` on `unit_id`. Their steps are guarded on
`to_regclass('public.unit_rooms')`, so a re-run leaves the new
constraint, the way trap 20 guards older functions.

### 2.5 "Taken" in tests means "the one room is taken"

rooms.mjs asserts `'Garden Room taken, Family Room taken'`, and the
`rt-*` cases match unit names. With one room per unit, both still hold,
which is Phase 2's baseline proof. New checks add a SECOND room and
assert `available` with 1 of 2, then `taken` at 2 of 2.

### 2.6 A count is something a competitor can read

`rooms_free` tells anyone who asks how full the resort is. The booking
page already reveals "taken" per night, so the step is small; it is
recorded as R-52 and § 7 q3 asks whether to show it.

---

## 3. Phases

### Phase 0 — Baseline and the two spikes
On `feat/room-types`, record the baseline:
- rooms 50;
- bookings isolation 40, both ways;
- pipeline isolation 24, both ways;
- verify 211;
- the unit tests;
- the three prompt baselines diffed.

Then run the two spikes:
- the same-statement visibility (§ 2.2), in a rolled-back transaction;
- the trigger names (§ 2.3).

### Phase 1 — SQL
`schema-room-inventory.sql`, run by the user. verify gains these checks:
- `unit_rooms` RLS: a token of another tenant reads 0 rows, plus its
  positive twin;
- `rooms:write`, with an override taking it away;
- the backfill: every unit has exactly one room, and every booking a
  room;
- the constraint on `room_id`;
- the whole-resort one-room trigger;
- retire versus delete.

### Phase 2 — Assignment and availability
rooms gains these checks:
- a type with 2 rooms takes two confirmed bookings on one night, and a
  third is refused `23P01`;
- availability reads 2/2, then 1/2, then 0/2 `taken`;
- a 3-night stay lands in ONE room;
- a pending row on a full type is refused, and a pending row on a free
  room is allowed;
- Confirm re-picks when the assigned room was taken meanwhile;
- `request_booking()` with Casa Uno twice books 2 rooms, and three times
  is refused when only 2 are free;
- a reschedule (`decide_change`) gets a room.

Every existing check stays green unchanged (§ 2.5).

### Phase 3 — Move
`moveBooking()` and the route. rooms checks four things:
- the price is unchanged;
- another unit's room is refused;
- a taken room is refused in words;
- a pending row cannot be moved onto a confirmed room.

The event row is written with its note.

### Phase 4 — Staff screens
- S-5: the Rooms list.
- S-15: the room per night, and Move.
- New booking: the stepper.
- Calendar: counts.
- Dashboard: occupancy by rooms.

`plan/ui-refresh-a11y.mjs` stays at 0 violations.

### Phase 5 — The booking page and the chatbot
- The booking page's stepper, capped by the quote's free count.
- The tool result's `left`.
- The three baselines, byte-identical.
- `pnpm eval` (expect the known 59/61 set), plus two new `rt-*` cases on
  harbor. Harbor gains a second room on one type in
  `fixtures/harbor-units.json` (`rooms: ["Garden Room 1",
  "Garden Room 2"]`):
  - `rt-count`: one of two booked, the reply says available;
  - `rt-count-full`: both booked, the reply says taken.

### Phase 6 — The walls and the walk
- rooms;
- both isolation suites, both ways (a cross-tenant `unit_rooms` read and
  move);
- verify;
- `pnpm eval` once more;
- `pnpm typecheck`;
- the build grep.

The walk is the user's own, on alteza:
1. Add "Casa Uno 2" on S-5.
2. Book Casa Uno for 1 December on the page twice; the second booking
   gets Casa Uno 2.
3. Ask the chat "is Casa Uno free on Dec 1"; it answers 1 of 2 before the
   second booking, and taken after.
4. Move a booking between the two rooms on S-15.

### Phase 7 — The record
- D-133, amending D-034 (the constraint is per room) and D-070 (unchanged
  in substance).
- R-52.
- CLAUDE.md: the header paragraph, 37 SQL files, the check counts, and
  any trap that bites.
- `flow.md`.
- `status.md` and `whats-done.md`.

---

## 7. Questions, answered 2026-10-16 (every recommendation taken)

1. **Alteza's Kubo A and Kubo B.** Merge them into one "Kubo" type with 2
   rooms? Recommendation: yes, by a one-off script after Phase 6. It moves
   their bookings to Kubo's rooms and keeps Kubo A's rates and photos.
   This is the owner's call, because the guest list changes.
2. **A stay with no single room free for every night** (Casa Uno 1 free on
   the 1st, Casa Uno 2 on the 2nd). Recommendation: split it across rooms,
   flag "room change on <date>" on S-15, and let staff move it. The
   alternative is refusing it as unavailable while every night shows free.
3. **Show the count to guests?** Recommendation: yes. "1 of 2 left" on the
   booking page and in the chat, only when a type has more than one room
   (R-52).
4. **Does the guest see their room number** on Manage booking?
   Recommendation: no. Staff may still move them, so the type is the
   promise.
