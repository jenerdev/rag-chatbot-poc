# Tenant management plan: a super user creates and edits tenants in the browser, and staff get roles

> Today a tenant is born at the command line: `tenant:add`, `member:add`,
> `member:operator`, `tenant:fallback`, `tenant:booking-type`, then a
> per-tenant script for its rates and documents (alteza, the fourth tenant,
> took `plan/alteza-load.mjs` and `plan/alteza-rooms.mjs` this week). And
> every member of a tenant is its admin (D-041): one role, one `exists`.
>
> This plan adds two things.
>
> 1. **A platform area, `/platform`, for a `super_user`:** a list of tenants
>    and ONE form per tenant with the business name, the assistant's name,
>    the theme, the logo and banner, the fallback messages, which
>    applications are switched on and their settings, including a new
>    per-tenant **maximum stay** and **booking horizon**. Create, edit,
>    archive. No hard delete in the browser (§ 2.3).
> 2. **Roles.** A membership row gets a `role`: `owner`, `admin` or `staff`.
>    Every admin route names the permission it needs, in ONE table, and every
>    write policy in Postgres asks the same role, so a `staff` token that
>    reaches the documents route by hand is refused by the database too.
>    Owners manage their tenant's members on a new Members screen.
>
> Written 2026-09-29, against `ebe9812` on `master`. **Status: decided,
> not started.** § 8's eight questions were answered 2026-09-29: every
> recommendation taken, by the user's instruction. Phase 0 is next.
>
> Read [§ 0](#0-the-five-rules) first, then § 1, which lists what the
> request assumes and what the code actually has.

---

## What this plan covers

| | |
|---|---|
| **In scope** | A `platform_admins` table and a **platform token** (a second, tenant-less token shape) for the super user; `/platform` with login, a tenant list and a tenant form (create, edit, archive, unarchive); switching an application on or off per tenant and editing its config; per-tenant `max_stay_nights` and `max_advance_days`, read by `request_booking()` and the page; a `role` on `memberships` (`owner` / `admin` / `staff`); role-aware policies; a permission table in code that every admin route names; a Members screen per tenant for owners (list, add an existing account by email, change a role, remove); the CLI catching up (`super:add`, `member:role`, `tenant:archive`, `tenant:remove`); verify, isolation, staff-cases and battery checks |
| **Out of scope** | Inviting a brand-new account from the browser (needs Supabase's admin API, so the service key; § 8 q3 says how it could come later); owners editing their own branding (§ 8 q2); hard-deleting a tenant from the browser (§ 2.3: the CLI does it, then the orphan sweeper); a slots editor (§ 8 q6); an audit log of who changed what; MFA; a tenant list on the public root (it stays a customer list, plan.md Phase 7); any change to `buildPrompt()`, `language.ts`, `dates.ts` or a tool's text (Rule 3) |

---

## 1. What the request assumes, and what is actually here

| The request says | What the code has | Consequence |
|---|---|---|
| Roles `SUPER_USER`, `BUSINESS_OWNER`, `BUSINESS_ADMIN`, `BUSINESS_STAFF` | One role: a `memberships` row IS admin (D-041), and `app_is_admin()` is one `exists`. Nothing platform-wide exists at all | The three business roles are a `role` column on `memberships`: `owner`, `admin`, `staff`. The `BUSINESS_` prefix is what the row already says (it belongs to one tenant). The super user is **not a membership**: it is a row in a new `platform_admins` table, because it has no tenant (§ 2.1, § 8 q1) |
| "Create a new tenant here" | `tenants` has **no RLS policies**, on purpose: no token reads it, and `tenant_public()`'s column list is the boundary (D-042). Writes happen on `service_role`, in `tenant.mjs` | A super policy on `tenants` (`app_is_super()`), the first policy the table gets. A chat or staff token still reads nothing from it, because the policy is false for them. The web app still never holds the service key (Rule 2) |
| "Max booking date, max days/night" per tenant | Both are **constants**: `c_max_nights := 14`, `c_max_advance := 365` inside `request_booking()`, with copies in `packages/bookings/src/constants.ts` that `requests.test.ts` pins to the same numbers | Two optional keys in the bookings config, `max_stay_nights` and `max_advance_days`, **absent means today's numbers** (the D-050 pattern). `request_booking()` reads them with `coalesce`; `bookingsConfig()` applies the same defaults in TypeScript, in the one place it already defaults `booking_type`, `weekend_days` and `currency` (§ 2.4) |
| "Theme" in a form | Five colour keys, validated on READ in `lib/branding.ts` (a bad value is dropped, never rejected); nothing validates on write | The same regex on write, in the form and in a new `tenants_theme_shape` check constraint, so Postgres is the second wall, as `tenants_fallback_messages_shape` already is (§ 2.5) |
| "Application" in the form | `tenant_applications` rows are inserted by SQL and scripts; `tenant_applications_validate` refuses a missing or unknown timezone and a type switch with live bookings (D-055) | The form inserts, updates or deletes the row on the super token, under a super policy. The triggers keep deciding what is allowed; the form reports Postgres's reason, as `tenant:booking-type` does today |
| "Role/permission-based access to other pages" | 31 `requireAdmin()` calls in 21 route files, all meaning "a member". Client screens hide nothing by role because there is no role | `requireAdmin(request, tenant, permission)`: a REQUIRED third argument, so every call site is a compile error until it names its permission (D-027's argument). One table maps role → permissions. Policies ask `app_is_admin()` (owner or admin) or `app_is_staff()` (any role) so the database refuses what the code would (§ 2.2) |
| Delete a tenant | `on delete cascade` from `tenants` reaches documents, chunks, conversations, bookings (guest names, phones, emails), memberships. Storage objects do NOT cascade (R-30) | The browser **archives** (`archived_at`); `tenant_public()` stops returning the row, so the whole app answers 404 for it. Hard delete stays a CLI, which runs the orphan sweeper after (§ 2.3) |

---

## 0. The five rules

### Rule 1 — The super user is a second token shape, and the signer still mints no role

`mintTenantToken()` mints one shape: `authenticated`, a tenant, five minutes
(CLAUDE.md rule 8). This plan adds a sibling in the SAME file,
`mintPlatformToken({ userId })`, which mints `{ role: 'authenticated', sub,
app_super: true, iat, exp }`: no `tenant_id`, no `app_admin`, still five
minutes, still no `role` parameter. `TENANT_SIGNING_JWK` is still read in
one function. With no `tenant_id`, `app_tenant_id()` is null and **every
tenant policy is false** for this token; the only rows it can touch are the
ones a `*_super` policy opens. `app_is_super()` demands the claim AND a
`platform_admins` row, the way `app_is_admin()` demands the claim and a
membership: a server bug that mints `app_super` for the wrong user still
writes nothing.

### Rule 2 — Two walls for every permission, and each is tested alone (D-038, extended)

A `staff` member who POSTs to the documents route by hand is refused twice:

1. **the code:** `requireAdmin(request, tenant, 'documents:write')` throws a
   403 because `PERMISSIONS.staff` does not hold it;
2. **Postgres:** `documents_insert` asks `app_is_admin()`, which is now
   `app_role() in ('owner', 'admin')`, and the token's membership row says
   `staff`.

`verify.mjs` proves wall 2 alone: a `staff` token inserts a document with no
code in between and gets a policy error, and its positive twin, an `admin`
token, succeeds. `staff-cases.mjs` proves wall 1 over HTTP. A permission
that only one wall knows about is a bug.

### Rule 3 — No prompt, tool or retrieval change, so the battery must not move

Nothing in this plan touches `buildPrompt()`, `language.ts`, `dates.ts`, a
tool definition or a retrieval number. `pnpm eval` must match Phase 0's
run **verdict for verdict** (`plan/baseline/eval-pre-tenant-management-2026-09-29.txt`:
57/61, `original 9/10 · tool 8/9 · lang 9/10 · date 11/11 · rooms 13/13 ·
book 4/5 · price 3/3`). Two of its four failures are DATE-driven, not
code-driven, and are explained in Phase 0 below: `tool-leak` fails on any
day whose number is a token in northwind's handbook, and
`book-for-me-harbor` flipped with the fused chunk order for 13 October.
Neither is this plan's to fix (Rule 3), and both are owed a separate look.
Northwind's prompt snapshot must match
`plan/baseline/northwind-prompt-pre-bookings.txt`, and villa's and harbor's
tool definitions must match `villa-tools-post-villa-prices.txt` and
`harbor-tools-pre-customer-booking.txt` byte for byte. A flipped verdict
means a policy or a query changed what a tenant reads, and it is a bug to
find (R-22), not noise.

### Rule 4 — The role is read from the row on every request, never from the token

A staff token carries `sub` and `app_admin`, as today, and **no role claim**.
`app_role()` reads the membership row inside the policy, and
`requireAdmin()` reads the same row through `staffClient()`. So a demotion,
like a removal today, takes effect on the next request, and a token can
never outrank its row. The same holds for the super user: the claim says
"platform", the `platform_admins` row says whether that is still true.

### Rule 5 — Both walls, no `service_role`, for everything new (CLAUDE.md rules 2 and 6)

`platform_admins` has its own policies. Every `/api/platform` route runs on
the platform token; every `/api/t/<slug>/members` route on a staff token.
`tenant_applications` and `memberships` gain write policies that name who
may write (super; owner for their own tenant's rows), and both isolation
suites grow. Every RLS check has its positive twin (trap 12): the count
matches, or a real row comes back. The web app still neither needs nor
reads `SUPABASE_SERVICE_ROLE_KEY`, and `scripts/check-service-imports.mjs`
still passes.

---

## 2. The traps that will actually cost you time

### 2.1 A super user is not a member of every tenant

The tempting model is "a super user is an owner of every tenant": one role
enum, one guard. It fails on the token: a staff token names a tenant, and
the super user's work (list tenants, create one) has no tenant yet. So the
super user is its own table, its own token shape, its own cookie
(`rag_platform`, path `/api/platform`) and its own area. When a super user
needs to administer a tenant's CONTENT (documents, rooms, bookings), they
add themselves as that tenant's `owner` on the Members panel and use the
tenant's own screens on a staff token, like anyone else (§ 8 q5). Two
sessions, two cookies, two paths: the browser never sends one to the
other's routes, and `readSession()` checks the payload's kind as well.

### 2.2 `app_is_admin()` is named in 30 policies; do not rewrite them

Every write policy today asks `app_is_admin()`. Rather than editing thirty
predicates, the function changes meaning underneath them:

```sql
create or replace function app_role() returns text
language sql stable set search_path = ''
as $$
  select m.role
  from public.memberships m
  where coalesce((auth.jwt() ->> 'app_admin')::boolean, false)
    and m.user_id = auth.uid()
    and m.tenant_id = public.app_tenant_id()
$$;

-- Unchanged signature, new meaning: owner or admin. Every existing policy
-- that names it now means "owner or admin" with no edit.
create or replace function app_is_admin() returns boolean
language sql stable set search_path = ''
as $$ select coalesce(public.app_role() in ('owner', 'admin'), false) $$;

-- Any member. Only the bookings and unanswered policies switch to this.
create or replace function app_is_staff() returns boolean
language sql stable set search_path = ''
as $$ select coalesce(public.app_role() in ('owner', 'admin', 'staff'), false) $$;

-- The platform. The claim AND the row, as for app_is_admin().
create or replace function app_is_super() returns boolean
language sql stable set search_path = ''
as $$
  select coalesce((auth.jwt() ->> 'app_super')::boolean, false)
     and exists (select 1 from public.platform_admins p where p.user_id = auth.uid())
$$;
```

Only the policies whose meaning CHANGES are rewritten: `bookings_read`,
`bookings_insert`, `bookings_update` and the three `unanswered_resolutions`
policies move to `app_is_staff()`. Every other policy keeps its text and
gains the narrower meaning for free. The `(select …)` InitPlan wrapping
stays (trap 11); `app_role()` is one indexed lookup on the primary key.

### 2.3 Deleting a tenant deletes guest data and orphans photos

`tenants` cascades to `bookings`, which hold names, phones and emails, and
`unit_images` rows cascade while their Storage objects do not (R-30). A
Delete button in a browser is one click from that. So the browser gets
**archive**: `tenants.archived_at timestamptz`, and one line in
`tenant_public()`:

```sql
where t.slug = p_slug and t.archived_at is null
```

Every page and route resolves its tenant through that function
(`loadTenant()`), so an archived tenant is a 404 everywhere at once, chat
included, with nothing else to remember. The super list shows archived
tenants greyed, with Unarchive. Hard delete is `tenant:remove -- <slug>
--yes`, a CLI on `service_role`, which prints what it is about to cascade
(counts per table), deletes, then runs `storage-orphans.mjs -- --remove`
and reports the count (trap 17: check how many were removed, not only the
error).

### 2.4 Two limits, two places, one default

`MAX_STAY_NIGHTS` and `MAX_BOOKING_ADVANCE_DAYS` are copies of
`request_booking()`'s constants, pinned equal by a test. Making them
per-tenant means neither side may hold the number alone:

- **SQL:** `request_booking()` reads
  `coalesce((a.config->>'max_stay_nights')::int, 14)` and
  `coalesce((a.config->>'max_advance_days')::int, 365)` from the row it
  already selects the timezone from. The trigger validates both keys:
  integers, 1–60 nights, 1–730 days.
- **TypeScript:** `bookingsConfig()` returns `maxStayNights` and
  `maxAdvanceDays`, defaulted in the ONE place it defaults the other keys.
  `validate.ts`, `requests.ts` (`maxNights`, `lastDate`) and the page take
  them from the config, not the constant. The constants are renamed
  `DEFAULT_MAX_STAY_NIGHTS` and `DEFAULT_MAX_BOOKING_ADVANCE_DAYS`, and the
  test pins the DEFAULTS to the SQL defaults.
- **verify.mjs** checks 14 accepted and 15 refused today. It keeps doing so
  on a tenant whose config is silent, and gains its twin: set
  `max_stay_nights: 3` on the probe tenant, 3 accepted, 4 refused with the
  message naming 3.

`dates.ts` resolves "X for 2 nights" and does not cap nights, and no tool
text names either number, so Rule 3 holds. Confirm it with the baseline
diff, not by reading.

### 2.5 A theme is CSS from a database column

`branding.ts` validates colours on read and DROPS a bad one, so the page
never breaks. A form that writes the column must be at least as strict:
the same `#rgb | #rrggbb` regex, the same five keys, and nothing else.
`THEME_KEYS` and the regex move out of the server-only `branding.ts` into a
pure `apps/web/lib/theme.ts` (no imports, like `limits.ts` and `money.ts`),
so the form validates live and the server validates again. Then Postgres:

```sql
alter table tenants add constraint tenants_theme_shape check (
  jsonb_typeof(theme) = 'object'
  and theme - array['accent', 'accentSoft', 'bg', 'panel', 'ink'] = '{}'::jsonb
  and coalesce(theme ->> 'accent',     '#000') ~ '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$'
  -- … one clause per key; no subqueries in a check
);
```

Run it against the three live themes FIRST (Phase 1 step 0): a constraint
that today's rows fail is a migration, not a check. `logo_url` and
`banner_url` get `https:` checks the same way (`httpsUrl()` on read stays).

### 2.6 The slug is in URLs, cookies and Storage paths

A tenant's slug is its address, the path of its staff cookie
(`/api/t/<slug>`), and the folder of its photos in the `unit-images`
bucket. Renaming it breaks every one of those at once. The form shows the
slug **read-only after create**; a rename is out of scope, and the
`tenants_slug_shape` and `tenants_slug_reserved` constraints keep deciding
what a new one may be (the form reports Postgres's reason, as `tenant:add`
does). Add `platform` to `tenants_slug_reserved` while there: a slug only
ever appears under `/t/`, so nothing collides, but a workspace called
"platform" would read as a system page, which is what that list is for.

### 2.7 The last owner, and an owner editing themself

A Members screen that lets an owner demote or remove anyone can leave a
tenant with no owner, and then nobody can manage members but the super
user. A `before update or delete` trigger on `memberships` refuses the
change that would leave zero `owner` rows for the tenant
(`check_violation`, with a message the screen shows). The code does NOT
pre-check it (trap 8's shape: refuse in the database, report the reason).
An owner may change their own role only downwards through that same
trigger, and the CLI, on `service_role`, is the way back.

### 2.8 `memberships` writes were revoked, deliberately

`schema-auth.sql` step 3 revokes `insert, update, delete` on `memberships`
from `authenticated` as belt and braces. Owner and super writes need the
grant back AND policies; the grant alone opens nothing (no policy = deny),
and a policy alone does nothing (no privilege). Do both in the same file,
and let verify prove that a `staff` token still cannot touch the table
(positive twin: the owner can).

### 2.9 Emails live in `auth.users`, which no token reads

The Members screen must show emails, and "add an existing account by email"
must turn an email into a `user_id`. Both live in `auth.users`, which
tokens cannot read and which the CLI reaches through the admin API on
`service_role`. Two `security definer` functions, each `set search_path =
''` and each checking the caller ITSELF (D-042's pattern):

- `member_emails(p_tenant_id)`: the members of the token's tenant with
  their email and role; refused unless `app_is_staff()` for that tenant,
  or `app_is_super()`. Returns email and role and NOTHING else from
  `auth.users`.
- `user_id_by_email(p_email)`: one uuid or null; refused unless the caller
  is an owner of some tenant or super. It answers "not found" and "found"
  differently, which lets an owner probe whether an email has an account
  (R-42). Bounded by being owner-only and by the per-IP window; § 8 q4.

That makes six definer functions. D-042 is amended again, and the CLAUDE.md
rule 8 list grows by two names.

---

## 3. The data model

### 3.1 Roles

```sql
alter table memberships add column if not exists role text not null default 'admin';
alter table memberships drop constraint if exists memberships_role;
alter table memberships add  constraint memberships_role check (role in ('owner', 'admin', 'staff'));
-- Every existing row meant "admin" (D-041), so the backfill IS the default.
-- Then drop it: a new row must say what it is (schema-tenancy step 9's pattern).
alter table memberships alter column role drop default;

create table if not exists platform_admins (
  user_id    uuid        primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table platform_admins enable row level security;
create policy platform_admins_read_own on platform_admins for select to authenticated
  using (user_id = (select auth.uid()));
-- No write policy: rows are added by the CLI (super:add), because the first
-- super user is, by definition, something no super user can create yet.
revoke insert, update, delete on platform_admins from anon, authenticated;
```

| Request's name | Here | Where it lives | What it may do (§ 3.2) |
|---|---|---|---|
| `SUPER_USER` | `super` | a `platform_admins` row; platform token | tenants: list, create, edit, archive; applications on/off and config; any tenant's members. NOT a tenant's content (§ 2.1) |
| `BUSINESS_OWNER` | `owner` | `memberships.role` | everything an admin may, plus members |
| `BUSINESS_ADMIN` | `admin` | `memberships.role` | documents, rooms, rates, photos, holidays, bookings, unanswered |
| `BUSINESS_STAFF` | `staff` | `memberships.role` | bookings and requests (the daily work), unanswered; READ documents |

### 3.2 Permissions, in one file

`apps/web/lib/permissions.ts`, pure, no imports, importable by the browser
(so screens hide what a role cannot do) and by every route (which is the
guard):

```ts
export const ROLES = ['owner', 'admin', 'staff'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'documents:read', 'documents:write',
  'bookings:read', 'bookings:write',
  'rooms:write',          // units, rates, photos (S-5)
  'holidays:write',       // S-7
  'unanswered:read', 'unanswered:write',
  'members:manage',       // the Members screen
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const STAFF: Permission[] = ['documents:read', 'bookings:read', 'bookings:write', 'unanswered:read', 'unanswered:write'];
const ADMIN: Permission[] = [...STAFF, 'documents:write', 'rooms:write', 'holidays:write'];
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  staff: STAFF,
  admin: ADMIN,
  owner: [...ADMIN, 'members:manage'],
};
export const can = (role: Role, permission: Permission) => ROLE_PERMISSIONS[role].includes(permission);
```

The database's view of the same table is two functions: `app_is_admin()`
covers every `*:write` except bookings and unanswered; `app_is_staff()`
covers those two and every read. `members:manage` is the `memberships`
owner policy. A unit test pins the two views to each other: for every
permission, the roles `can()` grants are exactly the roles whose policy
predicate is true, listed in the test by hand.

### 3.3 The tenant form's fields, and where each one lands

| Field | Column / key | Validated by |
|---|---|---|
| slug (create only) | `tenants.slug` | `tenants_slug_shape`, `tenants_slug_reserved` |
| business name | `tenants.business_name` | 1–100 chars, zod + a new check |
| assistant name | `tenants.assistant_name` | 1–50 chars, zod + a new check |
| logo, banner | `tenants.logo_url`, `banner_url` | `https:` only, zod + a new check |
| theme (five colours) | `tenants.theme` | `lib/theme.ts` regex + `tenants_theme_shape` |
| fallback messages ×3 | `tenants.fallback_messages` | `tenants_fallback_messages_shape` (exists) |
| archived | `tenants.archived_at` | Archive / Unarchive buttons, not a field |
| bookings: on/off | a `tenant_applications` row | `tenant_applications_validate` (exists) |
| bookings: timezone | `config.timezone` | the trigger (exists) |
| bookings: type | `config.booking_type` | the trigger, incl. the live-bookings refusal (D-055) |
| bookings: currency, weekend days | `config.currency`, `config.weekend_days` | the trigger (exists) |
| bookings: **max stay**, **horizon** | `config.max_stay_nights`, `config.max_advance_days` | the trigger (new), § 2.4 |
| bookings: page text, guest hint | `config.booking_page.*` | `tenant_applications_booking_page` (exists) |

Every field the database already constrains is constrained ONCE; the form
and zod repeat the rule only to say it first, in their own words.

---

## 4. The token, the cookie and the guards

### 4.1 `@rag/db`

- `mintPlatformToken({ userId })` beside `mintTenantToken()` (Rule 1).
- `platformClient(userId)`: mints the token, reads `platform_admins` through
  it (`read_own`), returns the client or null. The shape of `staffClient()`.
- `staffClient()` returns `{ db, role }`, reading `role` from the row it
  already selects. Its callers change: `requireAdmin()`, `asOperator()`.
- CLI, all on `service_role`, all printing no secret:
  - `super:add | remove | list -- <email>`: the bootstrap. `super:add` on an
    email with no account invites it (the link lands on `/platform/reset`,
    a sibling of the tenant reset page).
  - `member:add -- <slug> <email> [owner|admin|staff]`, default `admin`, so
    every existing script and `member:operator` keep their meaning.
  - `member:role -- <slug> <email> <role>`; `member:list` prints the role.
  - `tenant:archive -- <slug> [--undo]`; `tenant:remove -- <slug> --yes`
    (§ 2.3).

### 4.2 `apps/web`

- `lib/admin-auth.ts`: `requireAdmin(request, tenant, permission)` returns a
  `StaffContext` (`TenantContext & { role: Role }`). No permission → does not
  compile. Wrong role → a 403 that names the permission. 403 joins
  `CLIENT_STATUSES` in `lib/route.ts` (a logged-in member already knows the
  tenant exists, so this is not the enumeration case "not yours = not
  there").
- `lib/platform-auth.ts`: cookie `rag_platform`, path `/api/platform`,
  payload `platform.<user-id>.<expiry>.<hmac>`, same secret and helpers as
  the staff cookie. `requirePlatform(request)` → a `PlatformContext { db,
  userId }`. `withPlatformRoute()` = `withRoute()` + `requirePlatform()`, and
  every handler under `app/api/platform/` starts with it (a new line in
  CLAUDE.md rule 3).
- `GET /api/t/<slug>/admin/session` returns `{ admin: true, role }`. Screens
  hide by `can(role, …)`; the server decides.

### 4.3 The screens and routes

| Path | Who | What |
|---|---|---|
| `/platform` | super | login → tenant list (name, slug, applications, members count, archived) → the form |
| `/platform/reset` | — | where a super invite lands |
| `POST/GET/DELETE /api/platform/session` | — / super / — | login, am-I, logout |
| `GET, POST /api/platform/tenants` | super | list; create (slug, names) |
| `GET, PATCH /api/platform/tenants/[id]` | super | one tenant; edit names, urls, theme, fallbacks |
| `POST, DELETE /api/platform/tenants/[id]/archive` | super | archive, unarchive |
| `PUT, DELETE /api/platform/tenants/[id]/applications/[key]` | super | switch on with a config, edit it, switch off |
| `GET, POST, PATCH, DELETE /api/platform/tenants/[id]/members` | super | as an owner's Members routes, for any tenant |
| `/t/<slug>/admin/members` | owner | the Members screen |
| `GET, POST, PATCH, DELETE /api/t/<slug>/members` | owner (`members:manage`) | list with emails; add an existing account; change a role; remove |

`/platform/tenants/[id]` uses the numeric id, not the slug, because an
archived tenant still has to be reachable to unarchive, and
`tenant_public()` no longer returns it. The root page still links nowhere:
`/platform` is reached by being given the address, and it is a login form
until it is not.

---

## 5. Phases

Each phase ends with the checks named in it, recorded in `status.md` and
`whats-done.md` in the same turn, with observed values.

### Phase 0 — Baseline and the record of the rules · **done 2026-09-29**

Observed: verify **92/92**; tests 13 + 14 + 94 + 329; typecheck clean;
pipeline isolation **20/20** both ways; bookings isolation **29/29** both
ways; rooms **30/30**; northwind's prompt, villa's and harbor's tool
definitions byte-identical to their baselines (saved again as
`*-pre-tenant-management.txt`); every live row passes the Phase 1
constraints (`tenant-management-shapes-2026-09-29.txt`, 23/23); seven
members over four tenants (`members-2026-09-29.txt`). Battery **57/61**:
`antecedent` (D-017) and `lang-followup` (D-043) as always, plus two
flips repeated per R-18 and traced to the date, both on unchanged code:
- `tool-leak` 0 of 3: FREE is 13 October, and "13" is a tsvector token in
  one northwind chunk (`vector:0 keyword:1 -> fused:1`, similarity 0.150),
  so D-015's keyword rescue kept the model call the case forbids. On 12
  October (every earlier run) nothing matched. The refusal and the zero
  tool calls, the half that guards a leak, still held.
- `book-for-me-harbor` 0 of 4: the same four chunks in a different fused
  order, and the model offered to "send your request to the Dela Rosa
  family" instead of naming the Book button. No booking was claimed. On 12
  October it named the button 3 of 3.

- Branch `feat/tenant-management`. Commit this plan on `master` first.
- Record: verify **92/92**, eval **59/61** with the per-group line, pipeline
  isolation 20 both ways, bookings isolation 29 both ways, rooms 30, tests
  (count), `pnpm typecheck` clean. Prompt snapshot and both tool baselines
  diffed clean.
- Run every live tenant's theme, urls and names, and every bookings
  config, through the § 2.5 and § 3.3 rules
  (`plan/tenant-management-phase0-shapes.mjs`: the same rules in
  JavaScript, on the service client, because PostgREST runs no ad-hoc SQL).
  Every live row must pass before Phase 1 adds the constraint. Record what
  each returned.
- `member:list` for every tenant, into `plan/baseline/members-2026-09-29.txt`:
  the rows the backfill will turn into `admin`.

### Phase 1 — Schema (`packages/db/sql/schema-roles.sql`)

Idempotent, in this order, and guarded on `to_regclass('public.platform_admins')`
wherever it replaces a definition from an earlier file (trap 20):

1. § 3.1: `memberships.role`, backfill, drop default, `platform_admins`.
2. § 2.2: `app_role()`, `app_is_admin()` (replaced in place),
   `app_is_staff()`, `app_is_super()`. Grants as schema-auth step 6.
3. Policies whose MEANING changes: the three `bookings_*` and the three
   `unanswered_resolutions_*` to `app_is_staff()`.
4. `tenants`: `archived_at`; `tenants_theme_shape`, `tenants_urls_https`,
   name-length checks; `platform` reserved; the first policies:
   `tenants_super_all for all … using (app_is_super()) with check (app_is_super())`.
5. `tenant_public()`: drop and recreate with `and t.archived_at is null`
   (the return type does not change, but the file already uses the
   drop-then-create shape; keep it). Grants again.
6. `tenant_applications`: `tenant_applications_super_all`; a `before delete`
   trigger refusing while live bookings exist (D-055's rule, § 8 q7); the
   two new config keys validated in `tenant_applications_validate`
   (redefined here, guarded).
7. `memberships`: grant `insert, update, delete` back to `authenticated`
   (§ 2.8); `memberships_super_all`; `memberships_owner_manage` (`for all`,
   `tenant_id = app_tenant_id() and app_role() = 'owner'`, both USING and
   WITH CHECK); the last-owner trigger (§ 2.7). `memberships_read_own` stays,
   and owners also read every row of their tenant (`memberships_read_tenant`
   for `app_is_staff()`, so the Members screen and `member_emails()` agree).
8. `request_booking()`: the two `coalesce` reads (§ 2.4), nothing else.
9. § 2.9: `member_emails(bigint)`, `user_id_by_email(text)`; revoke, grant.
10. `notify pgrst, 'reload schema'`.

**Done when:** verify gains its checks (Phase 6 lists them) and passes;
eval **59/61**, snapshots and baselines byte-identical; both isolation
suites unchanged; a second run of the file changes nothing (compare
`pg_policies` and `pg_proc` before and after, as booking-types Phase 1 did).
`member:list` shows every existing row as `admin`.

### Phase 2 — `@rag/db` and the CLI

`mintPlatformToken`, `platformClient`, `staffClient` → `{ db, role }`,
`database.types.ts` regenerated, and the CLI commands of § 4.1. `super:add`
for the user's own email, then `super:list` shows it. `asOperator()` still
works (the operator is `admin`; eval and both isolation suites still seed).

**Done when:** `super:list` prints one row; eval and isolation unchanged;
tests pass; a `mintPlatformToken()` unit test shows the claims have no
`tenant_id` and no `app_admin`.

### Phase 3 — The guards in `apps/web`

`lib/permissions.ts`, `lib/theme.ts`, `requireAdmin(request, tenant,
permission)` at all 31 call sites (the compiler lists them), 403 in the
error map, `lib/platform-auth.ts`, `withPlatformRoute()`, the session GET
returning `role`. Every existing screen: the buttons a role lacks are
hidden by `can()`, and the tabs to S-5 and S-7 are hidden for `staff`.

**Done when:** `pnpm typecheck` clean; `staff-cases.mjs` gains the role cases
(§ 6) and passes against `pnpm dev`; every existing screen still works for
an `owner` (the walk is Phase 7).

### Phase 4 — Platform routes and the Members routes

The routes of § 4.3, zod schemas in `lib/schemas.ts`, every error from
Postgres passed through with its message (the triggers are the rules). A
`plan/tenant-management-phase4-walk.mjs` against `pnpm dev`: create a
`probe-tm` tenant, edit it, enable bookings with a config, set the two
limits, add a member by email, change their role, refuse the last-owner
demotion (409), archive (then `/t/probe-tm` is 404 and so is chat),
unarchive, and every one of those on a STAFF cookie → 401, on a `staff`
member's cookie against `/members` → 403.

### Phase 5 — The screens

`components/platform-screen.tsx` (login, list, form), `components/tenant-form.tsx`
(pure: the theme preview is the same five custom properties through the
`style` prop, D-030), `components/members-screen.tsx`,
`app/platform/page.tsx`, `app/platform/reset/page.tsx`,
`app/t/[tenant]/admin/members/page.tsx`. No `dangerouslySetInnerHTML`; every
server string is a React child. The form's Save shows Postgres's reason
verbatim when a trigger refuses.

### Phase 6 — Proving the walls

- **verify.mjs**, new checks, each with its twin:
  - a `staff` token cannot insert a document / a unit / a rate / a holiday;
    an `admin` token can (each);
  - a `staff` token CAN insert and read a booking and a resolution;
  - a chat token still reads 0 rows of `tenants`, `platform_admins`,
    `memberships`; a staff token still reads 0 rows of `tenants`;
  - a platform token with a `platform_admins` row lists all tenants (count
    equals `service_role`'s), archived included; the same token with the
    row deleted lists 0 (the claim-without-row check, Rule 1);
  - a platform token reads 0 `chunks`, 0 `bookings`, 0 `documents` (no
    tenant claim → every tenant policy false);
  - an `owner` token updates a role in its tenant and cannot in another
    (0 rows, then the twin); a `staff` token updates 0;
  - the last-owner trigger refuses; the theme constraint refuses `url(…)`;
    `tenant_public` returns 0 rows for an archived slug and 1 after unarchive;
  - `max_stay_nights: 3` → 3 accepted, 4 refused; silent config → 14 / 15.
- **Both isolation suites**, both ways, still green, plus: a platform token
  through the pipeline reads nothing from any tenant.
- **staff-cases.mjs** (HTTP): `staff` → 403 on documents POST, 200 on
  bookings POST; `admin` → 403 on members; `owner` → 200 on members; a
  removed super → 401 on `/api/platform/tenants`; a staff cookie sent by
  hand to `/api/platform/…` → 401.
- **Battery:** 59/61, snapshots and baselines byte-identical (Rule 3).
- **Bundle:** `pnpm build`, then the CLAUDE.md rule 2 grep, extended with
  `app_super|platform_admins|TENANT_SIGNING_JWK` values → nothing.
- plan.md Phase 3's grep: every new query carries a tenant, or is a
  platform query on a table that has no tenant (`tenants`, `platform_admins`).

### Phase 7 — The browser walk

As super: log in at `/platform`, create `probe-tm`, set its theme and
watch the preview, enable bookings, set max stay 3 and horizon 60, add the
user's own email as `owner`, open `/t/probe-tm/admin`, see every tab; on
`/t/probe-tm/book`, 4 nights is refused and the calendar ends at day 60.
Demote self to `staff`: S-5 and S-7 tabs gone, Members gone, documents
read-only, bookings still writable; a hand-made POST to documents → 403
with the permission named. Archive: `/t/probe-tm` and its chat are 404.
`tenant:remove -- probe-tm --yes`: the counts print, the sweeper says 0.

### Phase 8 — The record

- `decisions.md`: D-075 roles (reverses D-041 as it said it would),
  D-076 the platform token (amends D-039 and rule 8), D-077 archive not
  delete, D-078 per-tenant booking limits in config (amends customer-booking
  § 8 q8's "policy, not measurements"), D-079 one permission table and two
  walls (extends D-038), D-042 amended to six definer functions.
- `risks.md`: R-42 email probing through `user_id_by_email()`; R-43 the
  super account is a master account (its password is the platform); R-44
  the platform cookie and the staff cookie share `ADMIN_COOKIE_SECRET`.
- `CLAUDE.md`: the header paragraph, layout, commands, rules 3 and 8, trap
  22 (a role is a row, read per request). `flow.md`: the platform path.
- `status.md`, `whats-done.md`, with the observed numbers from every phase.

---

## 6. What must not change

| | Before | After |
|---|---|---|
| `pnpm eval` | 59/61 | 59/61, verdict for verdict |
| prompt snapshot, tool baselines | match | byte-identical |
| pipeline isolation | 20 + 20 | 20 + 20 (+ the platform-token check) |
| bookings isolation | 29 + 29 | 29 + 29 |
| rooms | 30 | 30 |
| `check-service-imports` | clean | clean |
| the web app's env | no service key | no service key |

---

## 7. The commands this plan adds

```sh
pnpm --filter @rag/db super:add -- <email>            # the bootstrap; invites a new account
pnpm --filter @rag/db super:remove -- <email>
pnpm --filter @rag/db super:list
pnpm --filter @rag/db member:add -- <slug> <email> [owner|admin|staff]   # default admin
pnpm --filter @rag/db member:role -- <slug> <email> <owner|admin|staff>
pnpm --filter @rag/db tenant:archive -- <slug> [--undo]
pnpm --filter @rag/db tenant:remove -- <slug> --yes   # hard delete + storage-orphans --remove
(cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/tenant-management-phase4-walk.mjs)   # needs pnpm dev
```

---

## 8. Questions, each with a recommendation · **answered 2026-09-29, every recommendation taken**

The user asked for the recommendations to stand. Each item below keeps its
reasoning and now ends with the decision, so the phases can cite it as
"§ 8 q<n>" and Phase 8 can log it as a D-number.

1. **Role names.** The request says `SUPER_USER`, `BUSINESS_OWNER`,
   `BUSINESS_ADMIN`, `BUSINESS_STAFF`. **Recommend** `owner | admin | staff`
   in `memberships.role`, and `super` as a table, not a value (§ 2.1). The
   `BUSINESS_` prefix is what the row's `tenant_id` already says, and a
   check constraint on three short words reads better in every policy.
   The screens may label them however the user likes.
   **Decided:** `owner | admin | staff` in `memberships.role`; the super user is a `platform_admins` row. Screens label the roles "Owner", "Admin", "Staff" and "Platform".
2. **May an owner edit their own branding and fallback messages?** The
   request says the form is the super user's. **Recommend** no in this
   plan, and note that it is one more policy on `tenants` (`app_role() =
   'owner'` for `update` of the branding columns only) and a Settings tab
   later, because the column boundary would then need a column list again.
   **Decided:** no. The tenant form is the super user's; owners get no write on `tenants` in this plan. Logged as a follow-on in § 8 of Phase 8's record.
3. **Inviting a brand-new account from the browser.** Needs GoTrue's admin
   invite, so `service_role`, which Rule 2 forbids in a request.
   **Recommend** the Members screen adds EXISTING accounts only, and says
   so with the CLI command for a new one. A later plan could hold a
   `pending_invites` table and send a magic link through the anon client
   (`signInWithOtp` with `shouldCreateUser`), turning the row into a
   membership on first login. Not now: email is capped (R-21) anyway.
   **Decided:** existing accounts only in the browser; a new account is `member:add` at the CLI, and the Members screen prints that command when an email has no account.
4. **`user_id_by_email()` lets an owner learn whether an email has an
   account.** **Recommend** accept and log as R-42: owner-only, and an
   owner is trusted staff of a paying tenant. The alternative, "always say
   added", hides mistakes from the person fixing them.
   **Decided:** accept. `user_id_by_email()` is owner-only and answers found or not found; logged as R-42.
5. **Can a super user open a tenant's admin screens without a membership?**
   **Recommend** no (§ 2.1). One button on the platform form, "Make me an
   owner", writes the membership on the super token, and from there it is
   an ordinary staff session on a staff token. Every tenant screen keeps one
   guard.
   **Decided:** no. "Make me an owner" on the platform form writes the membership on the super token; the tenant's screens keep one guard, `requireAdmin()`.
6. **Slots when bookings is switched on.** A tenant with the application
   and no `slots` rows can book nothing; slots are seeded by scripts today.
   **Recommend** out of scope, and the form shows "no slots yet: run
   `customer-booking-villa-rates.mjs`'s equivalent" until a Slots editor is
   planned. It is a small plan of its own, with its own rule about live
   bookings.
   **Decided:** out of scope. The form shows "no slots yet" with the script to run; a Slots editor is its own plan.
7. **Switching an application OFF while bookings exist.** **Recommend**
   the D-055 rule: refused by a trigger while any booking has not ended;
   allowed after, and the rows stay for when it is switched back on.
   **Decided:** a `before delete` trigger on `tenant_applications` refuses while any booking of the tenant has not ended (D-055's rule); afterwards the row goes and the units, slots and bookings stay.
8. **Backfill.** Every existing membership becomes `admin` (what D-041 said
   it meant). **Recommend** the user then promotes the real owners with
   `member:role`, one line each, and the operators stay `admin`, which is
   exactly what the eval and isolation suites need.
   **Decided:** every existing membership becomes `admin` in Phase 1's backfill; the user promotes the real owners with `member:role` after Phase 2, and the operators stay `admin`.
