# Calendar plan: one staff page that shows every date's state, by day, week or month

> Staff learn a date's state today by reading the Bookings screen's
> 14-day list of chips (`open`, `taken`, `closed` per room and slot) and,
> separately, the Holidays screen's list. Nothing shows a month at a
> glance, nothing says "this date is full" in one word, and nothing marks
> a date that has a pending request. The user: "create a plan for calendar
> page. can view type: daily, weekly, monthly. add marking for date fully
> booked … available … booked but not fully booked … has pending request
> … is a holiday … is disabled and not available for booking. maybe like a
> bg color. just add legend. but still your decision on how do you want
> the approach."
>
> Written 2026-10-09, against `cf6acac` on `master`. **Status: planned,
> nothing built.** § 7's seven questions were answered 2026-10-09:
> every recommendation taken, by the user's instruction.
>
> Read [§ 0](#0-the-five-rules) first.

---

## What this plan covers

| | |
|---|---|
| **In scope** | `calendar_slots()` and `calendar_days()`, two SQL functions in a 22nd schema file, `schema-calendar.sql`: the first is the ONE place a (date, room, slot)'s calendar state is decided, the second rolls those rows up into one state per date; `calendarSlots()` / `calendarDays()` in `@rag/bookings`; `GET /api/t/[tenant]/calendar?view=&date=&unit=` on `bookings:read`; S-12, `/t/<slug>/admin/calendar`, with Month, Week and Day views, a legend, and the state in words as well as colour; the sidebar link; verify, rooms and isolation checks; the walk and the axe audit; the record, D-103 |
| **Out of scope** | Creating, confirming or cancelling a booking FROM the calendar (the Day view links to the Bookings screen, which does that, § 7 q4). Prices on the calendar. Drag-and-drop. Changing the Bookings screen's 14-day list or the Holidays screen. The customer booking page (it keeps its date input). The chatbot, its prompts and its tools |

### What the user asked, and what the plan does with it

| The user's words | What exists today | What the plan does |
|---|---|---|
| "view type: daily, weekly, monthly" | A 14-day list on Bookings | Three views on one page, one URL each (`?view=month&date=2026-10-01`), so a reload or a shared link lands on the same view |
| "fully booked" / "available" / "booked but not fully booked" | `open`/`taken` per room and slot; no per-date word | ONE state per date from SQL: **available**, **partly booked**, **fully booked**, decided by counting the date's sellable (room, slot) pairs that are taken |
| "has pending request" | Pending rows exist; nothing counts them per date | A **pending** marker with a count of pending stays on that date. A marker, not a background, because a date can be partly booked AND have a request (§ 4.1) |
| "is a holiday" | `rate_calendar` rows, kind `holiday` or `peak`, shown as a list | A **holiday** (or **peak**) marker with its label. A marker, for the same reason |
| "is disabled and not available for booking" | `kind = 'closed'` (D-080) | **Closed**: its own background, hatched, and the word "Closed". Past dates and dates beyond the booking horizon are also not bookable; they are **dimmed**, a different thing from Closed (§ 7 q3) |
| "maybe like a bg color. just add legend" | One legend sentence on Bookings (ui-components Phase 6) | Background colour for the ONE exclusive state, markers for the two that can co-occur, and a legend that shows each swatch and marker with its word. Colour is never the only signal (§ 0 Rule 4) |

---

## 1. What the request assumes, and what is actually here

- **A date can be several of the user's six things at once.** A holiday
  can be partly booked and have a pending request. So the six are not six
  background colours. Three of them (available, partly, fully) are
  mutually exclusive, and Closed overrides all three: that is the
  background. Holiday and pending are independent facts drawn on top as
  markers. This is the one design decision the rest follows from (§ 4.1).
- **"Fully booked" depends on the booking type.** For `whole_resort`
  (villa) there is one active unit, so a date is full when every active
  slot that day is taken. For `per_room` (harbor) it is full when every
  (active room × active slot) pair is taken. Both are "taken pairs =
  sellable pairs", so one definition covers both (§ 3).
- **`taken` already means "overlaps a confirmed booking"**, including one
  that started the day before (an Overnight from the 9th takes the 10th's
  morning). The calendar uses the same meaning as Bookings and the
  chatbot, from the same SQL test, so the three never disagree (Rule 1).
- **No read counts pending per date today**, and `check_availability`
  refuses past dates and more than 31 days in TypeScript
  (`MAX_AVAILABILITY_DAYS`). A month grid needs up to 42 days and staff
  will want last month too. So the calendar gets its own read, not a
  stretched `checkAvailability()`.
- **There is no month-grid component.** Holidays is a list grouped by
  month; the booking page uses a native date input. The grid is new, and
  hand-written (no calendar library, D-001's spirit and D-101's "no
  component library").

---

## 0. The five rules

### Rule 1 — One SQL function decides a slot's state; one rolls it up

`calendar_slots(p_tenant_id, p_from, p_to, p_unit_id)` returns one row
per (date, active room, active slot) with `state` in `closed | taken |
open` and `pending` (the number of pending stays overlapping that slot).
Its `taken` is `check_availability()`'s own answer: `calendar_slots()`
CALLS that function and joins its rows back to ids (unit and slot names
are unique per tenant). **Amended in Phase 1:** the plan first said to
extract the test into a `slot_taken()` and re-create `check_availability()`
around it; five older files define that function, so a re-run of any of
them would have put the copy back (trap 20). Calling it leaves it
untouched, so Rule 5 holds by construction.
`calendar_pending()` is the one place a pending stay is matched to a slot.
`calendar_days()` aggregates `calendar_slots()`: it never re-derives a
state. The screen never counts, compares or rolls up anything (D-098's
Rule 1): it draws what the function returned.

### Rule 2 — Security invoker, staff only, no new definer function

Both functions are `security invoker`, like `tenant_dashboard()`: they
read `bookings` under the caller's own RLS, and they refuse a caller that
is not `app_is_staff()` of that tenant (`42501`), so a chat token gets a
refusal, not an empty calendar that looks like "everything available"
(trap 12). There is no thirteenth definer function. The route asks
`bookings:read`, which every role has, and nothing on the calendar is
more than a staff member can already see on Bookings.

### Rule 3 — The tenant's day, past and future

Dates are the tenant's (`config.timezone`, trap 9). "Today" comes from
`localDate(timezone)` and is ringed. Past dates are allowed (history),
up to 62 days per call (a 6-week month grid is 42). Past and
beyond-horizon (`max_advance_days`) dates are returned with
`bookable = false`, computed in SQL from the same config the booking
page obeys, so the calendar's "not bookable" and the booking page's
refusal are the same rule.

### Rule 4 — Colour is never the only signal

WCAG 1.4.1. Every date carries its state three ways: the background, a
word or count in the cell ("Full", "3 / 8", "Closed"), and an
`aria-label` sentence ("Friday 10 October: partly booked, 3 of 8 taken,
1 pending request, holiday: Araw ng mga Bayani"). Closed is hatched as
well as grey, so it survives a greyscale print and colour blindness. The
legend shows each swatch beside its word. Colours are tokens derived from
the five theme keys (D-101); no literal after `tokens.css`; dark mode
from the same tokens; `plan/ui-refresh-a11y.mjs` stays at 0.

### Rule 5 — The chatbot, the prompts and the tools do not change

No prompt text, no tool text, no change to what `check_availability()`
returns. Extracting `slot_taken()` must leave its rows byte-identical:
Phase 1 diffs them for a month on all three tenants, and Phase 5 diffs
the three baselines and runs the battery once because `@rag/bookings`
moves.

---

## 2. Traps

### 2.1 Zero of zero is not "available"

A date with no active slot (every slot retired, or a per_room tenant with
no active room) has 0 sellable pairs. `0 taken of 0` must not read as
"available". `calendar_days()` returns `state = 'none'` for it, drawn as
"Nothing to sell", and verify has a check for it (trap 12's twin).

### 2.2 Closed overrides, and a closed date can still hold a confirmed row's spill-over

`rate_calendar_closed_check` refuses to close a date with confirmed
bookings ON it, but a stay that started the day before can still overlap
its morning. Closed wins the background (nothing new can be sold), and
the Day view still lists the overlapping booking.

### 2.3 A pending stay is counted once per date, not once per row

A three-room request is three rows with one `group_id`. "Pending: 3" for
one request would be wrong. Count distinct `group_id` (every row has one
since D-100), the dashboard's lesson (plan/dashboard.md 2b.1).

### 2.4 A pending request on a full date is a clash, and it is still shown

Two pendings may share a night, and a pending may sit on a span that was
confirmed after it was made (D-099 refuses it only at INSERT). Its Confirm
will be a 409. The marker still shows it ("1 pending, would clash" in the
Day view, from `listBookings()`'s `clash`), because staff must decline it.

### 2.5 Retired rooms and slots in the past

Sellable pairs are counted over ACTIVE rooms and slots, so a past date
whose booking was on a since-retired room can read "available" while the
Day view lists that booking. The plan accepts this and says so in the
legend's footnote ("counted over today's rooms and slots"), rather than
reconstructing past inventory, which the schema does not record (§ 7 q2).

### 2.6 A month grid has days of the neighbouring months

A 6-week grid shows the tail of last month and the head of next. They are
fetched and drawn (dimmed, still clickable), so the range is the grid's,
not the month's: Monday before the 1st to Sunday after the last day.

### 2.7 A trigger and a function inherit `search_path`

Both functions `set search_path = ''` and qualify every name (trap 19).

---

## 3. The data model

No table, no column, no existing function replaced. Three functions, in
`packages/db/sql/schema-calendar.sql`, the 22nd file:

```
calendar_pending(p_tenant_id, p_from, p_to, p_unit_id) → table(day, unit_id, slot_id, group_id)

calendar_slots(p_tenant_id bigint, p_from date, p_to date, p_unit_id bigint default null)
  → table(day date, unit_id bigint, unit text, slot_id bigint, slot text,
          state text,        -- 'closed' | 'taken' | 'open'
          pending int)       -- distinct pending stays overlapping this slot

calendar_days(p_tenant_id bigint, p_from date, p_to date, p_unit_id bigint default null)
  → table(day date,
          state text,        -- 'closed' | 'full' | 'partial' | 'available' | 'none'
          taken int, sellable int,
          pending int,       -- distinct pending stays on the date (any slot)
          rate_kind text,    -- rate_kind(): holiday | peak | closed | weekend | weekday
          label text,        -- rate_calendar.label, for holiday / peak / closed
          bookable boolean)  -- not past, not beyond max_advance_days, not closed
```

- Both: `security invoker`, `stable`, `search_path = ''`, refuse unless
  `app_is_staff()` of `p_tenant_id`, and refuse a range that is reversed
  or over 62 days (in words, `22023`).
- `p_unit_id` narrows to one room (the per_room filter, § 4.3); a room of
  another tenant gives no rows, because RLS and the tenant filter both
  apply (rule 6, both walls).
- `state`: `closed` if the date is closed; else `none` if `sellable = 0`;
  `full` if `taken = sellable`; `partial` if `taken > 0`; else
  `available`.
- In TypeScript, `@rag/bookings` gets `calendarDays(tenant, range,
  {unitId})` and `calendarSlots(...)`, each mapping rows field by field
  (rule 7's habit), and a typed `CalendarDayState`.

---

## 4. The page

### 4.1 The marking system (the legend is exactly this)

| What | How it is drawn | Why this way |
|---|---|---|
| **Available** | `--ok-soft` background, the day number | The quiet default, matches the `open` chip |
| **Partly booked** | `--warn-soft` background, "3 / 8" | The middle; the count says how far |
| **Fully booked** | `--danger-soft` background, "Full" | Matches the `taken` chip: the thing to notice |
| **Closed** | `--panel` with a diagonal hatch, "Closed", the label | Matches the `closed` chip; the hatch survives greyscale |
| **Nothing to sell** | plain, "—" | § 2.1 |
| **Holiday / Peak** | a small star (holiday) or flame (peak) icon top-right, the label in the Day and Week views and in the tooltip | Can co-occur with any background |
| **Pending request** | a filled `--accent` dot with the count, bottom-right | Can co-occur; the accent is the "act on this" colour across the app |
| **Today** | a 2 px accent ring | |
| **Past / beyond the horizon** | the cell dimmed by colour (not opacity, D-101), still clickable | "Not bookable" but not Closed (§ 7 q3) |

The legend sits under the view switcher, one row of swatch + word, and
wraps on a phone. It is a `<ul>`, so a screen reader reads it as a list.

### 4.2 The three views

- **Month** (default). A 7-column grid, weeks starting Monday (ISO, as
  `weekend_days` is). Each cell: day number, the state word or count,
  the markers. Clicking a cell (or Enter on it) opens that date's Day
  view. On a phone the cell keeps the colour, the number and the markers,
  and drops the word into the `aria-label` and the Day view.
- **Week.** Seven columns. For `per_room`, one row per room and in each
  cell its slots as the existing `slot-chip`s (reused, not redrawn), so a
  week reads like harbor's Bookings list turned sideways; for
  `whole_resort`, one row of slot chips. The day header carries the
  day's state and markers. Below 600 px it becomes seven stacked days.
- **Day.** Every (room, slot) as a row with its state, and under it the
  bookings that overlap it, from `listBookings()` for that date: guest,
  status, reference, `clash`. Each booking links to the Bookings screen at
  that date (the place that confirms and cancels; this page writes
  nothing, § 7 q4).

Above the views: a segmented control (Day / Week / Month), "← Earlier",
"Today", "Later →", the period's title ("October 2026", "6 – 12 Oct",
"Friday 10 October"), and for `per_room` an "All rooms" select. The view,
the date and the room are the URL's query, so the back button and a
reload work.

### 4.3 Accessibility and the components

- The month grid is a `<table>` with a `<caption>`, weekday `<th
  scope="col">`, and a `<button>` in each cell with the full `aria-label`
  sentence (Rule 4). Not an ARIA `grid` with arrow keys: Tab through 42
  buttons is acceptable for a staff screen, and a half-done arrow-key
  model is worse than none (§ 7 q6).
- Markers have `Tip`s (D-102) on hover and focus; their text is also in
  the `aria-label`, so the tip is a courtesy.
- `LoadState` while loading, `EmptyState` never (a calendar always has
  dates), toasts only for a failed load.
- New: `components/calendar-screen.tsx`, `components/month-grid.tsx`
  (pure, props in, no fetch: the dates, the states, a click handler),
  `components/calendar-legend.tsx`, `lib/calendar-range.ts` (pure: the
  6-week grid's first and last day, a week's, a day's; Monday start;
  tested). New CSS in `screens.css` under `/* --- calendar (S-12) */`.
- A sidebar link "Calendar" in the Bookings section, after Bookings, with
  a new hand-drawn `grid-calendar` icon in `icons.tsx`
  (`ICON_OF` forces it). The page 404s unless the tenant has the bookings
  application.

---

## 5. Phases

**Progress (2026-10-09).** Phase 0 done. Phase 1 done: the user ran
`schema-calendar.sql`; availability for 2026-10-09..11-08 byte-identical
to Phase 0 on villa and harbor; verify 122/123 (119–123 new, all pass; the
one failure is the known roles check). Phase 2 done: `occupancy.ts`,
`GET /calendar`, `lib/calendar-range.ts` (9 tests), bookings isolation
16d both ways, `plan/calendar-phase2-walk.mjs` 7/7 over HTTP. The rooms
suite got no new check: the HTTP walk reads harbor's real rooms, which is
what the plan wanted it for. Phases 3 and 4 done together (one screen
file): `plan/calendar-walk.mjs` all pass, light and dark, 1280 and 375,
after the user restarted `pnpm dev` (the running server had stopped
recompiling CSS). The walk found three things, all fixed: the week's
visually-hidden text stretched a 375 px page to 603 (the scroll box is
now `position: relative`); partly and fully booked tints were close on
villa's warm theme (a 3 px amber / red top edge now); a slot pending
through an OVERLAPPING stay listed no booking (it says so now). Week on a
phone scrolls inside itself rather than stacking days (§ 4.2 said
stacked); one layout, and the walk proves the page never scrolls.
Tips on month-cell markers were dropped: a Tip inside the cell's button
would nest interactive elements; the sentence, the cell's label text and
the Day view carry the same facts. Added at the user's request (2026-10-09): a month picker, a year either
side of the tenant's today (`monthOptions()`, 2 tests). Then, the user
again: the "October 2026" title beside it was redundant, so in the MONTH
view the picker is the title (styled as one, `aria-label="Month"`), and
the week and day views keep their text title with no picker. Walk 3e
(the picker is the title, no h2; January 2027 picked, the grid and the
address follow) and 3f (week: a title, no picker). And: an available date
that cannot be booked (past, or beyond the window) shows no "Open" in its
cell (`cellText()`, 1 test; the sentence still says it); a count on a
past date stays, as history; cell content pinned to the top so a cell
without the word lines up. Walk 1h. And: the step buttons name the step
by view ("Previous month" / "Next month", week, day; walk 3g), grouped so
the three share one row on a phone. Found doing it: at 1280 px the week
pushed Sunday out of view; the week now has fixed columns and its chips'
words wrap (walk 4c: all seven days fit). And: the month on screen stands
out; the neighbouring months' days in the grid are plain (the card's
background, a dashed outline, muted text), still clickable and still
worded (walk 1i). And (the user: "when slot is taken, show booking
details, show guest info"): `calendar_bookings()`, a fourth invoker
function appended to `schema-calendar.sql` (re-run by the user), says
which pending or confirmed booking overlaps which (room, slot) on a day,
by the same overlap test as "taken"; `calendarDayBookings()` takes the
guest from `listBookings()` and maps it field by field, no price; the
route returns it with `view=day`, and the Day view shows a card per
booking (guest, status, reference, guests, phone as tel:, email as
mailto:, source, notes, "Since Fri 27 Nov · Night" for a stay that began
earlier). Verify 124 (the full day's four, the two-room stay on both
rooms, a chat token refused), isolation 16d extended (B's guest never on
A's day, both ways), walk 3c2. Phase 5
so far: typecheck, tests
13+14+5+102+359+101, both isolation suites both ways, rooms, verify
122/123 (known), the three baselines byte-identical. Owed: `pnpm eval`
and the axe audit (the calendar's three views added to its list), on the
user's word.

### Phase 0 — Baseline

Record the numbers this plan must keep: verify 118, rooms 50, bookings
isolation 31, pipeline isolation 23, the web tests, the three prompt
baselines, the axe audit's count, and `check_availability()`'s rows for
today..+30 on villa, harbor and northwind (saved to `plan/calendar/`, the
Phase 1 diff's left side). Branch `feat/calendar`.

*Done 2026-10-09:* verify 117/118 (the known `roles: an owner changes a
role` failure: villa has a staff member, status.md's open item); rooms
all pass; bookings isolation and pipeline isolation all pass, both ways;
tests 13+14+5+102+359+85; northwind's prompt and villa's and harbor's
tool definitions byte-identical to their baselines (saved to
`plan/calendar/phase0-*`); availability for 2026-10-09..2026-11-08 saved
by `plan/calendar-availability-snapshot.mjs` (villa 93 rows, 14 taken;
harbor 248 rows, 13 taken; 93 and 124 from check_room_availability). The
axe audit's count is the last recorded, 0; it was not re-run (it waits
for the user's word).

### Phase 1 — SQL

`schema-calendar.sql`: `calendar_pending()`, `calendar_slots()` (which
calls `check_availability()`), `calendar_days()`, grants to
`authenticated`. Run by the user in the SQL
editor. Then: the availability diff (byte-identical, Rule 5), and verify
checks 119+: a chat token is refused; a staff token gets rows that equal
a hand count for one seeded week (available, partial, full, closed,
none, a holiday, a two-room pending counted once); 63 days refused;
another tenant's unit gives 0 rows WITH its positive twin.

### Phase 2 — The package and the route

`calendarDays()` / `calendarSlots()` in `@rag/bookings` (a new
`occupancy.ts`: `calendar.ts` is the holiday calendar already), the
constant `MAX_CALENDAR_DAYS = 62` beside it. `GET
/api/t/[tenant]/calendar`, `withTenantRoute` → `requireAdmin(…,
'bookings:read')` → `requireApplication('bookings')`; the view and date
parsed by zod; the range from `lib/calendar-range.ts`. rooms checks
(the roll-up over harbor's real rooms), bookings isolation 32 (one
tenant's calendar never counts another's bookings, both ways).

### Phase 3 — Month view and the legend

The page, the screen, `month-grid.tsx`, the legend, the nav link and
icon, the URL state. Walk: villa and harbor at 1280 and 375, light and
dark, each state present (the walk seeds what it needs and removes it,
like `pnpm eval` does), the `aria-label` sentences, a cell click opening
Day.

### Phase 4 — Week and Day views

The two views; the Day view's bookings from `listBookings()` and its
links. Walk: the week on harbor (rooms × slots) and villa, the Day view
of a clashing pending stay.

### Phase 5 — The walls, the battery, the audit

`pnpm --filter @rag/db verify`, both isolation suites both ways, rooms,
the three baselines diffed, `pnpm eval` once, the axe audit with the
calendar's states added to its list (0 violations). The user's walk.

### Phase 6 — The record

D-103, `status.md`, `whats-done.md`, CLAUDE.md (the layout, S-12, the
22nd SQL file, the commands, a paragraph at the top).

---

## 6. What must not change

- `check_availability()` and `check_room_availability()`'s rows (Rule 5);
  the chatbot's three baselines; the battery's result set.
- The Bookings screen's 14-day list and its legend; the Holidays screen.
- Who may see what: the calendar shows a staff member nothing the
  Bookings screen does not, and no price or money at all.
- The number of `security definer` functions (twelve).

---

## 7. Questions, each with a recommendation · **answered 2026-10-09, every recommendation taken**

1. **Who sees the Calendar?** **Recommend every member** (`bookings:read`):
   it is a view of the bookings a staff member already reads. Holidays
   and slots stay admin-only screens; their *labels* on the calendar are
   readable by any token already.
2. **Past dates?** **Recommend yes, dimmed, counted over today's rooms
   and slots** (§ 2.5), with the footnote. Reconstructing past inventory
   would need history tables nobody has asked for.
3. **"Disabled": Closed only, or past and beyond-horizon too?**
   **Recommend two different marks:** Closed (hatched, a staff decision
   about that date) and dimmed (outside the booking window, a rule about
   time). Folding them together would hide which one staff can undo.
4. **Can the calendar make or change a booking?** **Recommend not in this
   plan.** The Day view links to the Bookings screen, which already
   creates, confirms and cancels with every guard. "Click a free date to
   start a booking" is a good follow-up plan, once this one is used.
5. **Default view?** **Recommend Month** for whole_resort and per_room
   alike; the choice stays in the URL, so a bookmark keeps Week.
6. **Arrow-key navigation in the month grid?** **Recommend not now**
   (§ 4.3): buttons in a table, Tab order, full sentences. Arrow keys
   later if staff ask.
7. **Replace the Bookings screen's chips with the calendar?** **Recommend
   no.** Bookings is where staff act; the calendar is where they look.
   Revisit after the user's walk.
