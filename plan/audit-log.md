# Audit log plan: who did what, as staff and as a super user, kept in Postgres

> Bookings already have a log: every creation and status change of a stay is
> a `booking_events` row, written by a trigger, shown as the stay's History
> on S-15 (D-104). **Nothing else is.** A document deleted, a rate changed, a
> member promoted, a promo retired, a feature switched off, a tenant
> archived, a staff login: each exists only as a `console.log` line
> (`[platform]`, `[members]`, `[ingest]`) that the dev server prints and
> nobody keeps. R-13 has said since 2026-09-20 that an audit log comes
> before a public URL. This plan adds **one append-only table,
> `audit_log`**, filled by Postgres itself for every table that staff or a
> super user may change, plus the few actions that are not a row (a login,
> a proof opened), and **S-18 Activity**: a tenant's owners read their own
> log, a super user reads any tenant's and the platform's own.
>
> Written 2026-10-20, against `e6fa5d0` on `master`, while `feat/rate-limit`
> (plan/rate-limit.md, D-137, `schema-rate-limit.sql` the 42nd file, verify
> 225–229) is being built in a parallel session: this plan's numbers start
> after that one's. **Status: planned; § 7's eight questions answered
> 2026-10-20, every recommendation taken, by the user's instruction. To be
> built on `master` once `feat/rate-limit` has merged, on a branch
> `feat/audit-log`, one commit per phase, the suites after Phase 5.**
>
> Read [§ 0](#0-the-five-rules) first.

---

## What this plan covers

| | |
|---|---|
| **In scope** | One table, `audit_log` (`sql/schema-audit-log.sql`, the 43rd file): append-only, per tenant (or platform-wide, `tenant_id null`), written by ONE generic trigger function, `audit_row()`, attached to every table a staff or platform token may insert, update or delete, and by ONE definer, `audit_note()`, for the three actions that are not a row write. `app_actor_kind()` says who: `staff`, `super`, `system`. ONE `security invoker` read function, `activity_list()`, filtered by window, actor and area, keyset-paged, that refuses a non-owner itself. A permission, `activity:read` (owners; grantable to admins). S-18 `/t/<slug>/admin/activity` and an **Activity** tab on the platform's tenant form, plus a platform-wide list. Retention: `audit_retention_days` per tenant, swept by the existing `retention` tool. verify, both isolation suites, a walk, the a11y run; the record: D-138, R-54, R-13 amended |
| **Out of scope** | Logging bookings, payments, change requests and stays again: `booking_events` is their log (Rule 2). Logging a guest's actions (a chat, a booking request, a proof sent): those are guest events, in `messages` and `booking_events` already. Logging reads (which document a member opened): writes only, except the three in § 2.3. Failed logins (§ 2b.4: Supabase's own `auth.audit_log_entries` has them, and a chat token must not be able to write our log). Exporting the log. Alerts on it. Tamper-proofing beyond "no token can update or delete a row" (§ 7 q6). Any change to the chatbot: no prompt text, no tool text, nothing new in a tool result |

### What the request assumes, and what is actually here

| Assumption | What exists today | What the plan does |
|---|---|---|
| "Actions are logged somewhere" | Bookings: `booking_events`, trigger-written, append-only (D-104). Everything else: `console.log` lines in `platform.ts`, `members.ts`, `ingest.ts`, which the dev server prints and nothing stores. Supabase keeps `auth.audit_log_entries` for sign-ins, sign-outs and password changes, readable in its dashboard only | Keeps `booking_events` as the ONE log of a stay; adds `audit_log` for everything else; leaves the console lines (CLAUDE.md § Conventions: they are deliberate) |
| "We know who did it" | Every staff write runs on a staff token whose `sub` is the member (D-075); every platform write on a platform token with `sub` and `app_super` (D-076); tools run as `service_role` or the tenant's operator member. `app_actor()` (`schema-manage-booking.sql`) already turns the claims into `guest`/`staff`/`system` for `booking_events` | `app_actor_kind()` extends that to `super`, read in the trigger from `auth.uid()` and `app_is_super()`; the user id is stored, the email looked up at read time through `member_emails()` as stay notes do (D-132) |
| "A trigger per table is a lot of code" | 15 tables take staff or platform writes (§ 2.1). The pattern exists: `booking_events` is written by triggers, `stays` by `bookings_ac_*` triggers | ONE trigger function with ONE `case` on `TG_TABLE_NAME` that names the columns worth keeping per table (§ 1.2); attaching it is one line per table |
| "Guest details must not leak into it" | `bookings`, `stays`, `payments` and `stay_notes` hold names, phones, emails and amounts; D-131 removes them after the guest retention period | Those tables are NOT audited (Rule 2 and § 2.1); `stay_notes` is audited as "note added/deleted" with the id only, never the body (Rule 3) |
| "Owners want to see it" | Owners manage members (D-075), the only role that already sees who is who | `activity:read` is the owner's by default; a super user can grant it to admins on the Permissions tab (D-128) |

---

## 0. The five rules

### Rule 1 — Postgres writes the log, never a route

`audit_log` has NO insert policy for any token. Rows come from the
`audit_row()` trigger on each audited table and from `audit_note()`, a
definer that writes the three named actions of § 2.3 and nothing else. A
route cannot forget to log, cannot log something that did not happen, and
cannot write a row that names another actor: the actor is `auth.uid()` at
the moment of the write. This is `booking_events`' rule (Rule 1 of
plan/manage-booking.md), applied to everything else.

### Rule 2 — One event, one table

A stay's events stay in `booking_events`. `audit_row()` is not attached to
`bookings`, `stays`, `payments`, `change_requests` or `booking_events`, so no
action is recorded twice and no guest's name, phone, email or amount enters
`audit_log`. S-18 shows both logs in ONE list through `activity_list()`,
which reads `booking_events` as a second source (the stay's reference, the
kind, the actor; never the note, which may hold guest details). A row from
`booking_events` links to S-15; the facts are there.

### Rule 3 — The log holds what changed, not what it was

A row stores the table, the operation, the row's key, and for an UPDATE the
**names** of the changed columns plus the before and after of a SHORT,
NAMED allowlist per table (a document's title, a unit's name, a member's
role, a feature's `enabled`, a tenant's slug and archive state). Never a
document's content, a chunk, an embedding, a note's body, a promo code's
usage, a push subscription, a password or token of any kind. The allowlist
is the `case` in `audit_row()` (§ 1.2): a column not named there is logged
as changed, by name, and nothing more. What a value WAS is on the row, or
in git, or gone; the log says who touched it and when.

### Rule 4 — Two walls, and the reader is checked twice

`audit_log` has a read policy: `tenant_id = app_tenant_id() and
app_can('activity:read')`, so a staff token of another tenant reads 0 rows
and a chat token reads 0 rows (Wall 2). `activity_list()` is `security
invoker`, reads under that policy, and ALSO raises `insufficient_privilege`
for a caller without the permission, as `conversation_list()` does (Wall 1,
and a refusal instead of an empty page). Platform rows (`tenant_id null`)
are readable by `app_is_super()` alone; a tenant's owner sees a super
user's action on THEIR tenant (it carries their `tenant_id`), never on
another's. `pnpm --filter @rag/db verify` proves each wall alone (Phase 5).

### Rule 5 — The chatbot does not change

No prompt text, no tool text, no `language.ts` or `dates.ts` line, nothing
new in a tool result. The three baselines stay byte-identical, and the
battery is not re-run for this plan (it cannot be: northwind and harbor are
deleted; Phase 0 records the three snapshots instead).

---

## 1. The data model

### 1.1 The table

```sql
create table audit_log (
  id          bigint      generated always as identity primary key,
  tenant_id   bigint      references tenants (id) on delete cascade,   -- null: a platform-wide action
  at          timestamptz not null default now(),
  actor_kind  text        not null check (actor_kind in ('staff', 'super', 'system')),
  actor_user  uuid,                                                     -- auth.uid(); null for system
  area        text        not null,   -- 'documents', 'rooms', 'rates', 'photos', 'holidays', 'slots', 'promos', 'members', 'permissions',
                                      -- 'features', 'applications', 'tenant', 'payment_settings', 'unanswered', 'stay_notes', 'session', 'proof', 'platform'
  action      text        not null,   -- 'insert', 'update', 'delete', or a named one: 'login', 'logout', 'proof_opened'
  subject     text,                   -- the row's key as text ('42', a uuid, 'villa'), or the member's user id
  label       text,                   -- a short name for the row, from the allowlist: the title, the unit's name, the slug
  changed     text[],                 -- UPDATE: the columns that differ
  before      jsonb,                  -- UPDATE/DELETE: the allowlisted columns' old values
  after       jsonb                   -- INSERT/UPDATE: the allowlisted columns' new values
);
create index audit_log_tenant_idx on audit_log (tenant_id, at desc, id desc);
create index audit_log_platform_idx on audit_log (at desc, id desc) where tenant_id is null;
alter table audit_log enable row level security;
-- read: the tenant's, with the permission; platform rows: super users.  NO insert, update or delete policy.
```

`subject` and `label` are text so one table serves every area; the screen
links a subject to its screen where one exists (a document to S-2, a room
to S-5, a member to S-8). `before`/`after` are `jsonb` so the screen draws
"Weekend rate: ₱12,000 → ₱15,000" from one row without knowing the table.

### 1.2 The trigger

```sql
create or replace function audit_row() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant bigint; v_area text; v_subject text; v_label text; v_keep text[];
begin
  -- The case names, per table: the area, where the tenant id is, the key, the label column, the allowlist.
  case tg_table_name
    when 'documents'          then v_area := 'documents';       v_keep := array['title'];
    when 'units'              then v_area := 'rooms';           v_keep := array['name', 'capacity', 'standard_capacity', 'extra_person_rate', 'active', 'sort_order'];
    when 'unit_rooms'         then v_area := 'rooms';           v_keep := array['name', 'active'];
    when 'unit_rates'         then v_area := 'rates';           v_keep := array['weekday_price', 'weekend_price', 'holiday_price'];
    when 'unit_images'        then v_area := 'photos';          v_keep := array['sort_order'];
    when 'rate_calendar'      then v_area := 'holidays';        v_keep := array['day', 'kind', 'label', 'surcharge'];
    when 'slots'              then v_area := 'slots';           v_keep := array['name', 'start_time', 'duration', 'nightly', 'active'];
    when 'promos'             then v_area := 'promos';          v_keep := array['name', 'kind', 'value', 'valid_from', 'valid_to', 'code', 'max_uses', 'active'];
    when 'memberships'        then v_area := 'members';         v_keep := array['user_id', 'role'];
    when 'role_permissions'   then v_area := 'permissions';     v_keep := array['role', 'permission', 'allowed'];
    when 'tenant_features'    then v_area := 'features';        v_keep := array['feature', 'enabled'];
    when 'tenant_applications' then v_area := 'applications';   v_keep := array['application_key', 'config'];
    when 'tenants'            then v_area := 'tenant';          v_keep := array['slug', 'business_name', 'assistant_name', 'logo_url', 'banner_url', 'theme', 'archived_at', 'dpa_signed_on', 'privacy_contact_name', 'privacy_contact_email', 'policy_version', 'chat_retention_days', 'guest_retention_days', 'audit_retention_days', 'fallback_messages', 'suggested_questions'];   -- never admin_key_hash (legacy, R-19)
    when 'unanswered_resolutions' then v_area := 'unanswered';  v_keep := array['message_id'];
    when 'stay_notes'         then v_area := 'stay_notes';      v_keep := array['group_id'];        -- the body is NEVER kept (Rule 3)
    when 'platform_admins'    then v_area := 'platform';        v_keep := array['user_id'];
    else raise exception 'audit_row: % is not an audited table', tg_table_name;
  end case;
  -- tenant_id: the row's own column; tenants.id for tenants; null for platform_admins.
  -- changed: the columns whose value differs, by comparing to_jsonb(old) and to_jsonb(new) key by key (a one-line lateral).
  -- before/after: jsonb_strip_nulls(to_jsonb(old/new)) filtered to v_keep.
  insert into public.audit_log (tenant_id, actor_kind, actor_user, area, action, subject, label, changed, before, after) values (...);
  return null;   -- AFTER trigger; it never alters the write
end $$;
```

Every audited table gets `create trigger <table>_audit after insert or
update or delete on <table> for each row execute function audit_row();`.
An UPDATE that changes nothing in `v_keep` and nothing else (a no-op save)
writes no row: `changed = '{}'` is skipped. `documents` is audited on
INSERT and DELETE only: an edit is a new id (D-044), so "edited" appears as
delete + insert of the same title, and the screen folds those two into
"edited" when they are seconds apart with one label (§ 3). `chunks` is
not audited: it follows its document.

### 1.3 Who

```sql
create or replace function app_actor_kind() returns text ... as $$
  select case
    when auth.uid() is null then 'system'                                  -- service_role, a direct session, a chat token (which cannot reach these tables)
    when (select public.app_is_super()) then 'super'
    else 'staff'
  end $$;
```

`app_is_super()` demands a `platform_admins` row (D-076), so a staff
member who is also a super user is logged as `super` only when acting on
the platform token. A tool run as the tenant's operator member (D-038,
§ 2.7) is `staff` with the operator's id: the walks' own writes are logged
as the operator, which is the truth. `service_role` writes (the loaders,
`tenant:remove`, `retention`) are `system`.

### 1.4 The three named actions

`audit_note(p_tenant_id bigint, p_action text, p_subject text)` is
`security definer`, `search_path = ''`, and writes ONE row with
`area = 'session'` or `'proof'` and `actor_user = auth.uid()`. It accepts
exactly `('login', null)`, `('logout', null)` and `('proof_opened',
<payment id>)`, refuses any other action, refuses a caller with no `sub`
(so a chat token cannot write), and refuses a tenant that is not the
token's. The session routes call it after a successful sign-in and on
sign-out; the proof route (`GET /payments/[id]/proof`) calls it when it
mints the signed URL, because opening a guest's receipt is the one READ
worth a record (R-46).

### 1.5 Retention

`tenants.audit_retention_days int not null default 730`, between 90 and
3650, in `tenants_retention`'s check. `audit_older_than(p_tenant_id,
p_before)` lists and the `retention` tool deletes, `service_role` only, as
chats are handled (D-131). Platform rows (`tenant_id null`) are kept 730
days, a constant in the tool. Since the log holds no guest details (Rules
2, 3), `remove_guest_details()` does not touch it.

---

## 2. What is logged

### 2.1 Row writes, by the trigger

| Area | Table | Who writes today | Insert | Update (what `changed` can name) | Delete |
|---|---|---|---|---|---|
| documents | `documents` | staff (`documents:write`), the platform (D-128) | title | — (an edit is delete + insert, D-044) | title |
| rooms | `units`, `unit_rooms` | admins (`rooms:write`) | name | name, capacities, fee, active, order | name (a never-booked room only) |
| rates | `unit_rates` | admins | unit + slot | the three prices, before → after | — |
| photos | `unit_images` | admins | unit, order | order | unit |
| holidays | `rate_calendar` | admins (`holidays:write`) | day, kind, label, surcharge | kind, label, surcharge | day |
| slots | `slots` | admins (`slots:write`) | name | name, time, length, nightly, active (retire) | name |
| promos | `promos` | admins (`promos:write`) | name | every field but uses | name |
| members | `memberships` | owners (`members:manage`), the platform, the CLI | user, role | role (a promotion or demotion) | user |
| permissions | `role_permissions` | the platform only | role, permission, allowed | allowed | role, permission |
| features | `tenant_features` | the platform only | feature, enabled | enabled | feature (= back to the default) |
| applications | `tenant_applications` | the platform, the CLI | key, config | config (timezone, booking type, holds, max stay, horizon, payment settings) | key |
| tenant | `tenants` | the platform, the CLI | slug, business name | the allowlist of § 1.2: archive and unarchive are `archived_at` | — (`tenant:remove` cascades; the log goes with it, § 7 q5) |
| unanswered | `unanswered_resolutions` | staff (`unanswered:write`) | message id | — | message id (reopen) |
| stay notes | `stay_notes` | staff (`bookings:write`) | group (the stay's reference is looked up at read time) | — | group |
| platform | `platform_admins` | `super:add` / `super:remove` (service_role) | user | — | user |

Payment settings live in `tenant_applications.config` (D-107), so a
change to the amount due or the deadlines is an `applications` row whose
`changed` names `config`; the screen says "Payment settings" when the
diff touches those keys and "Bookings config" otherwise.

### 2.2 Not logged, on purpose

`bookings`, `stays`, `payments`, `change_requests`, `booking_events` (Rule
2); `chunks` (follows its document); `conversations`, `messages`,
`guest_lookup_failures`, `notification_outbox`, `notification_reads`,
`push_subscriptions` (guest or machine writes, no staff decision in them);
`rate_windows` (the shared rate limit's counts, D-137). A token's reads, with the one exception below.

### 2.3 Named actions, by `audit_note()`

| Action | Where | Why it is a row |
|---|---|---|
| `login` | `POST /admin/session`, after `signInStaff()` succeeds; `POST /api/platform/session` for a super user (`tenant_id null`) | "Who was signed in that afternoon" is the first question after any incident. Supabase's `auth.audit_log_entries` has it too, but in its dashboard only, by user id, not by tenant |
| `logout` | `DELETE` on the same routes | The end of the window above |
| `proof_opened` | `GET /payments/[id]/proof`, when the 5-minute signed URL is minted | The one read that shows a guest's bank or GCash receipt (R-46); the payment id is the subject, never the file |

A FAILED login is not a row (§ 2b.4). A password reset is Supabase's row
(`auth.audit_log_entries`, `user_recovery_requested`), not ours.

---

## 2b. Traps

### 2b.1 The trigger inherits nothing; it must qualify every name

Trap 19 (CLAUDE.md): a trigger fired from inside a definer with
`search_path = ''` sees no `public`. `audit_row()` sets `search_path = ''`
itself and writes `public.audit_log`; the `case` compares `tg_table_name`,
which is bare by definition. `move_room()`, `review_payment()`,
`decide_change()` and `request_booking()` all write tables that are NOT
audited, so no definer fires it today; `tenant_applications_validate()`
runs before the row lands and does not matter. The first run is a staff
write from the browser, the second a platform write, the third
`member:add` on `service_role`: three callers, three token shapes
(Phase 1).

### 2b.2 `auth.uid()` inside a trigger fired by a definer

A definer runs with its owner's privileges but the CALLER's JWT claims:
`auth.uid()` still reads `request.jwt.claims`. `booking_events` relies on
this already (`app_actor()`), so a staff action through a definer logs the
member, not `postgres`. verify's positive twin: a row written through a
definer carries the member's id (Phase 5).

### 2b.3 A no-op UPDATE is not an event

Every screen's Save sends the whole form; most fields are unchanged.
Without the `changed = '{}'` skip, the Rooms screen would log one row per
room per save, and the log would be the noise the console lines are today.
`updated_at` columns (`unit_rates`, `role_permissions`, `tenant_features`)
are excluded from the comparison for the same reason. Phase 4's walk saves a room unchanged and
expects 0 rows.

### 2b.4 A chat token must not be able to write the log

`audit_note()` is callable by `authenticated`, which includes the chat
token. It therefore refuses a caller whose `auth.uid()` is null before it
does anything else, and that refusal is verify's check. This is why a
failed login is not logged: at that moment there is no staff token, only
the chat token the public page runs on, and a definer that let it write
`'login_failed'` rows is a definer a visitor could fill with 10,000 rows a
minute. Supabase throttles and records failed sign-ins itself (R-13).

### 2b.5 `tenant:remove` takes the log with it

`audit_log.tenant_id` cascades on delete, like everything else (D-077):
a hard-deleted tenant leaves no rows, including the record of who deleted
it. The `tenant:remove` tool prints the audit row count among its 13 (now
14) and, after the delete, writes ONE platform row (`tenant_id null`,
`area 'platform'`, `action 'tenant_removed'`, `label` the slug) through a
direct insert on `service_role`, the one insert outside the trigger and
the definer (§ 7 q5).

### 2b.6 Re-running older files

`schema-audit-log.sql` attaches triggers; none of the earlier 42 files
knows them, and `create table if not exists` elsewhere does not drop them.
Trap 25 still applies: re-run an older file only to test today's guard,
then re-apply everything after it, this file included.

---

## 3. The screens

### S-18 `/t/<slug>/admin/activity` — the tenant's log

- In the sidebar under **Setup**, after Members, for a role with
  `activity:read` (owners by default); 404 for the rest, like Members.
- One list, newest first, keyset-paged by `(at, id)` like S-16: a row is
  **who** (the member's email from `member_emails()`, "a former member",
  "Platform" for a super user, "System"), **what** in words
  (`activityWords()` in `lib/activity-words.ts`, pure, tested: "deleted the
  document *House rules*", "changed Garden Room's weekend rate from
  ₱12,000.00 to ₱15,000.00", "made maria@… an admin (was staff)", "switched
  Voice on", "confirmed VIL-ABC123" from `booking_events`), **when** in the
  tenant's zone (`when()` from `stay-words.ts`), and a link to the subject's
  screen where one exists.
- Filters in the URL as S-16 does: `?days=7|30|90`, `?area=`, `?who=<user
  id>`; `?q=` matches the label. Delete + insert of one document title
  within 10 s by one actor is drawn as ONE row, "edited" (§ 1.2).
- A `booking_events` row says "see the booking" and links to S-15; its note
  is never shown here (Rule 2).
- `LoadState`, `EmptyState` ("Nothing yet. Actions on this workspace appear
  here as they happen."), a `.notice` line saying how long the log is kept
  (`audit_retention_days`).

### The platform

- The tenant form gains an **Activity** tab: the same list for that
  tenant, read on the platform token through `activity_list()`, which
  admits `app_is_super()` for any tenant (Rule 4).
- The tenant list's Pulse strip gains nothing. A new page,
  `/platform/activity`, lists platform-wide rows (`tenant_id null`: super
  users added and removed, tenants created, `tenant_removed`, super-user
  logins) and, with `?tenant=`, one tenant's.

### Links in

- S-8 Members: "See what members did" → S-18 `?area=members`.
- S-2 Knowledge base: nothing (the document list is the current state;
  the log is a click away in the sidebar).
- S-15: unchanged. Its History IS the stay's log.

---

## 4. The read function

```sql
activity_list(p_tenant_id bigint, p_days int, p_area text, p_actor uuid, p_q text, p_before_at timestamptz, p_before_id bigint, p_limit int)
  returns jsonb   -- { timezone, days, total, more, rows: [{ id, at, actorKind, actorUser, actorEmail, area, action, subject, label, changed, before, after, source }] }
```

`security invoker`, `search_path = ''`: it reads `audit_log` under the
caller's policy and `booking_events` under its own staff policy, unions
them ordered by `(at, id)`, and raises `insufficient_privilege` for a
caller that is neither `app_can('activity:read')` for that tenant nor a
super user. `actorEmail` comes from `member_emails()` for current members;
a removed member's rows keep the id and show "a former member". `total`
and `more` as `conversation_list()` returns them.

---

## 5. Phases

Commit per phase; the suites, the walk and the a11y run at the end
(memory: checks after the last phase).

### Phase 0 — Baseline
`pnpm typecheck`, `pnpm test` (web 193), verify 229 (after rate-limit Phase 1), bookings isolation
42 both ways, pipeline isolation 24 both ways; the three prompt snapshots
diffed against their baselines (Rule 5). Count today's audited tables'
rows for villa and alteza so Phase 1 can show the triggers changed none.

### Phase 1 — SQL (`schema-audit-log.sql`, the 43rd)
The table, the two indexes, the read policy; `app_actor_kind()`;
`audit_row()` and the 16 triggers; `audit_note()`; `activity:read` in
`app_can()`'s list and its `<table>_may_select` twin (D-128: a new
permission needs both lists); `audit_retention_days` and
`audit_older_than()`; `activity_list()`. Applied with the scratch pg
client (memory: apply .sql files myself). Three first runs: a staff
write, a platform write, a `service_role` write; read the rows back.

### Phase 2 — `@rag/db` and `@rag/pipeline`
`lib/permissions.ts`: `activity:read` (owner; grantable). `verify.mjs`
230–241: no token inserts, updates or deletes `audit_log` (the negative
checks and their positive twins: a staff update of a unit writes exactly
1 row with the member's id and `changed = {name}`; a no-op update writes
0; a platform feature switch writes 1 `super` row; a chat token calling
`audit_note()` is refused; another tenant's owner reads 0 of villa's rows
while villa's owner reads N > 0; a staff member without the permission
gets `insufficient_privilege` from `activity_list()`, an owner a list; a
row through a definer carries the member's id; `audit_older_than()` is
`service_role` only). `packages/rag/src/activity.ts`:
`listActivity()` over `activity_list()`, typed. `tools/retention.mjs`
sweeps `audit_log` too, counted. `tools/tenant.mjs`: the 14th count and
the `tenant_removed` row.

### Phase 3 — Routes
`GET /api/t/[tenant]/admin/activity` on `requireAdmin(request, tenant,
'activity:read')`; `GET /api/platform/tenants/[id]/activity` and `GET
/api/platform/activity` on `withPlatformRoute()`. The session routes
(tenant and platform) call `audit_note('login'|'logout')`; the proof
route calls `audit_note('proof_opened', id)`. `lib/activity-words.ts`,
pure, tested. `lib/nav-items.ts`: `activity` under Setup with its
permission; `lib/features.ts` is NOT touched (§ 7 q4).

### Phase 4 — Screens
S-18 (`activity-screen.tsx`: `LoadState`, the filters in the URL as
`conversation-words.ts` does them, keyset "Show more"), the platform's
Activity tab and `/platform/activity`. The Members screen's link in. The
walk, `plan/audit-log-walk.mjs`, on villa as a throwaway owner: rename a
room and see "renamed", save it unchanged and see no new row, add and
remove a member, switch a feature as a super user and see "Platform",
open a proof and see "opened the proof", log out and in and see both;
a staff member without the permission gets no sidebar link and a 403;
the screens at 1280 and 390. Cleans up by the ids it made (trap 26).

### Phase 5 — The walls and the record
verify 241/241, both isolation suites (a new check each: a platform token
reads a tenant's audit rows through `activity_list()` only, 0 by the
policy; an owner's staff token reads only its tenant's), `pnpm test`,
`pnpm typecheck`, the a11y run over S-18 and the platform tab (0
violations), the three snapshots unchanged. The record: D-138 here and in
CLAUDE.md (the table, the rules, "a new table that staff write needs a
trigger line in `schema-audit-log.sql`"), R-54 (the log is as safe as
`service_role`: whoever holds the key can delete rows), R-13 amended
("the audit log exists; the rate limit on our own endpoints is still
owed, R-39"), status.md and whats-done.md.

---

## 6. What must not change

- `booking_events`: no new kind, no new writer, no column.
- The chatbot: no prompt text, no tool text, no tool result field; the
  three baselines byte-identical.
- `request_booking()`, `move_room()`, `review_payment()`, `decide_change()`
  and the other definers: not re-created. The triggers are AFTER triggers
  on tables those functions do not write.
- Every policy that exists. The new table has its own.
- The `[platform]`, `[members]` and `[ingest]` console lines: kept.
- `tenant:remove` still cascades; the log is not an exception.

---

## 7. Questions, each with a recommendation · **answered 2026-10-20, every recommendation taken**

1. **Who reads a tenant's log?** Owners only (`activity:read` fixed to
   owner), or owners by default and grantable to admins on the Permissions
   tab? **Recommendation: grantable**, because a resort's day-to-day admin
   is often the person who would ask "who changed the rate", and D-128
   exists for exactly this.
2. **Does the tenant's log show the super user's actions on it?** A feature
   switched, a permission changed, a member added from the platform.
   **Recommendation: yes, as "Platform"** with no email: the owner should
   see that something changed from outside, and the super user's identity
   is the platform's business (`/platform/activity` names them).
3. **Do we log `proof_opened`?** It is the only read in the plan.
   **Recommendation: yes**: it is the one read that shows a guest's bank
   details, and "who looked at the receipts" is a question the Data Privacy
   Act's accountability principle expects an answer to.
4. **Is Activity a feature flag (D-127)?** **Recommendation: no.** The LOG
   is always written (a tenant cannot switch off its own audit trail, and
   a super user should not switch off a tenant's); the SCREEN is a
   permission, not a feature. A future "hide the screen" is a one-line
   feature key if a tenant asks.
5. **What survives `tenant:remove`?** The cascade removes the tenant's rows.
   **Recommendation: one platform row, `tenant_removed`,** written by the
   tool itself on `service_role` after the delete (§ 2b.5), so the
   platform's list says the tenant existed and who removed it. Anything
   more (an export before delete) is a later plan.
6. **Tamper-proofing?** No token can update or delete a row (no policy),
   but `service_role` can, and so can anyone with `DATABASE_URL`.
   **Recommendation: record it as R-54 and stop there.** A hash chain or a
   second store is deployment work (D-013), and nothing in this project
   has a threat model where the operator is the adversary.
7. **Retention default?** 730 days, 90–3650. **Recommendation: 730**: two
   years covers a dispute over last season's rates and a DPA request, and
   the rows are small (no bodies, no embeddings).
8. **Failed logins?** Not ours (§ 2b.4). **Recommendation: leave them to
   Supabase**, and say so on S-18's notice line, so nobody looks for them
   here.
