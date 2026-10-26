# Free guests plan: children up to a tenant's age stay free, and the booking counts them apart

> Today every door asks ONE number per room, `guest_count`, and the price
> charges every guest above the room's standard capacity. A resort's rule
> that small children are free exists only as words: the platform's
> "Guest hint" (`booking_page.guest_hint`, placeholder "Do not count
> children aged 3 and below."), which trusts the guest to subtract. The
> user (2026-10-26): "we need to handle also guest who are free depending
> on age. depending on resort rule. for example for resort A. 3 years old
> and below are free. then resort B is 5 years old and below are free.
> that should be configurable on platform if thats the best location for
> configuration."
>
> This plan gives each tenant ONE number, the oldest age that stays free,
> set on the platform form beside the other two bookings limits (D-078),
> and gives every booking a SECOND count, `free_guests`, that the price
> never sees. The price function does not change: `unit_quote()` keeps
> charging `guest_count` (the paying guests), so every door, the trigger
> and the chatbot's tool agree by construction, as extra-guests Rule 1
> demands. Written 2026-10-26. **Status: complete, 2026-10-26** (D-147,
> R-62): § 7 answered by the user (q1 no: a free child does not count
> toward the maximum; q2 the platform), Phases 1–6 done, the walk 7/7
> twice, shots in `plan/free-guests/`. The measured values are in D-147
> and status.md's session log.
>
> Read [`extra-guests.md`](./extra-guests.md) § 0 (one function makes
> every price) and [`customer-booking.md`](./customer-booking.md) § 0
> (`request_booking()` is the ONE public write) before this one.

---

## 1. What the request assumes, and what is here

| The request says | What the code has | What this plan does |
|---|---|---|
| "only ask for number of guest per room" | `guest_count int` per booking row (one unit, one night); the booking page, the staff form (D-111) and `request_booking()` each take `[{ unitId, guests }]` | A second count beside it, `free_guests`, from the same three doors |
| "guest who are free depending on age" | nothing structural; `guest_hint` is free text | `free_up_to_age` in the bookings config: the oldest age that stays free; absent = nobody is free |
| "resort A … 3 and below, resort B … 5 and below" | the config is per tenant already (`tenant_applications.config`, checked by `tenant_applications_validate`) | one whole number, 0–17, in that config |
| "configurable on platform" | max stay and horizon are set there (D-078, the Limits section of the tenant form's Bookings tab) | the third field in that section: "Children stay free up to age" |
| the price | `unit_quote(p_guests)` charges `greatest(0, guests − standard_capacity) × extra_person_rate` | **unchanged**: `p_guests` is the PAYING count, as today |

---

## 0. The rules

### Rule 1 — The price function does not learn about ages

`unit_quote()` is the ONE place a price is made (extra-guests Rule 1,
D-074, D-097), and it takes a count of guests to charge for. A free child
is simply not in that count. So nothing in SQL, TypeScript or the tool
adds an age test to a price: the booking page, the staff form and the
tool all pass the paying count as `guests`, exactly as today, and the
free count rides beside it as a fact about the stay.

### Rule 2 — Two counts on the row, both written at birth, neither derived

`bookings.free_guests int not null default 0` (check `>= 0`). Every door
that inserts a row writes it (the web request through `request_booking()`,
the staff stay through `staff-stay.ts`, the tools through
`createBookings()` with 0). It is never recomputed from an age: ages are
not stored (nothing on the row says WHO is free, and the privacy
groundwork, D-129, wants no more guest detail than the stay needs).

### Rule 3 — The rule is read from the config at the door, never typed twice

`free_up_to_age` reaches the booking page through `bookingPage()` (the
read the page already makes of the bookings config on the chat token),
the staff form through the same shape, and the chatbot through the tool
RESULT. The words "Children aged 3 and below stay free" are written in
ONE function, `freeGuestsWords(age)` in `@rag/bookings`, used by the
page, the form, Manage booking and the tool's note.

### Rule 4 — The chatbot's tool TEXT and the prompt do not change

As with closed dates (D-080) and room counts (R-52): the rule appears in
the tool's RESULT, only when the tenant has one (`freeNote()`, beside
`closedNote()`), and in D-085's extra-guest terms. The three baselines
stay byte-identical. `guests` in the tool's arguments keeps meaning the
paying count, which is what the model is told to pass.

### Rule 5 — A free guest is not a paying guest, and the capacity test says which it counts

§ 7 q1 decides whether `free_guests` counts toward `units.capacity`. The
plan's default: **it does not** ("3 and below are free" at a resort means
not counted at all, and the trigger's capacity test keeps reading
`guest_count` alone). If the user chooses "counts", the one change is in
`bookings_compute_during`: `guest_count + free_guests > capacity`, and in
the two quotes' pre-checks. Either way it is ONE comparison in ONE
trigger, and the quotes mirror it in words.

---

## 2. Traps

### 2.1 `request_booking()` has one signature per file that touched it

Seven files define it; the latest body is `schema-staff-requests.sql`'s
and the legal plan WRAPPED it (`request_booking_with_consent()`) rather
than replace it (D-129). A new column in the INSERT cannot be wrapped:
the row is born inside `request_booking()`. So this plan replaces the
body once more, in the new file, with `p_free int[] default null` as the
13th parameter (null = every room 0), and the consent wrapper gains the
same parameter and passes it through. The old signatures are dropped
first, as promos did (trap 20: a re-run of an older file must not put a
free-less body back, so the new file's marker guards it: the column
`bookings.free_guests`).

### 2.2 Re-running `schema-roles.sql` would drop the new config check

`tenant_applications_validate()` is defined in three files already; the
new file replaces it with the `free_up_to_age` branch added. Guard the
older definitions on `to_regclass`/the column, per trap 20 and trap 25
(re-apply every later file in order after testing an old one).

### 2.3 The staff form's "guests" is the party for the price

`bookings-screen.tsx` sums `u.guests` into "· 4 guests" on the list row,
and `stay-detail-screen.tsx` does the same. With a free count these
must say "4 guests + 1 child" or the list under-counts the party. Every
place that prints a guest count is in § 3.4; a grep for `guests` across
`apps/web/components` is the checklist (15 files; 6 of them print one).

### 2.4 A quote and the stored row must agree about the free count too

`priceStay()` is the ONE stay quote (customer-booking Rule 3); its lines
carry `guests` per unit and night. The free count joins the line so the
review step, the staff breakdown and the receipt all print the same
party. The receipt's total is still the sum of STORED prices: free
guests change no amount.

### 2.5 "for 3 guests" in the chat is ambiguous once children are free

`dates.ts`'s `guestCount()` turns "for 3 guests" into `guests: 3`. A
visitor who says "2 adults and a toddler" is parsed as 2, which is right
under this rule; "3 guests" with a toddler among them is parsed as 3,
which overcharges by one extra-guest fee in the QUOTE the chat shows. The
chat does not book (D-069), so the page's two fields are what count; the
tool's note tells the model the rule so it can say "children aged 3 and
below are free, so count the paying guests". No regex grows for ages.

---

## 3. The shape

### 3.1 SQL — `sql/schema-free-guests.sql` (the 45th file)

1. `alter table bookings add column free_guests int not null default 0
   check (free_guests >= 0)`. Every existing row is 0: every stay to date
   was priced on the one count, which is now the paying count. No backfill.
2. `tenant_applications_validate()` replaced: `config.free_up_to_age`, when
   present, is a whole number from 0 to 17 (the message names both).
3. `request_booking()` replaced with `p_free int[] default null`:
   cardinality must match `p_unit_ids` when given; each ≥ 0; written into
   `free_guests`; the return table gains `free int`. `request_booking_with_consent()`
   replaced to take and pass it. Old signatures dropped.
4. `guest_stay()` adds `free` per unit line (the guest sees their own party).
5. `bookings_compute_during`: unchanged by default (§ 7 q1); one
   comparison if "counts".
6. verify.mjs: the column's default and check; the config check (18 and
   "3.5" refused, 3 kept); `request_booking` with and without `p_free`; a
   mismatched cardinality refused; a chat token still updates nothing.

### 3.2 `@rag/bookings`

- `validate.ts`: `parseRooms()` accepts `free` (optional, whole, ≥ 0;
  default 0) beside `guestCount`; `RoomChoice` carries `free`.
- `config.ts`: `BookingConfig.freeUpToAge: number | null`; `requireConfig`
  reads it. `freeGuestsWords(age)` is the ONE wording (Rule 3).
- `requests.ts`: `BookingPage.freeUpToAge`; `priceStay()` lines carry
  `free`; `requestBooking()` passes `p_free`; `listRequests()` rows carry
  `free`; the booking group's units carry `free`.
- `staff-stay.ts`: `NewStaffStay.rooms[].free`; the insert writes
  `free_guests`.
- `createBookings()` (the tools' seeder) is unchanged: the column defaults
  to 0.
- rooms.mjs: a web request with 1 free on a 2-guest room prices as 2
  guests (the quote and the stored row equal), a staff stay the same, the
  list and `guest_stay()` carry it.

### 3.3 The platform

- `tenant-form.tsx`, Bookings tab, Limits section: "Children stay free up
  to age" (number, 0–17, empty = nobody), written to
  `config.free_up_to_age`; `platform.ts`'s comment lists the key.
- The Guest hint stays: it is for anything else the resort wants to say.
- `plan/free-guests-walk.mjs`: set 3 on a throwaway tenant, read it back
  through `bookingPage()`, 18 refused with the trigger's words.

### 3.4 The three doors and the four screens

- **Booking page** (S-6), Guests step: with a rule, two fields per room,
  "Guests" (aged N+1 and over) and "Children aged N and below" (0 default,
  free); without one, today's one field. The review and the first night's
  lines print "4 guests + 1 child (free)". `bookRequestSchema`: `free`
  optional per room.
- **Staff New booking** (S-3, D-111): the same two fields per room, the
  same words; Walk in unchanged.
- **S-15** and the list row: "4 guests + 1 child"; **Manage booking**
  (S-13): the same on the stay's lines. `StayLines` prints the party once
  per unit.
- A11y: the second field is a labelled number input (D-142, native); the
  phone-width check at 375.

### 3.5 The chatbot

- `tools.ts`: `freeNote(config)` in the RESULT of both `check_availability`
  shapes, only when the tenant has a rule: "Children aged 3 and below stay
  free: pass only the paying guests as guests." `extraGuestLines()` adds
  the same sentence when there is a rule.
- The three baselines diffed byte-identical (Rule 4).
- The battery cannot run as written (northwind and harbor deleted
  2026-10-20); the villa cases that touch guests (`price-villa-guests`,
  `tool-*`) run with `--only` against villa after villa is given a rule,
  then the rule is removed. Record the runs, not a full score.

### 3.6 The record

D-147 (the rule and where it lives; the price untouched), a risk for
§ 2.5, the CLAUDE.md paragraph, status.md and whats-done.md.

---

## 4. Phases

| Phase | What | Proves |
|---|---|---|
| 0 | § 7 answered by the user | the capacity rule and the config's home |
| 1 | the SQL file, applied; verify +6 | the column, the check, both functions, the guest read |
| 2 | `@rag/bookings`; rooms.mjs +4; bookings isolation re-run | the quote and the row agree; no cross-tenant read |
| 3 | the platform field; the walk | set, read back, refused |
| 4 | the booking page, the staff form, S-15, Manage booking, the list; a11y at 1280 and 375 | the party printed the same everywhere |
| 5 | the tool's note and the terms line; baselines diffed; the villa cases | no prompt or tool text changed |
| 6 | the record | |

---

## 7. Questions for the user

1. **Does a free child count toward a room's maximum?** The plan's
   default is NO: "up to 4 guests" means paying guests, and a toddler in
   the room does not refuse the booking. If the resort's maximum is a
   head count (beds, the pool, fire rules), say so and Rule 5's one
   comparison becomes `guest_count + free_guests`.
2. **The platform, or the owner?** The plan puts the age on the platform
   form beside max stay and horizon (D-078: the bookings limits are the
   platform's). The owner-side alternative is a field on a tenant admin
   screen (the Slots or Accommodations screen has no natural place; it
   would be a new "Booking rules" card). The platform is recommended: it
   is one number, set once, and the super user already sets the other
   two limits there.
