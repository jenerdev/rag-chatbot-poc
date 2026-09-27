# Booking types plan — whole-resort or per-room, per tenant

> A tenant's bookings application gets a **booking type**: `whole_resort`
> (today's behaviour, and the default) or `per_room`. A per-room tenant
> manages **accommodations** (name, description, capacity, a price per slot,
> photos, active or not), staff book one or several of them in one go, the server
> prices the booking from the database, and the chatbot's
> `check_availability` answers with rooms, capacities and prices.
>
> Written 2026-09-27, against `3eaba16` on `master`. **Status: complete,
> 2026-09-27, on `feat/booking-types`, except Phase 4's browser walk** (owed;
> MAX_IMAGE_BYTES and MAX_IMAGE_EDGE stay provisional until a full-size photo
> is measured). Battery 47/48 (`rooms 10/10`), verify 69/69, isolation 20/20
> and 22/22 both ways, bundle clean. Decisions D-050–D-056, risks R-23–R-30.
> Earlier status: § 8 is answered (harbor as the
> per-room fixture, weekday/weekend rates only, villa's rates stay in the
> documents, room photos uploaded to Supabase Storage; question 5 superseded by payments.md).
>
> Read [§ 0](#0-the-four-rules) before touching anything and
> [§ 1](#1-what-already-exists) before designing a table. Most of this
> feature is already in the schema.

---

## What this plan covers

| | |
|---|---|
| **In scope** | `booking_type` in the bookings application's `config`; the columns a `units` row needs to be an accommodation (description, capacity, active); a `unit_rates` table (a price per unit and slot); a price computed **in SQL** and stored on the booking; booking several units in one atomic insert; capacity and inactive-unit checks in the database; **room photos uploaded to a Supabase Storage bucket**, with a `unit_images` table and Storage RLS by tenant; admin routes and a screen to manage accommodations; a room filter, a price and a guest count on the bookings screen; per-room results from `check_availability`; battery, isolation and verify cases for all of it |
| **Out of scope** | Guests booking through the chatbot. Tools stay **read-only** (D-037), and the chat route stays open. Also out: payments; holiday calendars, per-head surcharges and peak surcharges as data (see § 2.2); photos in the chat or in any tool result (Rule 4); server-side image resizing (Storage's transformations are not on the Free plan, § 2.8); a tenant switching type while it has future bookings (§ 2.4); a whole-property buyout for per-room tenants |

### What the request assumed, and what is actually in this codebase

| The request says | What the code has | What this plan does |
|---|---|---|
| "Use the existing resort-level pricing and pricing rules" | **There is no pricing in the database or the code.** Villa's rates are prose in `sample-documents/02-rates-and-schedules.md`, and the chatbot answers price questions from retrieved chunks. R-17 deferred a price tool on purpose | `whole_resort` keeps exactly that: no price column, no price tool, and the documents still answer. A price computed by code exists **only for `per_room`** |
| "Customers book…", "one transaction" | Only **staff** create bookings, on `/t/<slug>/admin/bookings`. The chatbot only checks availability (D-037) | A "transaction" is a staff booking of several rooms. The price is computed by the server either way, so the requirement still applies |
| "Track availability separately for each accommodation" | Already done. `bookings_no_overlap` is `unit_id with =, during with &&`, and `check_availability` returns one row per unit (plan/bookings.md § 2.1, § 7: "Hotels with many rooms → `units` rows") | Nothing new for overlap. Rooms are `units` rows |
| "Images (if supported)" | No file storage. The only images are `https` URLs in the tenant theme (`lib/branding.ts`) | **Uploads to Supabase Storage** (§ 2.8), on the Free plan's 1 GB storage and 5 GB/month egress. Shown on the staff screen only |

---

## 0. The four rules

### Rule 1 — `whole_resort` tenants see no change at all, and the prompt text proves it

Villa is `whole_resort`. For it, the schema change is additive, the tool
definition and result are byte-identical, and so is the prompt. Phase 0
captures villa's prompt (with tools) beside Northwind's, and Phase 6 diffs
both. The battery must still give **36/38** with the same two known failures.
Every per-room sentence goes into the tools block **only when the tenant is
`per_room`**, the same way tools are added only when a tenant has them
(D-036).

### Rule 2 — The price is the database's, and it is decided once

A price is never taken from a request body, from the model, or from the
browser. A trigger computes `bookings.price` from `unit_rates` at insert time
and **overwrites** anything the insert sent, as `bookings_compute_during`
already does for `during`. A preview (`/bookings/quote`) calls the same SQL
function the trigger calls, so the preview and the stored price cannot drift.
A rate edit does not change the price of a booking that already exists: that
is what the guest was told.

### Rule 3 — Isolation extends to `unit_rates`, `unit_images`, Storage and unit writes (CLAUDE.md rule 6)

- `unit_rates` and `unit_images` have `tenant_id`, composite FKs to
  `units (id, tenant_id)` (and `slots` for rates), and their own RLS
  policies (R-22).
- Storage objects live under `<tenant_id>/<unit_id>/<uuid>.<ext>`, and the
  `storage.objects` policies compare the first path segment with the token's
  tenant. That is wall 2. Wall 1 is `@rag/bookings` building every path from
  `tenant.id` itself and never from the request.
- Units become **writable by staff**: insert and update policies with
  `app_is_admin()`, and every query in `@rag/bookings` still carries
  `.eq('tenant_id', tenant.id)`. Both walls, each tested alone.
- The model still never supplies a tenant, unit id or booking id. A per-room
  tool may take a **unit name** and a **guest count**, which the executor
  matches against this tenant's units only.

### Rule 4 — A tool result carries nothing the chat user may not see (CLAUDE.md rule 7)

Per-room rows add `capacity` and `price`. Both are already public (a resort
publishes its rates), and neither is guest data. The description is **not**
in the result: it is tenant-written free text, and free text in a tool result
is a prompt-injection surface. Static facts about a room belong in the
documents, where retrieval already handles them. Photos are not in the
result either: a URL means nothing to the model, and the chat does not show
photos in this plan. Rows are still mapped field by field.

---

## 1. What already exists

| Need | Already there |
|---|---|
| Something bookable | `units (id, tenant_id, name)`, composite key `(id, tenant_id)` |
| A booking period | `slots` (name, start, duration, which may cross midnight) |
| No double booking per room | `bookings_no_overlap`, exclusion on `(unit_id, during)` |
| A booking can't point at another tenant's room | `bookings_unit_tenant_fk` (composite) |
| Availability per room | `check_availability` returns `(date, unit, slot, status)` per unit |
| Guest count | `bookings.guest_count` |
| Several units on the screen | `bookings-screen.tsx` shows a Unit select and prefixes the unit name when `multipleUnits` |

So `per_room` needs **prices, capacity, active/inactive, photos, a type flag
and multi-room bookings**, not a new availability model. Photos are the one
part with no precedent here: the project has never stored a file.

---

## 2. The traps that will actually cost you time

### 2.1 The type belongs in the application's config, not on `tenants`

A booking type means nothing without the bookings application. Northwind has
no bookings, and a `tenants.booking_type` column would give it a meaningless
value. `tenant_applications.config` already holds `timezone` and already has a
validating trigger. `booking_type` goes there:

- **absent means `whole_resort`.** Villa's row needs no migration, and
  "existing tenants default to whole-resort" is true by construction;
- the trigger rejects any value other than `whole_resort` or `per_room`;
- it is read in ONE place, `bookingsConfig()`, which returns
  `{ timezone, bookingType }`.

### 2.2 A price table cannot hold Villa's pricing rules

Villa's rate depends on the weekday, on a holiday list (Holy Week moves every
year, plus the Calamba fiesta), on a ₱250 per-head charge above 30 guests, and
on a ₱4,000 surcharge on three dates. None of that is data today.

This plan therefore prices **per_room only**, and only as
`unit_rates (unit, slot) → weekday price, weekend price`, with the weekend
days in config (default Fri–Sun, Villa's own definition). Holidays and
surcharges are **not** modelled. That has a consequence, which is R-24: a
per-room tenant with holiday rates would get a quoted price that is too low on
a holiday. Mitigations, in this plan:

- the tool result and the screen call it a **base rate**, not a total;
- the tools block tells the model that holiday and surcharge rules are in the
  documents;
- a `rate_overrides (unit, slot, date)` table was considered and **declined**
  for this plan (§ 8, question 2). It is the seam if a real tenant needs it.

### 2.3 Money is an integer

Prices are `bigint` **centavos**, with a `currency` in config (default
`PHP`). A float peso would turn ₱16,000.10 into 16000.099999. The screen and
the tool format it once, with `Intl.NumberFormat`.

### 2.4 Switching type is not a toggle

A `whole_resort` tenant has one unit, "Whole property", with bookings on it.
Turning it into `per_room` leaves those bookings on a unit that is not a
room, and a new room booking would not overlap them, so the property could be
sold twice. So:

- the type is set by an **operator CLI**, `tenant:booking-type`, not in the
  staff UI;
- it **refuses** while the tenant has a live (not cancelled) booking from
  today on, and says how many;
- `whole_resort` requires **exactly one active unit**. A trigger on `units`
  enforces it, so neither the CLI nor a staff edit can break it;
- `per_room` requires a rate for every (active unit, slot) before a booking
  of it can be inserted (a missing rate is a 400, not a free booking).

Past bookings stay where they are: they keep their unit, slot, `during` and a
`price` of null.

### 2.5 Several rooms, one transaction, no new function

PostgREST inserts an array in **one statement**. If one row hits
`bookings_no_overlap`, the whole statement fails with `23P01` and nothing is
saved. So booking three rooms is `.insert([row, row, row])`, all sharing a new
`group_id uuid`, and "all or nothing" is Postgres's, not ours. The total is the
sum of the stored prices of the group, read back after the insert. There is
still no "check, then insert" (trap 8).

### 2.6 A per-room tool result can be long

5 rooms × 3 slots × 14 days is 210 rows, several thousand tokens, and the
model has to read all of it. The per-room tool therefore takes optional
`slot`, `unit` and `guests` filters, and `MAX_AVAILABILITY_DAYS` is checked
against rows, not days, for per-room tenants (a new
`MAX_AVAILABILITY_ROWS`, measured in Phase 6, not chosen).

### 2.7 "Must not mix whole-resort and room prices"

A per-room tenant's **documents** may still describe a whole-venue rate.
Nothing in code can stop the model reading one. What code can do: the
per-room tools block says prices come from the tool only, and the battery gets
a case with exactly that document (`rt-mix`). That is the same defence as
R-14, and it reopens with every prompt edit.

### 2.8 Photos: the first file this project stores

**Storage must accept our tokens, and that is unproven.** PostgREST accepts
the tokens `mintTenantToken()` signs (D-039). Storage is a separate service
that verifies the same project keys, so it *should* accept them too, and its
policies *should* see the same claims through `app_tenant_id()` and
`app_is_admin()`. Neither has been measured. Phase 1 starts with a spike,
the same shape as auth-rls Phase 0: a staff token uploads to its own tenant's
prefix and is refused another tenant's; a chat token is refused both. **If
Storage refuses our tokens, stop and re-plan.** Uploading as `service_role`
is not a fallback: CLAUDE.md rule 2 keeps it out of every request.

**The upload goes through our route, not straight from the browser.**
Uploading from the browser would need a token in the browser, and a
`TenantContext` never reaches a Client Component. So the browser POSTs
`multipart/form-data` to `/api/t/<slug>/accommodations/<id>/images`, which
runs `withTenantRoute → requireAdmin → requireApplication → per_room`, then
uploads with `tenant.db.storage` on the staff token.

**What is checked, and where:**

| Check | Where | Why there |
|---|---|---|
| Type is JPEG, PNG or WebP | our route, by the file's **first bytes**, not its name or `Content-Type` | Both of those are whatever the sender typed. SVG is refused outright: it can carry script |
| Size ≤ `MAX_IMAGE_BYTES` | our route, **and** the bucket's `file_size_limit` | Two walls again: the bucket still refuses an oversized file if the route has a bug |
| Type allowlist | also the bucket's `allowed_mime_types` | Same reason |
| ≤ `MAX_IMAGES_PER_UNIT` photos per room | a trigger on `unit_images` | A count checked in TypeScript races, like "check, then insert" |
| The path is this tenant's | built from `tenant.id` in `@rag/bookings`; the Storage policy checks it again | The request never supplies a path |

**Resize in the browser, before upload.** Storage's image transformations
are not on the Free plan, and phone photos are 3–8 MB. The accommodations
screen redraws each photo on a `<canvas>` at most `MAX_IMAGE_EDGE` px wide and
re-encodes it as WebP, hand-written (D-001), no library. That also **strips
EXIF, including GPS location**, which a phone writes into every photo. A
direct POST that skips the screen can still send EXIF: the route is staff
only, so this is recorded as R-29, not blocked.

**Order of writes, so a failure leaves nothing broken** (the same move as
trap 5): upload the object, then insert the `unit_images` row; if the insert
fails, remove the object in the `catch`. Deleting goes the other way: delete
the row, then the object. A leftover object with no row is invisible and
only costs space. A row with no object would be a broken image on the screen.

**The bucket is public for reads.** Room photos are the tenant's marketing,
not guest data, and a public URL needs no token to display. The object name is
a random UUID, so there is nothing to enumerate. Writes still need a staff
token for that tenant.

**Deleting a tenant does not delete its files.** `on delete cascade` removes
the `unit_images` rows, but Storage is not Postgres. `tools/storage-orphans.mjs`
lists (and with `--delete` removes) objects with no row. R-30.

---

## 3. The data model

`packages/db/sql/schema-booking-types.sql`, idempotent, run **after**
`schema-auth.sql`, because it redefines `check_availability` as
`security definer` in the same shape schema-auth.sql gave it.

```sql
-- 1. config.booking_type: absent = whole_resort. The existing validate
--    trigger gains: value in ('whole_resort','per_room'); weekend_days, if
--    present, an array of ISO weekdays 1–7; currency, if present, 3 letters.

-- 2. units become accommodations. Every column is nullable or defaulted, so
--    villa's row is untouched.
alter table units
  add column if not exists description text,
  add column if not exists capacity    int  check (capacity is null or capacity > 0),
  add column if not exists active      boolean not null default true,
  add column if not exists sort_order  int     not null default 0;

-- 3. Prices. One row per (unit, slot). No row = not bookable yet (per_room).
create table if not exists unit_rates (
  tenant_id     bigint not null references tenants(id) on delete cascade,
  unit_id       bigint not null,
  slot_id       bigint not null,
  weekday_price bigint not null check (weekday_price >= 0),   -- centavos
  weekend_price bigint not null check (weekend_price >= 0),
  updated_at    timestamptz not null default now(),
  primary key (tenant_id, unit_id, slot_id),
  foreign key (unit_id, tenant_id) references units (id, tenant_id) on delete cascade,
  foreign key (slot_id, tenant_id) references slots (id, tenant_id) on delete cascade
);

-- 4. Bookings: the stored price and the group. Null for every existing row.
alter table bookings
  add column if not exists price    bigint check (price is null or price >= 0),
  add column if not exists group_id uuid;
create index if not exists bookings_tenant_group_idx on bookings (tenant_id, group_id) where group_id is not null;
create index if not exists bookings_tenant_unit_date_idx on bookings (tenant_id, unit_id, booked_date);

-- 5. unit_price(tenant, unit, slot, date) → bigint | null. STABLE. The one
--    place a price is computed; the trigger and /quote both call it.

-- 6. bookings_compute_during() is extended (same trigger, same timing):
--      - the unit must be this tenant's and ACTIVE      → 23503, as today
--      - guest_count <= capacity when both are set      → 23514
--      - per_room: new.price := unit_price(...), null   → 23514 "no rate"
--      - whole_resort: new.price := null (no pricing exists, Rule 1)
--    Whatever the insert sent as price is overwritten (Rule 2).

-- 7. units_one_active_whole_resort: a constraint trigger on units; a
--    whole_resort tenant has exactly one active unit (§ 2.4).

-- 8. check_availability: same signature and SAME four columns for
--    whole_resort. A new check_room_availability(p_tenant_id, p_from, p_to,
--    p_slot, p_guests) returns (date, unit, capacity, slot, status, price)
--    for per_room: active units only, capacity >= p_guests when given.
--    security definer, search_path = '', the token-tenant check, no guest
--    data: the same five properties as check_availability.

-- 9. RLS: unit_rates_read (tenant, any token: prices are public),
--    unit_rates_write / units_insert / units_update (tenant AND
--    app_is_admin()). No delete policy on units: deactivate instead, so
--    booking history keeps its unit.

-- 10. Photos. One row per stored object. `path` is the object's name in the
--     bucket, always '<tenant_id>/<unit_id>/<uuid>.<ext>'; the check makes a
--     row that points into another tenant's folder impossible.
create table if not exists unit_images (
  id         bigint generated always as identity primary key,
  tenant_id  bigint not null references tenants(id) on delete cascade,
  unit_id    bigint not null,
  path       text   not null unique,
  sort_order int    not null default 0,
  created_at timestamptz not null default now(),
  foreign key (unit_id, tenant_id) references units (id, tenant_id) on delete cascade,
  constraint unit_images_path_tenant check (path like tenant_id::text || '/' || unit_id::text || '/%')
);
--     + a trigger capping rows per unit at MAX_IMAGES_PER_UNIT (§ 2.8);
--     + RLS: read for any token of the tenant, insert/delete for its admins.

-- 11. The bucket and its policies (§ 2.8).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('unit-images', 'unit-images', true, <MAX_IMAGE_BYTES>,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit,
                               allowed_mime_types = excluded.allowed_mime_types;
--     storage.objects policies for bucket 'unit-images': insert and delete
--     when (storage.foldername(name))[1] = public.app_tenant_id()::text
--     AND public.app_is_admin(). No update policy: a photo is replaced by
--     delete + upload, so a path never changes what it shows.
```

Why a second function instead of new columns on `check_availability`:
villa's result, and so villa's prompt, stays byte-identical (Rule 1), and the
new function can be tested on its own.

---

## 4. Affected files

| Area | File | Change |
|---|---|---|
| SQL | `packages/db/sql/schema-booking-types.sql` | **new**, § 3 |
| DB types | `packages/db/src/…` (the `Database` types) | `units` columns, `unit_rates`, `unit_images`, `bookings.price/group_id`, the new RPCs |
| Spike | `plan/booking-types-phase1-storage.mjs` | **new**, the § 2.8 token spike |
| CLI | `packages/db/tools/storage-orphans.mjs`, `package.json` | **new**, objects with no `unit_images` row (R-30) |
| CLI | `packages/db/tools/tenant.mjs`, `package.json` | `tenant:booking-type -- <slug> [whole_resort\|per_room]`, refuses per § 2.4 |
| Checks | `packages/db/tools/verify.mjs` | RLS on `unit_rates`, `unit_images`, Storage and unit writes, each with its positive twin (trap 12) |
| Domain | `packages/bookings/src/images.ts` | **new**: `listImages`, `addImage` (sniffs the type, builds the path from `tenant.id`, upload → insert → remove on failure), `removeImage`. Staff only |
| Domain | `packages/bookings/src/types.ts` | `BookingsConfig.bookingType`, `Accommodation`, `RoomAvailability`, `BookingSummary.price/groupId`, `NewBooking.unitIds` |
| Domain | `packages/bookings/src/bookings.ts` | `bookingsConfig` reads the type; `createBooking` takes `unitIds[]` (a single `unitId` still works); `listBookings` gains `unitId` filter and price; `checkRoomAvailability`; `quote` |
| Domain | `packages/bookings/src/accommodations.ts` | **new**: `listAccommodations`, `createAccommodation`, `updateAccommodation` (incl. deactivate), `setRates`. Staff only |
| Domain | `packages/bookings/src/errors.ts` | map `23514` (capacity, no rate) to `BookingInputError` |
| Domain | `packages/bookings/src/constants.ts` | `MAX_UNITS_PER_BOOKING`, `MAX_AVAILABILITY_ROWS`, `MAX_IMAGE_BYTES`, `MAX_IMAGES_PER_UNIT`, `MAX_IMAGE_EDGE`, description/name caps |
| Browser | `apps/web/lib/limits.ts`, `apps/web/lib/resize-image.ts` | **new** `resize-image.ts`: canvas resize + WebP, no library; the image caps re-exported for the browser like `MAX_CONTENT_LENGTH` |
| Tests | `packages/bookings/src/*.test.ts`, `tools/isolation.mjs` | § 5 Phase 2 and Phase 7 |
| Routes | `apps/web/app/api/t/[tenant]/bookings/route.ts` | list filter `?unit=`, POST with `unitIds` |
| Routes | `…/bookings/setup/route.ts` | returns `bookingType`, `currency`, rates |
| Routes | `…/bookings/quote/route.ts` | **new**, admin, preview from `unit_price()` |
| Routes | `…/accommodations/route.ts`, `…/accommodations/[id]/route.ts` | **new**, `withTenantRoute` → `requireAdmin` → `requireApplication` → per_room check (404 for whole_resort) |
| Routes | `…/accommodations/[id]/images/route.ts`, `…/images/[imageId]/route.ts` | **new**, POST multipart (upload), DELETE; same four steps |
| Validation | `apps/web/lib/schemas.ts` | `createBookingSchema.unitIds`, accommodation and rate schemas |
| Screen | `apps/web/components/bookings-screen.tsx` | room filter, multi-select rooms (per_room), guests, price per row and group total |
| Screen | `apps/web/components/accommodations-screen.tsx`, `app/t/[tenant]/admin/accommodations/page.tsx` | **new**, S-5: list, add, edit, deactivate, rates grid per slot, photos (add, remove, order) |
| Tool | `packages/rag/src/tools.ts` | per_room: a different description, `slot`/`unit`/`guests` args, calls `checkRoomAvailability`, and its own instruction lines; whole_resort branch unchanged |
| Battery | `packages/rag/tools/prompt-eval.mjs`, a new fixture tenant | § 5 Phase 6 |

`answer.ts`, `prompt.ts`, `dates.ts` and `language.ts` should not need
changes. If one does, that is a finding to record.

---

## 5. The phases

Each phase ends with its checks green, `status.md` ticked and
`whats-done.md` written (CLAUDE.md "Keeping the record").

### Phase 0 — Baseline

Create the `harbor` tenant (`tenant:add -- harbor "Harbor Inn" "<assistant>"`,
then `member:operator -- harbor`); it stays `whole_resort` with no
bookings application until Phase 5, so the baseline below is unaffected.
Save to `plan/baseline/*-pre-booking-types.txt`: the battery (expect 36/38),
Northwind's prompt snapshot, **villa's prompt with its tools block**, verify
48/48, pipeline isolation 16/16 both ways, bookings isolation 12/12 both
ways, and the test counts. **Done when** all seven are saved from one commit.

> **Done 2026-09-27, from `e8fc28b`.** All seven saved, plus villa's tool
> definitions (`villa-tools-…`, no date in them, so they diff exactly) and
> villa's 14-day availability (42 rows, all open). Villa's prompt carries one
> dated line, `Today is … Asia/Manila.`, which Phase 6's diff must ignore.
> Battery 37/38 on the run, `lang-followup` then 1/4 on repeat: the usual
> 36/38. `harbor` is tenant 67; it was created **after** the baseline, and
> verify, bookings isolation and Northwind's snapshot were re-run to show it
> changed nothing.

### Phase 1 — Schema

**First, the Storage spike (§ 2.8).** Create the bucket and its policies
alone, then run `plan/booking-types-phase1-storage.mjs` with harbor's
operator staff token and a chat token. It must show: staff upload to
`<harbor>/…` succeeds and the object is readable by public URL; staff upload
to `<villa>/…` is refused; a chat token is refused both. **If Storage rejects
our tokens, stop and re-plan.** Save the output to `plan/baseline/`.

> **Spike passed 2026-09-27, 9/9** (`plan/baseline/storage-spike-booking-types-phase1.txt`).
> Storage accepts our ES256 tokens and its policies see `tenant_id` and
> `app_admin`: harbor staff uploaded to `67/spike/…`, and the public URL
> served the same 70 bytes with no token. Refused, each confirmed absent by a
> service-client listing: harbor staff into villa's folder, and a chat token
> into either (`403 new row violates row-level security policy`); SVG (`415`);
> 2 MiB + 1 (`413`). Villa staff deleting harbor's photo returned **no error
> and removed 0**: "not yours" is silent, the same shape as `cancelBooking`'s
> `false`, so `removeImage` must check the count, not the error. R-28 closed.

Then write and run the rest of `schema-booking-types.sql` (the user runs it in the Supabase SQL
editor, as before). **Done when**: villa's `check_availability` output for the
next 14 days is identical to the baseline; a second run of the file changes
nothing; an insert with a forged `price` stores null for villa; a second
active unit for villa is refused; verify has new RLS checks, each with a
positive twin, and passes.

> **Done 2026-09-27.** verify 69/69 (checks 49–68 are this phase's), on the
> first run and again after a second run of the file. Villa's 14-day
> availability, tool definitions and prompt, and Northwind's prompt, are
> byte-identical to Phase 0. Found on the way: PostgREST sends a key that one
> row of a multi-row insert lacks as NULL, not the default (23502 on
> `units.active`), so Phase 2's multi-room insert must give every row every
> key.

### Phase 2 — `@rag/bookings`

Types, config, accommodations, rates, quote, multi-unit `createBooking`,
`checkRoomAvailability`. Unit tests for validation and pricing (weekday vs
weekend at the tenant's timezone boundary, trap 9). **Done when**, against a
scratch per-room tenant made by the tests' own setup:

- two rooms booked for the same date and slot both succeed;
- the same room twice is `BookingConflictError`, and a 3-room group with one
  clash saves **zero** rows;
- an inactive room, another tenant's room id, and a room with no rate each
  give `BookingInputError`, with the same message for "not yours" and "not
  there";
- guest count over capacity is refused;
- the stored price equals `unit_price()`, and a forged price is ignored;
- editing a rate leaves an existing booking's price unchanged;
- a PNG renamed `.webp`, a file declared `image/jpeg` that is an SVG, and a
  file over `MAX_IMAGE_BYTES` are all refused; the seventh photo of a room is
  refused;
- an upload whose row insert fails leaves **no object** in the bucket (listed
  after, to prove it; trap 12: an empty listing proves nothing without the
  successful upload beside it).

> **Done 2026-09-27.** `tools/rooms.mjs` 15/15 on a real staff token
> (`plan/baseline/rooms-booking-types-phase2.txt`): a 2-room group priced
> 350000 + 600000 = 950000, equal to its quote; a clashing group leaves no
> row; inactive, foreign and missing rooms all say "No such unit or slot.";
> the 7th photo is refused and its upload removed (6 objects, 6 rows).
> **Deviation:** multi-room input is `rooms: [{ unitId, guestCount? }]`, not
> `unitIds[]`: capacity is checked per room, so the guest count must be per
> room too. `createBookings` returns the group; `createBooking` (one unit)
> keeps its old signature, so the current staff form and the battery's
> seeding are unchanged (`tool-*` 9/9).

### Phase 3 — Routes

`accommodations`, `quote`, and the changes to `bookings` and `setup`. **Done
when** curl shows: whole_resort `accommodations` is 404; chat token on every
new route is 401; cross-tenant unit id is 400 "No such unit or slot."; a POST
with `price` in the body stores the database's price; an image POST to
another tenant's room id is 404, the same as a room that does not exist.

> **Done 2026-09-27.** Walk 10/10 (`plan/baseline/walk-booking-types-phase3.txt`),
> on two throwaway tenants, one of each type, each with its own staff login.
> Photo delete and reorder take the room from the URL too, so a photo id
> under the wrong room is a 404 like any other "not there". **Trap met:**
> `next build` while `next dev` runs corrupts the dev server's `.next`
> (every page 500, `Cannot find module './535.js'`); build packages only
> while dev is up.

### Phase 4 — Screens

S-5 accommodations, and the bookings screen changes, in the existing styles.
**Done when** a browser walk of villa's bookings screen looks and behaves as
it does today (no rooms UI, no price), and a walk of the per-room tenant can
add a room, set its rates, deactivate it (it leaves the form and
availability, its old bookings stay listed), book two rooms together, see the
total, and filter by room. Photos: upload a real phone photo and record its
size before and after the browser resize (this sets `MAX_IMAGE_BYTES` and
`MAX_IMAGE_EDGE` from measured values, not chosen ones); download the stored
file and confirm it has no EXIF/GPS; remove it and confirm the object is gone
from the bucket.

> **Code done 2026-09-27 (`f720ab8`); the browser walk is owed**, deferred by
> the user. Page codes: villa bookings 200; accommodations 404 for villa and
> northwind, 200 for harbor. From the database after the first round: one
> photo, a 330×352 WebP of 6560 bytes with no EXIF or GPS (only an ICCP
> profile), and a Garden Room booking on a Saturday stored at 450000. That
> photo was smaller than MAX_IMAGE_EDGE, so it measured nothing:
> MAX_IMAGE_BYTES and MAX_IMAGE_EDGE are still provisional. **Deviation:**
> harbor got its bookings application (`per_room`, slot Night) here rather
> than in Phase 5, because the walk needed a per_room tenant.

### Phase 5 — The CLI

`tenant:booking-type`. **Done when** it shows the type, refuses per § 2.4 with
the count of future bookings, and switching the scratch tenant back and forth
with no bookings works.

> **Done 2026-09-27.** `plan/booking-types-phase5-cli.mjs` 6/6, running the
> real CLI as a child process on a scratch tenant. The CLI does not re-check
> the rules: the trigger refuses, and its message ("3 active units", "1 live
> booking(s)") is printed as is.

### Phase 6 — The tool, then measure

Per-room branch in `toolsFor()` and `executeTool()`. A new battery tenant,
`harbor` (say, a 4-room inn), with `fixtures/harbor.json` documents,
`fixtures/harbor-units.json` rooms and rates, and bookings seeded and
hard-deleted like `villa-bookings.json`. New cases, roughly:

| id | Asks | Must |
|---|---|---|
| `rt-list` | "What rooms are free on <date>?" | call the tool; list only open rooms, each with capacity and price |
| `rt-guests` | "A room for 6 on <date>?" | only rooms with capacity ≥ 6 |
| `rt-taken` | a date where one room is seeded taken | not offer that room |
| `rt-ask` | "Do you have a room?" | ask for the date, no tool call |
| `rt-price` | "How much is the Garden Room overnight on <date>?" | the tool's price, not a document's |
| `rt-mix` | a document states a whole-venue rate | never quote it as a room price |
| `rt-inactive` | an inactive room named in the documents | never offer it as available |
| `rt-leak` | ask harbor about villa's rooms, and villa about harbor's | refused / not found |
| `rt-tagalog` | a Tagalog room question | Taglish, D-043 |

**Done when**: villa and Northwind prompts diff clean against Phase 0; the
original 38 still give 36/38 with the same two known failures; every `rt-*`
case passes, and each case that flips is repeated before it is explained
(R-18). `MAX_AVAILABILITY_ROWS` is set from measured token counts.

> **Done 2026-09-27.** The tool keeps its name, `check_availability`, so the
> registry, D-046's up-front call and the chat's tools panel are unchanged;
> the per_room branch is chosen in executeTool from `bookingsConfig`, not
> from the tool text the model was given. Rows are `date, unit, capacity,
> slot, status, price`, with the price as text ("₱3,500.00"). Full battery
> 47/48 (`plan/baseline/eval-booking-types-phase6-full.txt`): the original
> 38 at 37/38, as in Phase 0; `rooms 10/10`, and 30/30 over three runs.
> Villa's prompt (bar its date line) and tools, and Northwind's prompt,
> byte-identical. Ten cases, not nine: `rt-leak` became two (`rt-leak`,
> harbor asked about villa; `rt-leak-2`, villa asked about harbor).
> **Measured:** 36.3 tokens a row, so MAX_AVAILABILITY_ROWS 150 ≈ 5,400
> tokens and a month of four rooms (124 rows) fits; kept at 150.
> **Found:** "from X to Y" is checked as its two end dates by D-046's
> resolver, so a range never reaches the tool as a range. Pre-existing, and
> villa has it too. Not fixed here: dates.ts is prompt text.

### Phase 7 — Isolation and the bundle

Bookings isolation grows cases for `unit_rates`, `unit_images`, Storage paths
and accommodation writes,
run both ways (`-- --filters-only`). Pipeline isolation gets a harbor↔villa
pair. verify grows by the Phase 1 checks. Then CLAUDE.md rule 2's grep of
`.next/static`. **Done when** all pass and each new RLS check has a positive
twin.

> **Done 2026-09-27.** Bookings isolation 22/22 both ways, pipeline 20/20
> both ways (`plan/baseline/isolation-*-booking-types-phase7.txt`). The
> cross-tenant target is a throwaway per_room tenant, not harbor: a failing
> photo-delete check would otherwise delete a real photo. Bundle
> (`plan/baseline/bundle-grep-booking-types-phase7.txt`): 0 files for every
> name and secret value on both builds, and the positive twin finds the new
> screen's own path, so the scan reads the right files.

### Phase 8 — The record

`decisions.md`, `risks.md`, `CLAUDE.md` (layout, commands, the new SQL file in
run order), `flow.md`, `status.md`, `whats-done.md`.

---

## 6. Decisions to log

| | Decision | The short reason |
|---|---|---|
| **D-050** | Booking type lives in `tenant_applications.config`; absent = `whole_resort` | Existing tenants default by construction. It sits next to the application it belongs to, and the existing trigger validates it |
| **D-051** | Rooms are `units` rows with new nullable columns; no `rooms` table | plan/bookings.md § 7 left this seam. The overlap guard and the composite FK already work per unit |
| **D-052** | Price computed in SQL by the insert trigger, stored on the booking, in centavos; only for `per_room` | The database's rate, not the request's, decides. History keeps the price the guest was told. No pricing exists for whole-resort, so none is invented |
| **D-053** | Multi-room booking = one array insert sharing `group_id` | One statement is atomic, so the exclusion constraint makes it all-or-nothing, with no new SQL function |
| **D-054** | A separate `check_room_availability`, not new columns on `check_availability` | Keeps villa's tool result and prompt byte-identical (Rule 1) |
| **D-055** | Switching booking type is an operator CLI that refuses while future bookings exist | § 2.4: a live whole-property booking would not block new room bookings |
| **D-056** | Room photos in a public Supabase Storage bucket, uploaded through our route on the staff token, under `<tenant_id>/<unit_id>/`, checked by content bytes, resized and EXIF-stripped in the browser | No token in the browser and no `service_role` in a request (rule 2); two walls on the path; Free plan has no transformations; phone photos carry GPS |

---

## 7. Risks

| | Risk | Honest assessment |
|---|---|---|
| **R-23** | The model quotes a room price without calling the tool, or from a document | `rt-price` and `rt-mix` catch it. Reopens with every prompt edit, like R-14 |
| **R-24** | Base rate only: holidays and surcharges are not modelled | **Accepted** (§ 8, question 2). A per-room tenant with holiday rates gets too low a quote on holidays. The tool calls it a "base rate". Fix when needed: `rate_overrides` |
| **R-25** | Deactivating a room with future bookings | The bookings stay valid and block nothing new. The screen warns and lists them, it does not cancel them |
| **R-26** | A per-room tenant's tool result grows with rooms × slots × days | `MAX_AVAILABILITY_ROWS` and the filters bound it. Measured in Phase 6 |
| **R-27** | Free plan egress is 5 GB a month | Browser-resized photos keep each view small, and only staff see them in this plan. Showing photos to chat visitors would change this sum |
| **R-28** | Storage may not accept our minted tokens | The Phase 1 spike decides it before anything else is built. No `service_role` fallback |
| **R-29** | A direct POST can skip the browser resize and keep EXIF/GPS | Staff-only route, so only a staff member can do it. The size and type caps still hold |
| **R-30** | Deleting a tenant or a failed delete leaves objects with no row | Invisible and only costs space. `storage-orphans.mjs` finds and removes them |

---

## 8. Open questions (before Phase 1)

**Answered 2026-09-27 by the user:**

1. ~~Is there a real per-room tenant yet?~~ **No: use `harbor`.** It is a
   made-up fixture tenant for the battery and the scratch tests, created with
   `tenant:add` in Phase 0 and set to `per_room` in Phase 5. Nothing in
   production is `per_room` until a real tenant exists.
2. ~~Pricing rules?~~ **Weekday/weekend is enough.** No `rate_overrides`,
   no per-head charge. R-24 stays open and is recorded as accepted, not
   deferred by accident.
3. ~~Move whole-resort pricing into the database?~~ **No: villa's rates stay
   in the documents.** `whole_resort` has no price column value, no price in
   any tool result, and villa's prompt stays byte-identical (Rule 1, R-17).

4. ~~Images?~~ **Uploads, in this plan** (first answered "exclude", then
   reversed the same day). Supabase Storage on the Free plan: 1 GB, 50 MB per
   file, 5 GB/month egress, no image transformations. Design in § 2.8, gated
   on the Phase 1 spike.

**Superseded:**

5. **Is a `pending` status wanted for multi-room groups**, or are staff
   bookings always `confirmed`, as today? **Superseded by
   [`payments.md`](./payments.md)**, which replaces `pending` with the full
   lifecycle. For this plan: staff bookings stay `confirmed`, as today.
