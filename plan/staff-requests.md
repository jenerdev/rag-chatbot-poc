# Staff requests plan: every pending stay is a request, with a reference, whoever made it

> The Requests section at the top of the Bookings screen lists web
> requests only (`listRequests()` reads `source = 'web'`), and only a web
> request has a reference (`request_booking()` makes it). A staff booking,
> born `pending` since D-095, waits in the chronological list below with
> its own Confirm, and has no reference to quote to the guest on the
> phone. The user: "why staff created booking doesnt have a reference
> number?" and "why staff created booking dont show up on 'Requests'
> section on top". This plan makes **one shape for a stay**: every booking
> belongs to a group and every group has a reference, made by ONE SQL
> function; the Requests section lists every pending stay, web or staff,
> and decides either with the same button.
>
> Written 2026-10-05, against `8c521b2` on `master`. **Status: in progress,
> Phase 0 started 2026-10-05** on `feat/staff-requests`. § 7's four
> questions were answered 2026-10-05: every recommendation taken, by the
> user's instruction.
>
> Read [§ 0](#0-the-four-rules) first.

---

## What this plan covers

| | |
|---|---|
| **In scope** | `booking_reference(p_tenant_id)`, ONE SQL function for the reference's shape, extracted from `request_booking()`, which then calls it; a BEFORE INSERT trigger that gives every booking a `group_id` (its own, when the insert names none) and a `reference` (the group's, when a row of the same statement already has one, else a new one); a backfill of every existing row that lacks either; `listRequests()` reads every source and says which (`source`); `confirmRequest()` / `declineRequest()` decide any group; the Requests section shows staff stays too, labelled, with the reference; the staff list's "group booking" label means several rooms, not "has a group"; rooms checks; the record, D-100 |
| **Out of scope** | Removing the staff list's own Confirm (it is the same server call; a pending staff row shows in both places, as a web request already does). Any change to `request_booking()`'s lock, limits or inserts beyond the reference call. The chatbot, the booking page, the dashboard's two counts (requests waiting, staff bookings unconfirmed: two facts, kept). Emailing a reference to anyone |

### What the user asked, and what the plan does with it

| The user's words | What exists today | What the plan does |
|---|---|---|
| "why staff created booking doesnt have a reference number?" | `request_booking()` makes `VIL-7KQ4MX` for a web request; the staff insert sets none; the check constraint demands one for web rows only | ONE function makes every reference, and a trigger fills it for any insert that brings none, so a staff booking has `HAR-3MX9KT` to quote |
| "why staff created booking dont show up on 'Requests' section" | `listRequests()` filters `source = 'web'`; `decide()` too | Both read every source; the row says "by staff" or "from the booking page" |
| (what it must not undo) | D-095: a staff booking is born pending and Confirm takes the span; D-099: none can be born on a confirmed night; D-070: a request holds nothing | All stand. Only the reading and the labels change, plus the two columns filled |

---

## 0. The four rules

### Rule 1 — One function makes every reference

`booking_reference(p_tenant_id)` is the shape (three letters of the slug,
six from the 30-letter alphabet, retried until unused in the tenant), and
the ONLY place it is written. `request_booking()` calls it under its
existing lock; the trigger calls it for an insert that brings none. No
code makes a reference, and no second copy of the alphabet exists.

### Rule 2 — A stay is a group, and a group has one reference

Every row has a `group_id` after this plan: the insert's, or its own.
Every row of a group has the same `reference`. The trigger reuses the
group's reference when a row of the same statement already set it
(Postgres: a row-level BEFORE trigger sees the rows previously processed
by the same command, § 2.1), so a several-rooms staff booking gets ONE
reference like a web request. The check constraint that demands
`reference`, `group_id`, email and phone on web rows is untouched.

### Rule 3 — The Requests section reads; the server decides

`listRequests()` drops its source filter and adds `source` to each row.
`decide()` drops its source filter: the whole group, one statement, the
same 409 on a clash, the same closed-date words. Nothing on the screen
decides anything the route does not decide again, and the staff list's
Confirm (`confirmBooking(id)`) and the Requests' Confirm
(`confirmRequest(groupId)`) end in the same update of the same rows.

### Rule 4 — The chatbot, the prompts and the tools do not change

No prompt text, no tool text, no availability read. Phase 3 diffs the
three baselines and runs the battery once because `@rag/bookings` moves.

---

## 2. Traps

### 2.1 A BEFORE ROW trigger and the rows before it in the same statement

A several-rooms staff booking is one insert of N rows. The trigger on
row 2 must find row 1's reference, or the group gets N references. The
Postgres rule (Trigger Behavior, "Visibility of Data Changes"): SQL in a
row-level BEFORE trigger sees the effects of rows previously processed in
the same outer command. rooms asserts a 2-room staff booking has one
reference, on a real insert.

### 2.2 `request_booking()` is replaced, so it is guarded

The latest body is in `schema-promos.sql`. The new file replaces it with
one that calls `booking_reference()`; the old file's definition must not
come back on a re-run (trap 20), so the promos file's step is guarded on
`to_regprocedure('public.booking_reference(bigint)')`, the way
`schema-customer-booking.sql` guards on later markers. Re-running the
promos file after this plan skips its `request_booking` step.

### 2.3 The backfill must group historical rows the way they were booked

A staff booking made before booking types had one row per booking; a
several-rooms staff booking since D-053 already shares a `group_id`.
Rows with `group_id` null are single bookings: each gets its own group.
Rows with a `group_id` and no `reference` get one per group. Counts are
printed before and after, and `count(*) where group_id is null or
reference is null` must be 0 after.

### 2.4 "group booking" on the staff list

`bookings-screen.tsx` labels a row "group booking" when `groupId` is set.
After this plan every row has one, so the label would be on every row.
`listBookings()` adds `groupSize` (rows in the group, counted over the
loaded rows), and the label means `groupSize > 1`.

### 2.5 The dashboard counts `distinct group_id`

`tenant_dashboard()` counts `pendingRequests` as `count(distinct
b.group_id) where source = 'web'` and `pendingStaff` with the coalesce
expression; after the backfill both expressions still hold, and
`promo_uses()`'s coalesce too. Not changed, re-read.

### 2.6 Two walls still

`listRequests()` keeps `.eq('tenant_id', …)`; the bookings isolation
suite's "requests A sees none of B's" check gains a staff row on B and
still expects 0 at A, both ways.

---

## 3. The data model

No table, no column. `packages/db/sql/schema-staff-requests.sql` (the
21st file), idempotent:

```sql
-- 1. booking_reference(p_tenant_id bigint) returns text
--      SECURITY DEFINER, search_path = '' (the D-042 shape, the twelfth definer
--      function): `tenants` has no policy for a token, so the slug's three letters
--      can only be read by a definer, and it reads them ONLY after
--      app_tenant_id() = p_tenant_id, or service_role. Then six chars of the
--      30-letter alphabet, retried while a row of that tenant has the result.
-- 2. bookings_fill_group_and_reference(): BEFORE INSERT, for each row:
--      new.group_id  := coalesce(new.group_id, gen_random_uuid());
--      new.reference := coalesce(new.reference,
--                        (select b.reference from public.bookings b where b.tenant_id = new.tenant_id and b.group_id = new.group_id limit 1),
--                        public.booking_reference(new.tenant_id));
--      Named to sort BEFORE bookings_compute_during and the rest (name order): 'bookings_aa_fill_group_and_reference'.
-- 3. request_booking(): the same body as schema-promos.sql's, with the inline
--      reference loop replaced by booking_reference(); still sets both itself.
-- 4. Backfill: update ... set group_id = gen_random_uuid() where group_id is null;
--      then one reference per (tenant_id, group_id) where reference is null,
--      via a loop over distinct groups calling booking_reference(). Counts printed.
-- 5. Grants: booking_reference revoked from public/anon/authenticated, granted to
--      authenticated, service_role (the trigger runs as the caller; a chat token
--      has no insert policy on bookings, so it never reaches the trigger; the
--      function itself refuses a tenant that is not the token's).
```

The reference reveals nothing and grants nothing (customer-booking § 3);
a staff booking's reference is for the phone, like a web one.

---

## 4. The screen

The Requests section: title "Requests"; the intro reads "Every stay
waiting for a decision: sent from the booking page, or made here by
staff. A request does not hold its dates: the first one you confirm gets
them." Each row shows the reference and, in the meta, "from the booking
page" or "by staff". Confirm and Decline as today; Decline on a staff stay
cancels it with the note, like a web request. "Show decided" covers both.
The staff list below is unchanged but for "group booking" (§ 2.4) and the
reference shown on every row, not only web ones.

---

## 5. Phases

### Phase 0 — Baseline
Every suite on the branch's first commit; the three baselines diffed; a
count of rows with `group_id` or `reference` null per tenant (the
backfill's before).

### Phase 1 — SQL
The file, run by the user; the backfill's after is 0; rooms gains: a
single staff booking has a group and a reference of the shape; a 2-room
staff booking has ONE reference (§ 2.1); a web request's reference still
comes from `request_booking()` and is unique in its tenant; the promos
file's `request_booking` step is now guarded (re-run it: skipped).

### Phase 2 — The package and the screen
`listRequests()` and `decide()` without the source filter, `source` on
`BookingRequest`, `groupSize` on `BookingSummary`; rooms: a staff booking
appears in `listRequests()` with `source: 'staff'`, `confirmRequest()`
confirms it, `declineRequest()` cancels one, A sees none of B's staff
stays (isolation); the screen's labels and intro; tests for the pure
parts; typecheck.

### Phase 3 — The walls and the walk
rooms, both isolation suites both ways, verify, the three baselines, the
battery once. The walk, by the user: make a staff booking → it appears in
Requests with a reference and "by staff"; Confirm it there → the list
row below says confirmed with the same reference; a 2-room staff booking
→ one row in Requests, one reference; Decline a staff stay with a note.

### Phase 4 — The record
D-100, CLAUDE.md (header, 21 sql files, the twelfth definer function in
rule 8, rooms count), flow.md § 5 (the requests rows), status,
whats-done.

---

## 6. What must not change

- D-070, D-095, D-099: a pending row holds nothing, is born pending,
  cannot be born on a confirmed night, and Confirm takes the span.
- `request_booking()`'s lock, limits, promo handling and inserts, beyond
  calling `booking_reference()`.
- The three prompt baselines, the battery count, every tool's text.
- The dashboard's figures.

---

## 7. Questions, each with a recommendation

1. **One Requests section, or a second "Staff bookings waiting" one?**
   **Recommend one**: the decision is the same, the clash and closed
   warnings are the same, and "by staff" on the row is enough to tell them
   apart. Two sections would be two lists to forget.
2. **Replace `request_booking()` to use the one function, or leave its
   inline loop and let the trigger have a copy of the shape?** **Recommend
   replacing it** (§ 2.2, guarded): the project's rule is one place per
   shape (`unit_quote()`, `promo_discount()`, `rate_kind()`), and the copy
   is what D-099's `taken.ts` and every "ONE" in CLAUDE.md exist to avoid.
   The cost is a 200-line definition repeated once more, in the 21st file.
3. **Backfill old staff bookings, or only new ones?** **Recommend
   backfill**: a Requests row needs a group id to be decided by, and a
   row without a reference would be the only one on the screen with
   "no reference", a special case forever. The backfill is counted.
4. **Should the staff list's own Confirm go away now that Requests has
   one?** **Recommend keeping it**: a staff member working down the day's
   list should not scroll up; both buttons are the same update, and the
   list's row carries the D-099 clash warning already.
