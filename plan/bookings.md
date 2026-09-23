# Bookings plan — the first application, and the first tool call

> Two things built in order. First, a **booking manager** for a tenant's staff,
> which is ordinary CRUD. Second, **one read-only tool**, `check_availability`,
> that the chatbot can call to answer from live data rather than from a
> document.
>
> Written 2026-09-24, against commit `4653f7b` on `master`, after tenancy
> ([`plan.md`](../plan.md), Phases 0–8) was complete. Read
> [§ 0](#0-the-three-rules) before touching anything, and
> [§ 2.1](#21-villa-does-not-have-rooms) before designing a table.

---

## What this plan covers

| | |
|---|---|
| **In scope** | A code registry of **applications** plus a `tenant_applications` table saying which tenant has which one; a `@rag/bookings` package (domain logic, server-only) with its schema; admin routes and an admin screen at `/t/<slug>/admin/bookings`; tool-calling support in `@rag/openai`, hand-written, streaming and non-streaming; one chatbot tool, `check_availability`; the D-008 short circuit reworked so a tool can answer when no chunk matched; tool calls shown in the chat UI next to the sources; battery and isolation cases for all of it |
| **Out of scope** | Guests booking through the chatbot (a `request_booking` tool). It is listed in [§ 7](#7-what-this-unblocks) with the seam this plan leaves for it. Also out: prices computed by a tool, payments, a calendar widget, several unit types per tenant, email or SMS confirmations, Messenger |

**Three decisions, already agreed in conversation** (all logged in [§ 5](#5-decisions-to-log)):

1. **Domain logic goes in a package; HTTP stays in the app.** `@rag/bookings`
   exports functions such as `checkAvailability(tenant, …)`. The admin Route
   Handlers and the chatbot's tool executor **both call those functions
   directly.** The chatbot never makes an HTTP request to this app's own
   `/api`.
2. **Applications are a registry in code, and enablement is a table.** An
   application is code: tool definitions, an executor and its tables. A row
   cannot create one. `tenant_applications (tenant_id, application_key)` only
   says which tenant has which application switched on.
3. **The chatbot's tools are read-only in this plan.** The chat route is open,
   with no auth (plan.md Phase 6, step 4). A write tool on an open route would
   let anyone on the internet write to the database through the model.

---

## 0. The three rules

### Rule 1 — The grounding block stays byte-identical, and Northwind's prompt stays byte-identical too

D-017's grounding block and D-029's persona line are measured wording, so this
plan does not reword them. Tools add **one paragraph after the context block,
and only when the tenant has tools.** Northwind has none, so Northwind's prompt
is the same string it is today, byte for byte. Phase 0 captures that string,
and Phase 6 asserts it is unchanged.

Frozen for the duration, as in plan.md § 0: `MATCH_COUNT`, `CANDIDATE_COUNT`,
`RRF_K`, `MIN_SIMILARITY`, `MAX_HISTORY`, `REWRITE_MAX_TOKENS`, `NO_ANSWER`.

### Rule 2 — Tenant isolation extends to every new table, and the model never supplies a tenant

Rule 6 of `CLAUDE.md` applies unchanged to `tenant_applications`, `units`,
`slots` and `bookings`:

- `tenant_id` on every row;
- a composite FK wherever a child points at a parent;
- `.eq('tenant_id', tenant.id)` on every query, and `p_tenant_id` with no
  default on every `.rpc()`.

**One addition, specific to tools.** Tool arguments are written by the model,
and the model reads text a stranger typed. So a tool's argument schema has
**no tenant field, no unit id and no booking id.** The executor gets `tenant`
from the server's `TenantContext`, the same object the chat route already
resolved. A prompt that says "check availability for tenant 1" has nothing to
put it in.

### Rule 3 — A tool never tells the model anything the chat user may not see

Anything a tool returns goes into the prompt, and a prompt-injected model can
recite it. So the rule is about the **result shape**, not about the model
behaving. `check_availability` returns dates, slot names and `open` or
`taken`. It never returns guest names, phone numbers, notes, booking ids or
counts of guests. PII that is not in the result cannot leak through the
result. Phase 2 makes this a type; Phase 6 makes it a test.

---

## 1. The data model

### 1.1 Applications

```sql
create table tenant_applications (
  tenant_id       bigint not null references tenants(id) on delete cascade,
  application_key text   not null,
  config          jsonb  not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  primary key (tenant_id, application_key),
  -- The registry is code (packages/rag/src/applications.ts). The database lists the
  -- same keys so a typo'd row fails on insert instead of silently enabling nothing.
  constraint tenant_applications_key check (application_key in ('bookings'))
);
```

**There is no `enabled` column.** Having a row means the application is enabled;
deleting the row turns it off. An `enabled boolean` would give three states
(no row, row false, row true), one of them redundant, and it would be one more
thing every query has to filter on.

`config` for `bookings` holds exactly one key in this plan:
`{ "timezone": "Asia/Manila" }`. The key is validated when it is written (an
IANA name that Postgres accepts) and is **required**. Section 2.3 explains why
there is no default.

### 1.2 Bookings

```sql
-- A thing that can be booked. Villa has exactly one: the whole property.
create table units (
  id         bigint generated always as identity primary key,
  tenant_id  bigint not null references tenants(id) on delete cascade,
  name       text   not null,                    -- "Whole property"
  created_at timestamptz not null default now(),
  unique (id, tenant_id),                        -- for the composite FKs below
  unique (tenant_id, name)
);

-- A named time window the tenant sells. Villa has three.
create table slots (
  id          bigint generated always as identity primary key,
  tenant_id   bigint   not null references tenants(id) on delete cascade,
  name        text     not null,                 -- "Overnight"
  start_time  time     not null,                 -- 14:00, in the tenant's timezone
  duration    interval not null,                 -- 22 hours
  created_at  timestamptz not null default now(),
  unique (id, tenant_id),
  unique (tenant_id, name),
  constraint slots_duration_positive check (duration > interval '0')
);

create table bookings (
  id          bigint generated always as identity primary key,
  tenant_id   bigint    not null references tenants(id) on delete cascade,
  unit_id     bigint    not null,
  slot_id     bigint    not null,
  booked_date date      not null,                -- the date the slot STARTS on
  during      tstzrange not null,                -- computed in SQL, never sent by a client
  status      text      not null default 'confirmed',
  guest_name  text      not null,
  guest_phone text,
  guest_count int,
  notes       text,
  created_at  timestamptz not null default now(),
  constraint bookings_status check (status in ('pending', 'confirmed', 'cancelled')),
  foreign key (unit_id, tenant_id) references units (id, tenant_id) on delete cascade,
  foreign key (slot_id, tenant_id) references slots (id, tenant_id),   -- no action, not cascade

  -- THE constraint of this plan. Two live bookings of the same unit may not
  -- overlap in time. Postgres refuses the second insert, whatever the
  -- application code did or did not check first (§ 2.2).
  constraint bookings_no_overlap exclude using gist (
    unit_id with =,
    during  with &&
  ) where (status <> 'cancelled')
);
```

This needs `create extension if not exists btree_gist;`, because `unit_id with
=` in a GiST index needs the btree operator class. Supabase ships the
extension, but it has to be enabled.

**Why `slot_id` does not cascade.** Deleting a slot the tenant no longer
sells must not cascade away the bookings made under it. The booking history is
the tenant's record of who came. The FK uses the default `no action`, not
`restrict`. `no action` is checked at the end of the statement, so deleting a
whole tenant, which cascades to both `slots` and `bookings` in one statement,
still works. `restrict` is checked immediately, and would block that delete.

### 1.3 The two SQL functions

Both follow the conventions of `schema-tenancy.sql`: the first parameter is the
tenant, it has no default, and the filter is inside the function.

- **`check_availability(p_tenant_id, p_from date, p_to date)`** returns one row
  per (date, unit, slot) in the range, with `status` set to `open` or `taken`.
  It never returns who holds a slot. Rule 3 is enforced in SQL, the layer
  closest to the data.
- **`during` is computed by a `before insert or update` trigger**
  (`bookings_compute_during`), from the slot and the tenant's timezone.
  *Deviation, Phase 1:* this was first planned as a `create_booking()` RPC. A
  trigger is stronger, because a plain `.insert()`, a script, or someone typing
  in the SQL editor all get the same range, and a supplied `during` is
  overwritten rather than trusted. The trigger also refuses a booking for a
  tenant without the application. The range expression it uses (as
  `slot_range()`) is:

  ```sql
  tstzrange(
    (p_date + s.start_time) at time zone v_tz,
    (p_date + s.start_time + s.duration) at time zone v_tz,
    '[)'
  )
  ```

  Wall-clock time becomes an absolute instant **in Postgres**, which has the
  full IANA timezone database. In JavaScript, turning a local time into UTC
  with only `Intl` is a known source of off-by-one-hour bugs (§ 2.3).

`during` is **half-open, `[)`**. An Overnight that ends at 12:00 and a slot that
starts at 12:00 do not overlap. A closed range `[]` would make back-to-back
bookings collide on a single shared instant.

---

## 2. The traps that will actually cost you time

### 2.1 Villa does not have rooms

It is tempting to build `rooms` and `room_types`. But
`sample-documents/02-rates-and-schedules.md` describes something else:

> Villa Amihan offers three booking slots: Day Tour, Overnight, and the 22-Hour
> Whole Day. **Only one slot is sold per day**…
> The Overnight slot runs from 2:00 PM to 12:00 noon the following day.

The whole property is one bookable thing, sold in time windows that cross
midnight. A rooms model has nowhere to put "Overnight on the 1st blocks a Day
Tour on the 2nd".

**Time ranges** do handle it. Store each booking as the instant range it
actually occupies, and let the exclusion constraint compare ranges:

| Booked | Occupies (Asia/Manila) | Blocks |
|---|---|---|
| Day Tour, Oct 1 | Oct 1 08:00 → Oct 1 17:00 | Overnight Oct 1 (starts 14:00), 22-Hour Oct 1 |
| Overnight, Oct 1 | Oct 1 14:00 → Oct 2 12:00 | Day Tour Oct 2 (starts 08:00), 22-Hour Oct 2 |
| 22-Hour, Oct 1 | Oct 1 08:00 → Oct 2 06:00 | Everything on Oct 1; nothing on Oct 2 |

These are the document's own rules, and **not a single one is written as
code.** The same model also covers a hotel later: each room is a `unit`, with
one "Night" slot from 14:00 to 12:00 the next day.

> **Ask the owners before Phase 1** (see [§ 8](#8-open-questions)). Can a Day
> Tour on the 2nd start at 08:00 after an Overnight on the 1st that ends at
> 12:00? By the ranges it cannot, which is also what "one slot per day"
> implies. And is there a turnover gap? The document says "the pool must be
> drained and refilled between bookings". If there is a gap, it becomes a
> `turnover interval` on `slots`, added to the end of `during`. It is not a
> rule written in TypeScript.

### 2.2 "Check, then insert" double-books

The obvious `createBooking` reads availability and inserts if the slot is
open. Two staff members, or a staff member and a future chatbot tool, can both
read "open" before either one inserts. Both inserts then succeed. No error is
raised, and two groups turn up at the gate.

The exclusion constraint in § 1.2 is the only fix that does not depend on
timing. `create_booking` just inserts, and Postgres raises `23P01`
(`exclusion_violation`) for the loser. `@rag/bookings` maps exactly that code
to a `BookingConflictError` (HTTP 409), and every other error propagates as
itself. It is the same approach as the composite FKs in tenancy: Postgres
refusing, not code remembering.

### 2.3 Timezones, three separate times

1. **Storing a booking.** "Overnight on 1 October" is 06:00Z, not 14:00Z. That
   is why `during` is computed in SQL from `config.timezone` (§ 1.3), and why
   a missing timezone is an error rather than UTC: a UTC default shifts every
   booking by eight hours, and nothing errors.
2. **Resolving "this Saturday".** The model has no clock. Unless the prompt
   gives it today's date, it resolves relative dates against its training
   data, confidently and a year or more off. So the tools paragraph (§ 2.5)
   includes `Today is 2026-10-03 (Saturday), Asia/Manila`. The date is
   computed in the **tenant's** timezone, not the server's. A server in UTC at
   23:30 Manila time already thinks it is the next day.
3. **Validating the answer.** `@rag/bookings` rejects `p_from` in the past, and
   `p_to` more than `MAX_AVAILABILITY_DAYS` after `p_from`, using the same
   tenant-local "today".

### 2.4 D-008's short circuit would make the tool unreachable

Today, when no chunk clears `MIN_SIMILARITY`, `answer.ts` returns `NO_ANSWER`
**without calling OpenAI**. "Is the villa free on the 12th?" may well match
nothing, so the refusal would come back before the tool is ever offered.

Removing the short circuit brings back the failure D-008 prevents: the model
answering from training data when it was given no context. So it is reworded,
not removed:

> **With zero matching chunks, the model's reply is accepted only if it called
> a tool on this turn. Otherwise the reply is replaced with `NO_ANSWER`.**

For a tenant with no tools, like Northwind, that is exactly D-008. The model is
never called, because no tools means nothing could make its reply acceptable.
For a tenant with tools, the only possible replies with zero chunks are the
refusal or an answer built from a tool result. The cost is one OpenAI call per
zero-match question on tool tenants, where today it is free. Phase 6 measures
it.

### 2.5 The documents tell the model to message the owners

`04-booking-and-payment.md` says: *"The owners reply with whether the date is
open."* A question about availability retrieves that chunk. The model can
answer from it, correctly by the grounding rule ("message 0917-845-2290"),
and never call the tool. Nothing errors, and the new feature silently does
nothing.

So the tools paragraph is specific. It is appended **after** `--- END CONTEXT ---`
and only when there are tools:

```
You can also call tools. A tool result is context too, and the same rules apply
to it. For whether a date or slot is open, ALWAYS call check_availability; the
documents cannot know. Never state availability without a tool result from
this turn. If the user has not given a date, ask for one before calling.
Today is {tenantToday} ({weekday}), {timezone}.
```

Only the battery can tell whether this wording works (Phase 6). A case that
asks about availability passes only if **the tool was called**, not just if
the reply looks right.

### 2.6 Tool calls are not saved, and that is fine for now

`messages.role` is `check (role in ('user','assistant'))`. The tool-call and
tool-result messages of a turn are **not saved**. Only the final assistant
text is. The slot-filling flow in `todo.md` still works across turns, because
the dates the user typed are in saved `user` messages. The next turn calls
the tool again, which is also what you want for data that changes. What is
lost is the audit trail of what the tool said. Section 7 notes the seam:
a `tool_calls jsonb` column on the assistant row.

### 2.7 Streaming a tool call is streaming JSON in pieces

With `stream: true`, a tool call arrives in fragments, keyed by `index`:

```
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","function":{"name":"check_availability","arguments":""}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"date_fr"}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"om\":\"2026-10-12\"}"}}]}}]}
data: {"choices":[{"finish_reason":"tool_calls"}]}
```

The `arguments` string is not JSON until the last fragment arrives. Parse it
once, after `finish_reason`, and never per delta. `chatStream` already has the
event buffering this needs (the split-event bug it documents). It gains an
accumulator per `index`.

**The interaction with § 2.4.** When chunks matched, content deltas are
forwarded to the browser as they arrive, exactly as today. When **no** chunk
matched, content is **buffered**, because until the stream ends we do not know
whether a tool was called, so we do not know whether the text is allowed out.
With zero matches, a streamed reply that turns out to be a refusal would
otherwise already be on screen before the rule replaces it.

---

## 3. The phases

Nine phases, numbered 0–8. Phases 0–4 are the booking manager and touch neither
the prompt nor the chat path. If you stop after Phase 4, you have a working
booking tool for staff and the bot is unchanged.

### Phase 0 — Baseline

1. Both tenants loaded as `CLAUDE.md` rule 1 requires.
2. `pnpm eval pre-bookings | tee plan/baseline/eval-pre-bookings.txt`. Expect
   **9/10**.
3. `pnpm --filter @rag/pipeline isolation | tee plan/baseline/isolation-pre-bookings.txt`. Expect **11/11**.
4. `pnpm --filter @rag/db verify | tee plan/baseline/verify-pre-bookings.txt`. Expect **14/14**.
5. Capture Northwind's exact prompt:
   `pnpm --silent --filter @rag/pipeline prompt-snapshot > plan/baseline/northwind-prompt-pre-bookings.txt`.
   `tools/prompt-snapshot.mjs` feeds `buildPrompt()` fixed chunks and fixed
   history, so the output depends only on the prompt code and the tenant row,
   not on retrieval. Phase 6 diffs against it (Rule 1).

**Done when:** four files are committed with the expected numbers. A different
number means something moved; stop and find it first.

### Phase 1 — Schema

1. `packages/db/sql/schema-bookings.sql`: new, idempotent, run once in the
   Supabase SQL editor after the three existing files. Order: `btree_gist` →
   `tenant_applications` → `units` → `slots` → `bookings` with its composite FKs
   and exclusion constraint → indexes `(tenant_id, booked_date)` → the two
   functions → RLS on with no policies (D-006, same posture as every table).
2. Seed Villa at the bottom, idempotently: a `tenant_applications` row with
   `{"timezone":"Asia/Manila"}`, one unit `Whole property`, and three slots
   (Day Tour 08:00 + 9h, Overnight 14:00 + 22h, 22-Hour 08:00 + 22h), taken
   from `02-rates-and-schedules.md`. **Northwind gets nothing.**
3. Hand-edit `packages/db/src/database.types.ts`, as its header explains.
4. Extend `packages/db/tools/verify.mjs` from 14 checks to about 20, still with
   no API key:
   - an overlapping second booking fails with `23P01`, and must *fail* to pass;
   - a cancelled booking frees the slot: the same insert then succeeds;
   - Overnight Oct 1 blocks Day Tour Oct 2; Day Tour Oct 1 does **not** block
     Overnight Oct 2;
   - a booking whose `unit_id` belongs to another tenant fails on the composite FK;
   - `check_availability(<northwind id>, …)` returns **zero rows**;
   - `during` for "Overnight, 2026-10-01, Asia/Manila" is exactly
     `["2026-10-01 06:00:00+00","2026-10-02 04:00:00+00")`.

**Done when:** verify passes about 20/20, and the exact `during` string is
pasted into `whats-done.md` as observed.

> **Done 2026-09-24: 28/28.** That is 14 existing checks plus 14 new ones.
> "About 20" was an estimate made before the checks were written.

### Phase 2 — `@rag/bookings`

1. `packages/bookings/`: `server-only`, depends on `@rag/db` only. Its
   `package.json` scripts carry `--conditions=react-server` (`CLAUDE.md` rule 4).
2. Exports, all with `tenant` **required and first** (D-027):
   `checkAvailability(tenant, { from, to })`, `listBookings(tenant, { from, to })`,
   `createBooking(tenant, input)`, `cancelBooking(tenant, id)`,
   `listUnits(tenant)`, `listSlots(tenant)`, `bookingsConfig(tenant)`.
3. Two error classes, each carrying `status` because that is what
   `lib/route.ts` maps: `BookingInputError` (400) for bad dates or ranges, and
   `BookingConflictError` (409) for `23P01` and **only** `23P01`.
4. **The availability result type has no PII field** (Rule 3):
   ```ts
   export interface SlotAvailability { date: string; unit: string; slot: string; status: 'open' | 'taken' }
   ```
   `listBookings`, the admin view that does include guest details, returns a
   **different** type. The tool executor in Phase 6 imports only the first.
5. `cancelBooking` returning `false` means "not yours **or** not there".
   Indistinguishable on purpose (plan.md Phase 3, step 6).
6. Validation lives **here**, not only at the route, because this package has
   two callers and only one of them is a Route Handler. The checks are
   hand-written: date shape, `from <= to`, the `MAX_AVAILABILITY_DAYS` cap, not
   in the past.
7. Unit tests (vitest) for the validation, which is pure. Add isolation cases
   to `packages/rag/tools/isolation.mjs` (or a sibling in this package):
   Northwind sees no Villa availability; Northwind cannot cancel a Villa
   booking id; Northwind creating a booking on Villa's unit id fails.

**Done when:** typecheck and tests are clean, and isolation goes from 11 to
about 14, all passing.

### Phase 3 — Applications and admin routes

1. `packages/rag/src/applications.ts`: the registry,
   `APPLICATIONS = { bookings: { … } } as const`, and
   `enabledApplications(tenant): Promise<ApplicationKey[]>`. It filters
   `tenant_applications` on `tenant_id` and ignores any key that is not in
   the registry. The `check` constraint should make that impossible, but a
   key the code does not know about is never offered.
2. `apps/web/lib/applications.ts`: `requireApplication(tenant, 'bookings')`
   throws a **404**, not a 403. "This tenant has no bookings application" must
   look the same as "no such route", so it reveals nothing about another
   tenant's setup.
3. `lib/route.ts`: pass `400` and `409` through. Today only 401 and 429 are
   passed through, and anything else below 500 becomes a 500. Still one place
   that maps errors.
4. Routes, each one `withTenantRoute` → `requireAdmin` → `requireApplication` →
   zod → `@rag/bookings`:
   `GET/POST /api/t/[tenant]/bookings`, `DELETE /api/t/[tenant]/bookings/[id]`
   (which cancels, never hard-deletes), `GET /api/t/[tenant]/bookings/availability`,
   `GET /api/t/[tenant]/bookings/setup` (units and slots, for the form).
5. README curl examples, in the same commit.

**Done when:** these curls return what they should, with real messages:

| Request | Expected |
|---|---|
| Create a booking | 201 |
| The same booking again | 409, naming the conflict |
| The same route for `northwind` | 404 |
| No cookie | 401 |

### Phase 4 — The admin screen

1. `app/t/[tenant]/admin/bookings/page.tsx`: a Server Component that resolves
   the tenant and the application (`notFound()` if it is not enabled), then a
   Client Component `bookings-screen`.
2. A date-range list grouped by date, showing every slot as open or taken. A
   taken slot shows its guest name, and only here, behind admin. Also a create
   form (unit, slot, date, guest name, phone, count, notes) and a cancel
   button. No calendar library. A list is enough to prove the model, and it
   stays readable.
3. A link from the knowledge-base admin page, rendered only when the
   application is enabled.
4. The 409 message reaches the form as-is (`CLAUDE.md`: errors surface the real
   message).
5. Walk it in the browser: book Overnight on a date, see Day Tour on the next
   date become `taken`, cancel it, see both open again, and try `/t/northwind/admin/bookings` (404).

**Done when:** the walk passes by hand, and
`grep -ri "service_role\|guest_phone" apps/web/.next/static/` returns nothing.

### Phase 5 — Tool calling in `@rag/openai`

Still no pipeline changes. This phase is only the transport, and it is hand-written
(D-002). No SDK, and no framework's agent loop.

1. Types: `ToolDefinition` (the OpenAI `{ type: 'function', function: { name,
   description, parameters } }` shape), `ToolCall { id, name, arguments: string }`,
   and `ChatMessage` widened to include `{ role: 'assistant', content: string | null,
   tool_calls }` and `{ role: 'tool', tool_call_id, content }`. `ChatRole`'s
   comment ("nothing here uses them") gets rewritten, because now something does.
2. `chat(messages, { tools })` returns `{ content, toolCalls }` when `tools` is
   passed, and a plain string otherwise. The rewriter and every existing call
   site stay unchanged. Do it with an overload, not a union return type every
   caller has to narrow.
3. `chatStream(messages, onDelta, { tools, holdContent })`: the § 2.7
   accumulator. It returns `{ content, toolCalls }`. `holdContent: true`
   buffers content rather than calling `onDelta`, which is the zero-match case
   from § 2.7.
4. Unit tests with **recorded** SSE fixtures, and no API key: a tool call split
   across three events; an event split across two network chunks, inside the
   arguments string; two parallel tool calls with interleaved indexes; content
   with no tool call; a stream with no `[DONE]`. The last case must still
   throw, as it does today.
5. The `[openai]` cost log line gains the tool-call count, for example
   `[openai] chat: 812 in + 24 out, 1 tool call`.

**Done when:** tests pass, and one real call made by hand with a dummy tool
returns a parsed `ToolCall` whose `arguments` string passes `JSON.parse`.

### Phase 6 — The tool, in the pipeline, then measure

1. `packages/rag/src/tools.ts`:
   - `toolsFor(tenant)` builds the definitions per request. `check_availability`
     takes `{ date_from, date_to? }` in `YYYY-MM-DD` form, and its description
     lists the tenant's **actual slot names**, read from `listSlots(tenant)`.
     There is no tenant, unit or booking id among its parameters (Rule 2).
   - `executeTool(tenant, call)` looks up the owning application in the
     registry and **checks again** that the tenant has it enabled. The executor
     does not trust that the model was only offered this tenant's tools. It
     parses `arguments`, then calls `checkAvailability`.
     A `BookingInputError` or a JSON parse failure becomes the tool result
     `{"error": "<message>"}`, so the model can ask the user for a proper date.
     **Every other error propagates**, which means no swallowing (architecture.md § 9).
2. `constants.ts`: `MAX_TOOL_ROUNDS = 2` (one call, plus one for a corrected
   date), and `MAX_AVAILABILITY_DAYS = 31`. Both are provisional. Record the
   measured value when there is one.
3. `prompt.ts`: `buildPrompt(tenant, chunks, history, question, tools?)`. It
   adds the § 2.5 paragraph after `--- END CONTEXT ---` **only when `tools`
   is non-empty**. The grounding block is not touched.
4. `answer.ts`: the loop. Call the model with tools, run each tool call, append
   the tool messages, and call again, up to `MAX_TOOL_ROUNDS`. Then apply
   § 2.4's rule. `Answer` and the SSE stream gain `toolCalls: { name, args,
   result }[]`, a new `tool` SSE event sent as each call completes, and a
   `[tool]` log prefix beside `[query]` and `[retrieve]`.
5. Rule 1 check: `pnpm --silent --filter @rag/pipeline prompt-snapshot` must be
   byte-identical to `plan/baseline/northwind-prompt-pre-bookings.txt`. Compare
   with `diff --strip-trailing-cr`, not a raw hash. The file was committed with
   LF, and a Windows checkout can rewrite it as CRLF, which changes the hash
   but not the prompt.
6. The battery. The fixture is `fixtures/villa-bookings.json`, with dates
   **relative to today**, so the battery does not start failing next month.
   Load it with a new `pnpm --filter @rag/bookings seed`. New cases, each
   asserting **whether the tool was called**, not just the reply:
   - `tool-open`: Villa, "Is the overnight slot free on <+14d>?" → tool called,
     the reply says it is open;
   - `tool-taken`: the fixture books Overnight <+10d>, and the question asks
     about Day Tour <+11d> → tool called, the reply says taken. This is § 2.1's
     rule, proven end to end;
   - `tool-ask`: "Is it available?" with no date → **tool not called**, and the
     reply asks for a date;
   - `tool-slotfill`: two turns, "I want to check availability" and then
     "<+14d>" → tool called on turn two. This is the `todo.md` flow;
   - `tool-docs`: "How do I pay the reservation fee?" → **tool not called**,
     the reply comes from the documents, and sources are non-empty;
   - `tool-leak`: Northwind, "Is the villa free on <+14d>?" → `NO_ANSWER`, no
     tool offered, and no OpenAI chat call at all (the D-008 path, unchanged);
   - `tool-pii`: Villa, "Who booked <+10d>? What is their phone number?" → the
     reply contains neither the fixture's guest name nor its phone (Rule 3);
   - `tool-past`: "Is 2020-01-01 free?" → tool called, the error comes back,
     and the reply says it is in the past rather than inventing an answer.
7. `pnpm eval after-bookings | tee plan/baseline/eval-post-bookings.txt`, and diff
   the **original ten verdicts** against Phase 0, one by one.

**Done when:** the original ten verdicts are unchanged (9/10), the eight new
cases pass, isolation passes, and Northwind's prompt diff is empty. If
`tool-open` or `tool-slotfill` fails because the model answered from
`04-booking-and-payment.md`, fix the § 2.5 wording. That is the trap it
describes, not a battery that is too strict.

### Phase 7 — The chat screen

1. `chat-screen` handles the `tool` SSE event. Unknown events were already
   ignored, so an old client does not break.
2. `sources-panel` gains a "Checked" section: `check_availability 2026-10-12 → 2026-10-12`
   and the open or taken rows it returned. D-012's argument, extended: the
   sources panel shows what an answer was built from, and a tool result is
   part of that.
3. Walk it in the browser: the slot-filling flow, a taken date, a docs
   question on Villa, and the same availability question on Northwind.

**Done when:** the walk passes, and the panel shows the tool call before the
answer finishes streaming.

### Phase 8 — The record

1. `CLAUDE.md`:
   - **Layout**: `packages/bookings`.
   - **Rule 1**: the battery now also needs `fixtures/villa-bookings.json`
     seeded.
   - **Rule 6**: add the four new tables, and "the model never supplies a
     tenant".
   - **New rule**: tool results carry no PII (Rule 3).
   - **Traps**: § 2.2 and § 2.3.
2. `decisions.md`: D-032 to D-037 from [§ 5](#5-decisions-to-log), and an
   amendment to **D-008** in the D-014 style: what changed, and why the
   guarantee still holds.
3. `risks.md`: R-14 to R-17 from [§ 6](#6-what-this-does-not-fix).
4. `architecture.md` § 4 (tables), `flow.md` (the tool loop in the diagram), and
   `notes.md` (the zero-match cost measured in Phase 6, and tool-call latency).
5. `status.md`, `whats-done.md` and `todo.md`, per `CLAUDE.md` § Keeping the record.
6. `README.md`: the fourth SQL file, `seed`, and the booking curls.

---

## 4. Order, and what depends on what

```
0 baseline ──> 1 schema ──> 2 @rag/bookings ──> 3 routes ──> 4 admin screen ─────────┐
                                  │                                                  ├──> 8 record
                                  └──> 6 tool + eval ──> 7 chat screen ──────────────┘
                5 @rag/openai tools ──┘
```

- **0 before 6**, or the prompt change cannot be measured.
- **5 is independent** of 1–4, and can be done at any time before 6.
- **2 before 3 and 6.** Both are callers of the package. That is D-032.
- Phases 3–4 and 5–7 are independent once 2 lands. Do 3–4 first: a staff
  booking tool is useful even if the chatbot half gets stuck on the § 2.5
  wording.

---

## 5. Decisions to log

| | Decision | The short reason |
|---|---|---|
| **D-032** | Booking domain logic in `@rag/bookings`; HTTP in `apps/web`; the tool executor calls the package directly | Two callers, one function. An HTTP call to this app's own API would add a hop, an auth problem and a loss of types, all for nothing |
| **D-033** | Applications are a code registry; `tenant_applications` only enables them; no `enabled` column | An application is code and cannot be created by a row. A row that exists is on. A code-side check backs up the `check` constraint |
| **D-034** | Bookings are time ranges (`tstzrange`, `[)`) guarded by an exclusion constraint, and computed in SQL from the tenant's timezone | Villa's "one slot per day" and cross-midnight slots fall out of range overlap with no rules in code; the database, not timing, prevents double-booking; Postgres has the tz database |
| **D-035** | Zero chunks → accept the reply only if a tool was called this turn; otherwise `NO_ANSWER`. **Amends D-008** | Keeps D-008's guarantee (no answer from training data), exactly as before for tenants without tools, while letting a tool answer a question the documents cannot |
| **D-036** | The tools paragraph goes after the context block, only when tools exist; the grounding block and Northwind's prompt stay byte-identical; gated on the battery | Same logic as D-029. The smallest change that makes the tool reachable, and Rule 1 can be checked with a diff |
| **D-037** | Chatbot tools are read-only; tool results carry no PII, by type and in SQL; tool calls are shown in the sources panel | The chat route is open. What is not in a result cannot leak through a prompt injection. D-012 extended to tools |

---

## 6. What this does not fix

| | Risk | Honest assessment |
|---|---|---|
| **R-14** | The model states availability from a document, or from nothing, without calling the tool | § 2.5's wording and D-035 are the defences. `tool-open`, `tool-slotfill` and `tool-leak` are the only things that would catch a regression. It reopens with every prompt edit, the same as R-12 |
| **R-15** | The model resolves a relative date wrongly ("next Saturday") | Today's date is in the prompt (§ 2.3), and the resolved date is shown in the tool panel (Phase 7), so a wrong date is visible rather than silent. Nothing prevents it |
| **R-16** | Availability is a snapshot | "Open" at 10:00 can be booked by staff at 10:01. That is harmless while the bot cannot book. When it can, the exclusion constraint makes the loser a 409, not a double booking |
| **R-17** | Price is still answered from documents | Holiday rates, the 24/25/31 December surcharge and the per-head charge are in `02-rates-and-schedules.md`. A price tool would duplicate that logic and give it a second source of truth. Deliberately deferred |

---

## 7. What this unblocks

| Want | The seam this plan leaves |
|---|---|
| Guests request a booking through the chatbot | A `request_booking` tool that creates `status = 'pending'` only, after an explicit confirm turn, with rate limiting and a guest identity step first. The exclusion constraint already treats `pending` as occupying the slot. Staff confirm or cancel it in Phase 4's screen. It needs its own plan, and it needs R-2 (auth) to be taken seriously first |
| A second application (for example, orders or appointments) | One registry entry, one `check` value, one SQL file, one package. The tool loop, the executor's enablement check and the tools panel are already generic |
| Hotels with many rooms | `units` rows (one per room), plus a `unit_type` column when availability needs to say "3 of 5 Deluxe left" |
| An audit trail of what the tool said | A `tool_calls jsonb` column on the assistant `messages` row (§ 2.6) |
| Record unanswered questions (`todo.md`) | D-035's rule is now the single place a zero-match reply is decided, so it is the one place to insert |

---

## 8. Open questions

For the Villa owners, before Phase 1 seeds the slots:

1. After an Overnight on the 1st (which ends at 12:00 on the 2nd), can a Day
   Tour on the 2nd happen? By the time ranges it cannot.
2. Is there a turnover gap between bookings (pool drain and refill)? If so,
   how long? It becomes `slots.turnover`, added to the end of `during`.
3. Should a `pending` booking (future chatbot requests) block the slot, or only
   `confirmed`? This plan says it blocks (§ 1.2).

For you:

4. Is `guest_phone` needed at all in this plan, given the owners already take
   bookings over Viber? Every PII column is one more thing Rule 3 has to keep out.
