# Dashboard plan: one page that says how the business is doing, from the rows it already has

> A tenant's staff open five screens to learn five things: are there
> requests waiting (Bookings), what did the chat fail to answer
> (Unanswered), what is in the knowledge base (Knowledge base), which promo
> is working (Promos), who checks in today (Bookings again). This plan adds
> **one page**, `/t/<slug>/admin/dashboard`, that answers them in one look,
> from the rows the database already holds, with a few hand-drawn bar
> charts where a number alone would not show a trend. And a small strip on
> `/platform` for the super user: every tenant's pulse in one table.
>
> Nothing new is collected. Every figure is an aggregate of `conversations`,
> `messages`, `documents`, `chunks`, `bookings`, `promos`, `units`,
> `memberships` and `unanswered_resolutions`, computed by ONE SQL function
> per page in the tenant's timezone, under RLS, and gated on the caller's
> role inside the function.
>
> Written 2026-10-04, against `003ef8b` on `master`. **Status: Phases 0–6
> done 2026-10-05** on `feat/dashboard`; the browser walk (Phase 5) is the
> user's and is owed. § 7's six questions were answered 2026-10-04: every
> recommendation taken, by the user's instruction. The record is D-098;
> the two deviations from this text (selective bar labels, per the
> `dataviz` skill; three window buttons, not a fixed 30) are named there.
>
> Read [§ 0](#0-the-four-rules) first, then § 2, which lists what the
> database can and cannot say.

---

## What this plan covers

| | |
|---|---|
| **In scope** | `tenant_dashboard(p_tenant_id, p_days)` in SQL (one round trip, the tenant's timezone, membership checked inside, money for admins only) and `platform_dashboard()` (security definer, `app_is_super()`); `@rag/pipeline` `dashboard.ts` and a `platformDashboard()` beside the platform functions; `dashboard:read` for any member; `GET /api/t/<slug>/dashboard` and `GET /api/platform/dashboard`; the Dashboard screen (S-11) with its cards and three bar charts drawn as inline SVG by one `bar-chart.tsx` with no library; the Dashboard link first among the staff pages; a Pulse strip on `/platform`; verify checks (a chat token refused, a staff token's counts equal to the service truth, money null for staff, the platform function refused to a tenant token); isolation checks; the record |
| **Out of scope** | Anything the database does not hold today: token cost per tenant (`[openai]` is logged, never stored; § 7 q3), which tool was called per turn (the `tool` event is streamed, never stored), ratings or thumbs; a date picker (one fixed window, § 7 q5); pie charts (§ 7 q4); exports or email digests; per-member activity (who confirmed what: `decision_note` has no author column); any change to the chat, the prompts or the tools (CLAUDE.md rule 1 is untouched: the three baselines stay byte-identical) |

---

## 1. What the request assumes, and what is actually here

| The request says | What the code has | Consequence |
|---|---|---|
| "based on current features and database, which data make sense" | `conversations` (id, created_at), `messages` (role, content, created_at; a refusal is `content = NO_ANSWER`, D-045), `unanswered_resolutions`, `documents` + `chunks`, `bookings` (status, source `web`/`staff`, `booked_date`, `created_at`, `price`, `discount`, `promo_id`, `guest_count`, `unit_id`), `units` (active, capacity), `promos` (+ `promo_uses()`), `memberships` (role) | § 2 lists the figures each table can honestly give. Everything else is out of scope until a column exists |
| "the owner or staff or super admin would see" | Roles are `owner \| admin \| staff` on `memberships` (D-075); a super user is a `platform_admins` row with a tenant-less token (D-076) that reads NO tenant content; every tenant-scoped read is a `security invoker` query under RLS; the ten definer functions each check their caller (D-042) | Two functions. The tenant's is `security invoker` (RLS applies, nothing bypassed) and refuses a caller that is not a MEMBER (a chat token can read `messages` by policy, so the function must say no itself); money figures come back only for `app_is_admin()`. The platform's is `security definer`, the eleventh, gated on `app_is_super()`, returning counts and never content (§ 0 Rule 2) |
| "add simple chart if possible" | No chart library; no markdown library; the chat draws its tables with ~50 lines of its own (D-091). Every screen is hand-written React + one stylesheet | Three bar charts, drawn as inline SVG by one `bar-chart.tsx` of ~60 lines: bars, a baseline, labels, a title for screen readers. No library (§ 0 Rule 3). Before the first chart is written, the `dataviz` skill is read: it is the house style for colour, axes and labels |
| "like bar or pie chart" | A pie chart reads badly for the counts here (3 statuses, 2 sources) and needs a legend; the same numbers as a short bar row read in one glance | Bars only, one orientation (§ 7 q4). A two-value split (web vs staff) is a single stacked bar with its two numbers written on it |
| "today" | "Today" is the tenant's, not the server's (trap 9); `localDate(timezone)` in code, `at time zone` in SQL | Every bucket is cut in SQL with `(ts at time zone v_timezone)::date`, the timezone read from `tenant_applications.config` (or `Asia/Manila` for a tenant without bookings, § 2.4) |

---

## 2. What the database can say, and what it cannot

Each figure below names its source and its gate. A figure that needs a
column the database lacks is listed under "cannot", so nobody invents it.

### 2.1 For every tenant (any member)

| Card | Figure | Source |
|---|---|---|
| **Chat** | conversations in the window, per day (bar chart) | `conversations.created_at` |
| | messages from visitors in the window | `messages` where `role = 'user'` |
| | refusals in the window and the rate (refusals / assistant messages) | `messages` where `content = NO_ANSWER` |
| | **open unanswered questions** (the number staff should act on, with a link) | refusals with no `unanswered_resolutions` row, all time |
| **Knowledge base** | documents, chunks, the newest document's title and date | `documents`, `chunks` |
| **Team** | members by role | `memberships` |

### 2.2 For a tenant with bookings (any member)

| Card | Figure | Source |
|---|---|---|
| **Needs attention** | pending **requests** (web, awaiting Confirm/Decline) | `bookings` where `source = 'web' and status = 'pending'`, counted by group |
| | pending **staff bookings** (born pending since D-095) | `source = 'staff' and status = 'pending'` |
| | pending rows that **clash** with a confirmed night (Confirm would 409) | the request list's `clash`, counted |
| **Today** | check-ins today, confirmed; check-outs today | `booked_date = today`, `upper(during)::date = today`, `status = 'confirmed'` |
| | the next 7 days' confirmed check-ins, as a short list (date, unit, guest) | the same, `booked_date between today and today + 6` |
| **Bookings, window** | bookings by status: confirmed / pending / cancelled (bar row) | `status`, counted by group, `created_at` in the window |
| | by source: web / staff (one stacked bar) | `source` |
| | confirmed stays per week, the last N weeks (bar chart) | `status = 'confirmed'`, bucketed by `booked_date` |
| **Occupancy, next 30 days** (per_room) | confirmed room-nights / (active units × 30), as a percentage and a bar per week | `bookings` confirmed × `units` active |
| **Promos** | each active promo: uses of limit (bar), the discount it gave in the window | `promo_uses()`, `sum(discount)` where `promo_id` |

### 2.3 Money (owners and admins only, § 7 q2)

| Card | Figure | Source |
|---|---|---|
| **Revenue, window** | confirmed revenue: `sum(price)` of confirmed rows whose `booked_date` is in the window (the STORED price, net of discounts, customer-booking Rule 3) | `bookings.price` |
| | pending value: the same for pending rows (what is waiting on a decision) | |
| | discounts given: `sum(discount)` confirmed | `bookings.discount` |
| | revenue per week, the last N weeks (bar chart, the same bars as stays with ₱ instead of counts) | |

Every amount is centavos from the database, text once for a person
(`lib/money.ts`). The function never averages: an average nightly rate is
a figure the owner can compute in their head from two shown numbers, and
a stored average would drift the day a booking is cancelled.

### 2.4 The platform strip (super users only)

One row per live tenant: members, documents, conversations in 30 days,
refusals in 30 days, open unanswered, pending requests, confirmed stays in
30 days; archived tenants in a second, folded list with their archive date.
Counts only. **No content, no guest, no money:** a super user reads no
tenant's content unless they make themselves an owner there (D-076), and a
total revenue across tenants would be a number the platform has no
business holding.

### 2.5 What the database cannot say today

- **Cost.** `[openai]` logs tokens in and out per call and never stores
  them. A cost card needs a `usage` column on `messages` written by
  `answer.ts`, which is a pipeline change with its own plan (§ 7 q3).
- **Which questions were asked most.** The questions are there
  (`messages.role = 'user'`) but grouping them is text clustering, and a
  list of raw visitor messages on a dashboard is a privacy question before
  it is a feature. Out.
- **Who did what.** `decision_note` has no author; `bookings` has no
  `created_by`. A per-member panel waits for those columns.
- **Response time.** `messages.created_at` is the save time of both
  messages in one turn, not the model's latency. Out.

---

## 0. The four rules

### Rule 1 — One SQL function, one round trip, the tenant's day

`tenant_dashboard(p_tenant_id bigint, p_days int)` returns ONE `jsonb`
with every card's figures and every chart's buckets, computed in SQL in
the tenant's timezone. The screen draws; it never adds, divides or
re-buckets (the occupancy percentage and the refusal rate are computed in
SQL too, as numerics rounded to one decimal). A second screen or a future
export reads the same function and shows the same numbers.

### Rule 2 — The function gates its caller; the platform's reads counts only

The tenant function is `security invoker`: every read runs under the RLS
the token already has, so it cannot see more than the token could. But a
chat token can read `conversations` and `messages` by policy, so the
function refuses any caller that is not `app_is_staff()` of that tenant
(`insufficient_privilege`), and returns the money keys as `null` unless
`app_is_admin()`. `platform_dashboard()` is `security definer` with
`search_path = ''` and `app_is_super()` checked first (the D-042 shape);
its row type is counts and dates and nothing else, and verify asserts a
tenant token cannot call it.

### Rule 3 — No chart library; a chart is a function of its numbers

`bar-chart.tsx` takes `{ label, value }[]`, a unit (`count` | `pesos` |
`percent`) and a title, and returns inline SVG: one `<rect>` per bar, a
baseline, the value above each bar, the label below, `<title>` for
screen readers and a `<table>` fallback under `visually-hidden`. Colours
are the theme's custom properties, so a tenant's accent is its bar colour
(D-030). About sixty lines. The `dataviz` skill is read before the first
line is written, for the house rules on colour, baseline and labels.

### Rule 4 — The chatbot, the prompts and the tools do not change

Nothing in `buildPrompt()`, `tools.ts`, `dates.ts` or `language.ts` is
touched. Phase 5 diffs the three baselines and runs the battery once
because `@rag/pipeline` gains a file, and expects the known count.

---

## 2b. Traps

### 2b.1 Counting requests by row double-counts a stay

A 3-night, 2-room request is 6 `bookings` rows and ONE request. Every
"bookings" count in § 2.2 is `count(distinct coalesce(group_id::text,
'b' || id::text))`, the same expression `promo_uses()` uses (D-097);
revenue and occupancy sum ROWS, because a row is a night.

### 2b.2 Two windows, not one

"Last 30 days" is `created_at`-based for chat and for "bookings made";
"next 30 days" is `booked_date`-based for check-ins and occupancy; the
weekly stays chart is `booked_date` in the past window. Each key in the
JSON names its window (`chat.days`, `stays.weeks`, `occupancy.from/to`)
so the screen's captions are read, not assumed.

### 2b.3 A chat token must get a refusal, not an empty dashboard

Trap 12: a check that passes on zero rows proves nothing. verify asserts
the chat token gets `42501`, AND the staff token's `conversations` count
equals a service-role count on the probe tenant with at least one
conversation in it.

### 2b.4 Occupancy over a window with retired rooms

A unit retired mid-window would shrink the denominator for the whole
window. The denominator is active units NOW; the caption says so. A
tenant with zero active units has no occupancy card, not a division.

### 2b.5 "Today" for a tenant without bookings

Northwind has no `tenant_applications` row and so no timezone. The
function falls back to `Asia/Manila` (the app's default everywhere else,
`bookingsConfig()`'s own fallback) and the JSON says `timezone`, so a
screen can show it.

### 2b.6 The super user's strip must not become a leaderboard of money

§ 2.4: counts only. If revenue per tenant is ever wanted on the platform,
it is its own decision with the tenants' consent, not a column added in
passing.

---

## 3. The data model

No new table. `packages/db/sql/schema-dashboard.sql` (the 19th file),
idempotent: two functions and their grants.

```sql
-- tenant_dashboard(p_tenant_id bigint, p_days int default 30) returns jsonb
--   security invoker, search_path = ''; refuses unless app_is_staff() for p_tenant_id
--   (service_role allowed, for the tools). p_days between 7 and 90.
--   {
--     timezone, today, days,
--     chat:      { conversations, visitorMessages, refusals, refusalRate, openUnanswered,
--                  perDay: [{ day, conversations }] },
--     knowledge: { documents, chunks, newest: { title, createdAt } | null },
--     team:      { owners, admins, staff },
--     bookings:  null | {
--       attention: { pendingRequests, pendingStaff, clashing },
--       today:     { checkIns, checkOuts, next7: [{ date, unit, guest }] },   -- guest: NAME only, staff already see it
--       window:    { confirmed, pending, cancelled, web, staff },             -- distinct stays, created in the window
--       stays:     { weeks, perWeek: [{ weekOf, stays }] },
--       occupancy: null | { from, to, activeUnits, roomNights, percent, perWeek: [{ weekOf, percent }] },
--       promos:    [{ id, name, uses, maxUses, discount }],
--       money:     null | { confirmed, pending, discounts, perWeek: [{ weekOf, confirmed }] }   -- admins only, centavos
--     }
--   }
-- platform_dashboard() returns table (tenant_id, slug, business_name, archived_at, members, documents,
--   conversations_30d, refusals_30d, open_unanswered, pending_requests, confirmed_stays_30d)
--   security definer, search_path = ''; refuses unless app_is_super() (service_role allowed).
```

Grants: both revoked from `public, anon, authenticated` then granted to
`authenticated, service_role`, the schema-auth step-6 rule. The `Database`
type gains both under `Functions`.

---

## 4. The page

```
┌ Needs attention ─────────────────────────────────────────┐
│ 3 requests waiting · 1 staff booking unconfirmed · 1 clash │  → Bookings
├ Today (Asia/Manila, 4 Oct) ─────────────────────────────┤
│ 2 check-ins · 1 check-out · next 7 days: Thu Garden Room, Ana …│
├ Chat, last 30 days ────────────┬ Knowledge base ─────────┤
│ 128 conversations  ▂▃▅▂▇▃▁ …   │ 8 documents · 86 chunks │
│ 410 visitor messages           │ newest: "Rates" 2 Oct   │
│ 11 refusals (2.7 %) · 4 open → │ Team: 1 owner, 2 admins │
├ Bookings, last 30 days ────────┴─────────────────────────┤
│ confirmed 14 · pending 3 · cancelled 2      web ▇▇▇▇ staff ▇▇ │
│ stays per week  ▃▅▇▆  (booked_date)                       │
├ Occupancy, next 30 days (per_room) ──────────────────────┤
│ 38 % · 46 of 120 room-nights · per week ▅▃▇▂               │
├ Promos ──────────────────────────────────────────────────┤
│ Off season ▇▇▇▇▇▇ 6 uses · SUMMER500 ▇ 1 of 1 · ₱3,200 off │
├ Revenue, last 30 days (owners and admins) ───────────────┤
│ ₱186,000 confirmed · ₱42,000 pending · ₱3,200 discounts    │
│ per week ▃▅▇▆                                              │
└──────────────────────────────────────────────────────────┘
```

A tenant without bookings sees the first three cards. A staff member
sees everything but Revenue. Every count that is a to-do is a link to the
screen that does it. The page holds no data on the server: the screen
calls the route after the session check, like the other admin screens.

---

## 5. Phases

### Phase 0 — Baseline
Every suite on `003ef8b`; the three baselines diffed; the battery once.

### Phase 1 — SQL
`schema-dashboard.sql`; the typed `Functions`; verify: a chat token is
`42501`; a staff token's chat counts equal the service truth on the probe
tenant (≥ 1 conversation, ≥ 1 refusal); money keys `null` for the staff
probe user and present for the owner; a tenant token calling
`platform_dashboard()` is `42501`, the super probe gets every live tenant
with counts matching the service truth and no content column.

### Phase 2 — `@rag/pipeline`
`dashboard.ts`: `tenantDashboard(tenant, days)` (a typed shape over the
JSON, `days` clamped 7–90) and `platformDashboard(platform)`; tests on
the parsing; the pipeline isolation suite gains "a platform token calls
`tenant_dashboard()` and gets `42501`" and "A's dashboard never counts B's
rows" (two probe tenants, one with content).

### Phase 3 — Routes and permissions
`dashboard:read` (STAFF, so every member); `GET /api/t/[tenant]/dashboard?days=`
on `withTenantRoute()` + `requireAdmin(…, 'dashboard:read')`;
`GET /api/platform/dashboard` on `withPlatformRoute()`.

### Phase 4 — Screens
`bar-chart.tsx` (after reading the `dataviz` skill); `dashboard-screen.tsx`
and `app/t/[tenant]/admin/dashboard/page.tsx` (S-11); the nav's first
staff link is Dashboard (§ 7 q1); the Pulse strip on `platform-screen.tsx`.
Phone width: cards stack, charts scale with `viewBox`.

### Phase 5 — The walls and the walk
verify, both isolation suites both ways, rooms, the three baselines, the
battery once (Rule 4). The walk, by the user: harbor as staff (no
Revenue), as owner (Revenue), villa, northwind (three cards), the
platform strip; 360 px.

### Phase 6 — The record
D-098, CLAUDE.md (header, layout, the sql count, the eleventh definer
function in rule 8), flow.md § 5, status, whats-done.

---

## 6. What must not change

- The three prompt baselines, the battery count, every tool's text.
- No new table, no new column, no row written by the dashboard.
- A chat token reads no aggregate; a platform token reads no content.
- The other admin screens and their routes.

---

## 7. Questions, each with a recommendation · **answered 2026-10-04, every recommendation taken**

1. **Is the Dashboard the landing page after login?** Today `/admin` is
   the knowledge base and the first link. **Recommend**: the Dashboard
   becomes the FIRST staff link and the login form on any admin page
   stays where it is; `/admin` keeps its URL (bookmarks, the walk
   scripts, CLAUDE.md all name it). No redirect.
2. **Money for staff?** A staff member sees prices on every booking row
   already. **Recommend owners and admins only** for the totals: a sum
   over a month is a different fact from one row, and `money` is the one
   key the function withholds by role.
3. **Cost per tenant?** Wanted, not possible: tokens are logged, not
   stored. **Recommend a separate small plan**: a `usage jsonb` column on
   `messages` written by `answer.ts`, then a Cost card here. Not in this
   plan, so the chat pipeline stays untouched.
4. **Pie charts?** **Recommend none.** Every split here is two or three
   values; a short bar row with the numbers on it reads faster than
   wedges with a legend, and one chart component is less to understand.
5. **A date picker?** **Recommend one fixed window, 30 days**, with
   `?days=7|30|90` on the route so a picker is a one-line addition later.
   Captions name the window on every card (§ 2b.2).
6. **What does the super user see?** **Recommend counts only** (§ 2.4),
   one row per tenant, archived ones folded: enough to notice a tenant
   that went quiet or one drowning in requests, and nothing a tenant
   would mind the platform reading.
