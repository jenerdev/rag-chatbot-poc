# Staff clash plan: a pending booking cannot be born on a night that is already confirmed, and the list says so before Confirm

> Since D-095 a staff booking is born `pending`, and a pending row holds
> nothing (D-070): `bookings_no_overlap` covers `confirmed` rows only. So
> staff can create a booking on a night that is already confirmed, the
> insert succeeds, and the clash is answered only at Confirm, with a 409.
> The Requests section already warns ("A night of this request is already
> confirmed for another booking") and disables Confirm; the staff list
> does not. The user: "i can still book a room/slot that was already taken
> using staff booking. or this is intentional?" It was the stated cost of
> D-095. This plan removes it in two places, each a wall of its own
> (D-038): **Postgres refuses the insert** of a pending row whose span is
> already confirmed for that unit, from any door; and **the staff list
> carries `clash`** on the pending rows that slipped in before the
> trigger, or through the race it leaves, with the same warning and the
> same disabled Confirm the Requests section has.
>
> Written 2026-10-05, against `c365308` on `feat/dashboard`. **Status:
> Phases 0–4 done 2026-10-05, walk included,** on `feat/staff-clash`; the
> record is D-099. § 7's four
> questions were answered 2026-10-05: every recommendation taken, by the
> user's instruction, with one deviation on q3: the dashboard merge is
> the user's to do (its walk is owed), so this branch starts from
> `feat/dashboard`'s head (`5077028`) and merges after it.
>
> Read [§ 0](#0-the-four-rules) first.

---

## What this plan covers

| | |
|---|---|
| **In scope** | One trigger, `bookings_pending_not_taken` (`sql/schema-taken-span.sql`, the 20th file): a `pending` insert whose `(unit_id, during)` overlaps a `confirmed` row of the same tenant is refused with `23P01` and a message in words. It fires on every door: the staff route, `request_booking()`, a raw insert. `listBookings()` gains `clash` per row (pending rows only, the Requests section's definition). The Bookings screen shows the warning on a clashing pending staff row and disables its Confirm. The route maps the trigger's refusal to the 409 it already maps `23P01` to, with the trigger's words. rooms checks; the record: D-099, which amends D-095's cost line |
| **Out of scope** | A pending row clashing with another PENDING row: both may exist, and the first one confirmed wins the night (§ 7 q2). Changing what Confirm does: it still takes the span and still answers 409 on a clash (D-095). Any availability read (`check_availability`, the booking page's quote) — they already say `taken` for a confirmed night. The chatbot: no prompt text, no tool text. Any change to `bookings_no_overlap` |

### What the user asked, and what the plan does with it

| The user's words | What exists today | What the plan does |
|---|---|---|
| "i can still book a room/slot that was already taken using staff booking" | The staff form inserts `pending`; only `confirmed` rows are in the exclusion constraint; the clash surfaces at Confirm as a 409 | The trigger refuses the insert, in words, before a row exists: "taken on 2026-10-20: Garden Room is already confirmed for that slot" |
| "or this is intentional?" | D-095's cost line: "until confirmed, a staff booking leaves the date open … Confirm then answers 409" | D-099 amends that line: a pending row still holds nothing, but it cannot be CREATED on a night someone already holds |
| (the gap the question exposed) | The Requests section warns and disables Confirm on a clash; the staff list does not | `clash` on the staff list's pending rows, the same warning, the same disabled button |

---

## 0. The four rules

### Rule 1 — Postgres refuses; the screen only warns

The trigger is the guard, and it runs as the caller under the same RLS
every door already has: a staff token, a chat token through
`request_booking()`, and `service_role` all meet it. The screen's warning
and its disabled button are the courtesy (CLAUDE.md trap 21): a stale
list in a second tab still reaches the server, and the server answers.
Nothing in code does "check, then insert" (trap 8); `createBookings()`
inserts and maps the error, as it does for the exclusion constraint.

### Rule 2 — The same error code, so the same 409

The trigger raises `exclusion_violation` (`23P01`), the code the
exclusion constraint raises, so `createBookings()`'s map
(`23P01 → BookingConflictError`) and `lib/route.ts`'s map
(`BookingConflictError → 409`) hold unchanged. What changes is the
message: the trigger's words name the date and the unit, and
`createBookings()` passes them through instead of its generic sentence.
`request_booking()`'s caller, `requestBooking()`, maps the same code the
same way; the booking page shows the words.

**Learned in Phase 1:** the customer's door was already refused in SQL.
`request_booking()` checks the confirmed rows itself and raises `23P01`
"That date is no longer available" before any insert, so the trigger
stands behind that check, never in front of it. The staff door is the
one that had no SQL check; the trigger is its wall 2. rooms 26b asserts
the customer door is refused in SQL by either message.

### Rule 3 — A pending row still holds nothing

`bookings_no_overlap` is untouched. Two pending rows may still share a
night (§ 7 q2); the first one confirmed takes it, and the other's Confirm
is the 409 it is today. The trigger only stops a pending row being BORN
on a night that is already confirmed. So D-070 stands: a request holds
nothing until staff say so.

### Rule 4 — No lock, and the window it leaves is named

A pending insert that reads "no confirmed row" while a concurrent Confirm
commits one leaves a pending row beside a confirmed one. That is the
state the list's `clash` flag and the dashboard's "would clash on
Confirm" count already describe, and its Confirm answers 409 (Rule 3).
The closed-days advisory lock is not taken: it would make every staff
insert wait on every Confirm for nothing worse than a warning. The window
is one statement wide and is recorded in D-099.

---

## 2. Traps

### 2.1 A trigger inherits its caller's `search_path`

CLAUDE.md trap 19. The function has `set search_path = ''` and every name
is qualified, because `request_booking()` runs with `''`.

### 2.2 `during` is computed by an earlier trigger

`bookings_compute_during` fills `during` from the slot on insert. The new
trigger must run AFTER it, or `new.during` is null and the check passes
vacuously (trap 12). Triggers fire in name order; the new one is named to
sort after `bookings_compute_during` and rooms asserts the refusal on a
real insert, not on a row with `during` set by hand.

### 2.3 Every row of a group, or none

A several-rooms booking is one insert of several rows. The trigger is
`for each row`, so one clashing room refuses the whole statement, as the
exclusion constraint does; rooms asserts that no row of the group was
written.

### 2.4 The seeded fixtures insert `confirmed`

The battery, isolation and rooms seed `status: 'confirmed'` (D-095); the
trigger ignores a confirmed insert (the constraint already guards it), so
no fixture changes. The verify suite's row builders insert confirmed too.

### 2.5 The old sentence is in a test

`createBookings()`'s 23P01 sentence, "That slot on … overlaps an existing
booking.", and `confirmBooking()`'s are asserted somewhere; when the
staff insert's message becomes the trigger's words, the assertion moves
with it, and the exclusion constraint's refusal (a confirmed insert on a
confirmed night) keeps the generic sentence, because Postgres gives the
constraint's name, not words.

---

## 3. The data model

No table, no column. `packages/db/sql/schema-taken-span.sql` (the 20th
file), idempotent (drop trigger if exists, create or replace function):

```sql
-- bookings_pending_not_taken(): BEFORE INSERT, for each row, when new.status = 'pending':
--   if exists (confirmed row of the same tenant and unit whose during && new.during)
--     raise exception 'taken on %: % is already confirmed for that slot', new.booked_date, <unit name>
--       using errcode = 'exclusion_violation';   -- 23P01, the constraint's own code (Rule 2)
-- security invoker, set search_path = ''; names qualified (§ 2.1).
-- Named 'bookings_pending_not_taken' so it fires after bookings_compute_during (§ 2.2).
```

---

## 4. The screen

The staff list's pending row, when `clash` is true: the Requests
section's sentence, "A night of this booking is already confirmed for
another booking.", under the row, and Confirm disabled. Cancel stays
enabled, which is what staff do with it. Nothing else on the screen
changes.

---

## 5. Phases

### Phase 0 — Baseline
On the branch's first commit: rooms 45, bookings isolation 31 both ways,
verify 118, tests 59 and the bookings package's own. The three prompt
baselines diffed. The battery is NOT run: no prompt text, no tool text
and no availability read changes; Phase 3 runs it once as the proof.

### Phase 1 — SQL
`schema-taken-span.sql`, run by the user. rooms gains: a pending insert on
a confirmed night is refused with `23P01` and words naming the date and
the unit (staff token); `request_booking()` on a confirmed night is
refused the same way (chat token); a pending on a PENDING night is
allowed (Rule 3); a several-rooms insert with one clashing room writes
no row (§ 2.3); a confirmed insert on a confirmed night is still the
constraint's refusal (§ 2.4).

### Phase 2 — The package, the route, the screen
`listBookings()` adds `clash` (pending rows whose `date|unit|slot` is in
the confirmed set, the Requests section's expression); `createBookings()`
and `requestBooking()` pass the trigger's words through on `23P01` when
the message carries them, the generic sentence otherwise; the Bookings
screen's warning and disabled Confirm; tests for the map and the flag.

### Phase 3 — The walls and the walk
rooms, both bookings isolation runs, pipeline isolation both ways,
verify, the three baselines, the battery once (expect the known set; the
two date-driven failures until today passes 2026-10-20). The walk, by the
user: create a staff booking on a confirmed night → refused in words;
on a free night → pending; confirm it; a second pending on that night →
refused; an existing clashing pending row (seeded by the walk script)
shows the warning with Confirm disabled.

### Phase 4 — The record
D-099 (amending D-095's cost line and the D-070 sentence "a pending row
holds nothing", which stays true); CLAUDE.md (the header, 20 sql files,
rooms count, the trap list if § 2.2 bites); flow.md § 5's bookings row;
status, whats-done.

---

## 6. What must not change

- `bookings_no_overlap`, Confirm's behaviour, and the 409 at Confirm.
- Every availability read, the chatbot, the prompts, the tools, the three
  baselines.
- No table, no column, no policy; no `service_role` in a request.

---

## 7. Questions, each with a recommendation

1. **Both doors, or staff only?** The trigger fires on `request_booking()`
   too, so a customer whose night was confirmed between the quote and the
   send gets a refusal in words instead of a request that can never be
   confirmed. **Recommend both doors**: one trigger, one rule, and the
   booking page already says "not open" before the send.
2. **Pending beside pending?** Two requests for the same night, both
   pending, is today's normal: the first confirmed wins. **Recommend
   leaving it**: refusing the second request would make the first
   stranger's unsent, unconfirmed request hold a night (against D-070).
3. **Branch timing.** The dashboard is on `feat/dashboard`, unmerged, its
   walk owed. **Recommend** walking and merging the dashboard first, then
   branching `feat/staff-clash` from `master`; the two touch the same
   screen file's neighbours and the status file, and one merge at a time
   is less to read.
4. **Should Confirm be blocked in code on `clash`?** **Recommend no**
   (Rule 1, trap 21): disabled is a courtesy; the server's 409 is the
   guard, and a second tab proves it.
