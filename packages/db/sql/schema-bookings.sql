-- schema-bookings.sql — bookings Phase 1: applications, and the first one.
--
-- Run this ONCE in the Supabase SQL editor, after schema.sql, schema-hybrid.sql
-- and schema-tenancy.sql. It is idempotent, so a second run is harmless.
-- Source: plan/bookings.md § 1 (the data model) and § 3 Phase 1.
--
-- THE ONE THING TO KNOW
-- ---------------------
-- A booking is the span of time it actually occupies (`during`, a tstzrange),
-- not a date and not a room. Two live bookings of the same unit may not
-- overlap, and Postgres enforces that with an exclusion constraint (step 5).
-- Villa Amihan's "only one slot is sold per day", and its slots that cross
-- midnight, follow from range overlap alone. No booking rule is written in
-- application code (plan/bookings.md § 2.1, § 2.2).
--
-- Tenant isolation is the same as everywhere else: service_role bypasses RLS,
-- so every table carries tenant_id, children point at parents with composite
-- foreign keys, and the one function takes p_tenant_id with no default
-- (CLAUDE.md rule 6).

-- 1. btree_gist. The exclusion constraint compares `unit_id with =` inside a
--    GiST index, and GiST has no equality operator for bigint without this.
--    Supabase ships the extension, but it has to be enabled.
create extension if not exists btree_gist;

-- 2. Which tenant has which application.
--
-- The applications themselves are code (packages/rag/src/applications.ts). A
-- row cannot create one. It only switches one on for a tenant, so having a row
-- means "enabled" and there is deliberately no `enabled` column (D-033). The
-- `check` lists the same keys as the registry, so a typo'd key fails here
-- rather than silently enabling nothing.
create table if not exists tenant_applications (
  tenant_id       bigint not null references tenants(id) on delete cascade,
  application_key text   not null,
  config          jsonb  not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  primary key (tenant_id, application_key),
  constraint tenant_applications_key check (application_key in ('bookings'))
);

-- `bookings` needs a timezone, and there is NO default. A UTC default would
-- shift every booking of a Manila resort by eight hours and raise no error
-- (plan/bookings.md § 2.3). `now() at time zone <name>` raises 22023 for a
-- name Postgres does not know, so an invalid timezone fails on write rather
-- than on the first booking.
-- GUARDED (tenant management Phase 1, 2026-09-29): schema-roles.sql replaces
-- this (as schema-booking-types.sql did before it).
-- Once that file has run (platform_admins exists), re-running THIS file must
-- not put the older definition back, so it is skipped.
do $guard$
begin
  if to_regclass('public.platform_admins') is null then
    execute $ddl$
create or replace function tenant_applications_validate() returns trigger
language plpgsql
as $$
begin
  if new.application_key = 'bookings' then
    if new.config->>'timezone' is null then
      raise exception 'The bookings application needs config.timezone, e.g. {"timezone":"Asia/Manila"}'
        using errcode = 'check_violation';
    end if;
    perform now() at time zone (new.config->>'timezone');
  end if;
  return new;
end;
$$;
    $ddl$;
  end if;
end $guard$;

drop trigger if exists tenant_applications_validate on tenant_applications;
create trigger tenant_applications_validate
  before insert or update on tenant_applications
  for each row execute function tenant_applications_validate();

-- 3. A thing that can be booked. Villa has exactly one: the whole property.
--    A hotel would have one row per room.
create table if not exists units (
  id         bigint generated always as identity primary key,
  tenant_id  bigint not null references tenants(id) on delete cascade,
  name       text   not null,
  created_at timestamptz not null default now(),
  constraint units_id_tenant_key unique (id, tenant_id),   -- for the composite FK
  constraint units_tenant_name_key unique (tenant_id, name)
);

-- 4. A named time window the tenant sells. `start_time` is wall-clock time in
--    the tenant's timezone. `duration` may cross midnight: Villa's Overnight is
--    14:00 + 22 hours.
create table if not exists slots (
  id         bigint generated always as identity primary key,
  tenant_id  bigint   not null references tenants(id) on delete cascade,
  name       text     not null,
  start_time time     not null,
  duration   interval not null,
  created_at timestamptz not null default now(),
  constraint slots_id_tenant_key unique (id, tenant_id),
  constraint slots_tenant_name_key unique (tenant_id, name),
  constraint slots_duration_positive check (duration > interval '0')
);

-- 5. Bookings.
create table if not exists bookings (
  id          bigint generated always as identity primary key,
  tenant_id   bigint    not null references tenants(id) on delete cascade,
  unit_id     bigint    not null,
  slot_id     bigint    not null,
  booked_date date      not null,   -- the date the slot STARTS on
  during      tstzrange not null,   -- set by the trigger in step 6, whatever the insert said
  status      text      not null default 'confirmed',
  guest_name  text      not null,
  guest_phone text,
  guest_count int,
  notes       text,
  created_at  timestamptz not null default now(),

  constraint bookings_status check (status in ('pending', 'confirmed', 'cancelled')),
  constraint bookings_guest_count_positive check (guest_count is null or guest_count > 0),

  -- Composite FKs: a booking cannot point at another tenant's unit or slot.
  -- Same guard as chunks_document_tenant_fk. It stops cross-tenant WRITES; only
  -- a tenant_id filter stops cross-tenant READS.
  constraint bookings_unit_tenant_fk foreign key (unit_id, tenant_id)
    references units (id, tenant_id) on delete cascade,
  -- No cascade here. Retiring a slot must not delete the history of who came.
  -- It is the default NO ACTION, not RESTRICT, because NO ACTION is checked at
  -- the end of the statement: deleting a tenant cascades to slots AND bookings
  -- in one statement, and RESTRICT would refuse that.
  constraint bookings_slot_tenant_fk foreign key (slot_id, tenant_id)
    references slots (id, tenant_id),

  -- THE constraint of this file. Two live bookings of one unit may not overlap
  -- in time. A "check, then insert" in application code double-books when two
  -- requests race; this makes the second insert fail with 23P01
  -- (exclusion_violation), whatever the timing (plan/bookings.md § 2.2).
  -- Cancelled bookings free their slot. Pending ones do not.
  constraint bookings_no_overlap exclude using gist (
    unit_id with =,
    during  with &&
  ) where (status <> 'cancelled')
);

create index if not exists bookings_tenant_date_idx on bookings (tenant_id, booked_date);

-- 6. The span a slot occupies on a date, in a timezone.
--
-- `date + time` is a wall-clock timestamp, and `at time zone` turns it into an
-- absolute instant using Postgres's own IANA timezone database. Doing this in
-- JavaScript with only Intl is a well-known source of off-by-one-hour bugs.
--
-- Half-open, '[)'. A slot ending at 17:00 and one starting at 17:00 do not
-- overlap. A closed range would make back-to-back bookings collide on a single
-- shared instant.
--
-- STABLE, not IMMUTABLE: the timezone database can change underneath it.
create or replace function slot_range(p_date date, p_start time, p_duration interval, p_timezone text)
returns tstzrange
language sql stable
as $$
  select tstzrange(
    (p_date + p_start) at time zone p_timezone,
    (p_date + p_start + p_duration) at time zone p_timezone,
    '[)'
  );
$$;

-- `during` is computed here and NEVER taken from the insert. plan/bookings.md
-- first had a create_booking() function do this. A trigger is stronger: an
-- ordinary .insert(), a script, or someone in the SQL editor gets the same
-- range, and a supplied `during` is overwritten rather than trusted.
--
-- It also enforces, in the database, that only a tenant with the bookings
-- application can hold bookings.
create or replace function bookings_compute_during() returns trigger
language plpgsql
as $$
declare
  v_timezone text;
  v_start    time;
  v_duration interval;
begin
  select config->>'timezone' into v_timezone
  from tenant_applications
  where tenant_id = new.tenant_id and application_key = 'bookings';
  if v_timezone is null then
    raise exception 'Tenant % does not have the bookings application', new.tenant_id
      using errcode = 'foreign_key_violation';
  end if;

  -- Scoped to the booking's tenant. A slot id from another tenant is not found
  -- here, and the error is the same 23503 the composite FK would have raised.
  select start_time, duration into v_start, v_duration
  from slots
  where id = new.slot_id and tenant_id = new.tenant_id;
  if v_start is null then
    raise exception 'Slot % does not belong to tenant %', new.slot_id, new.tenant_id
      using errcode = 'foreign_key_violation';
  end if;

  new.during := slot_range(new.booked_date, v_start, v_duration, v_timezone);
  return new;
end;
$$;

-- Fires on every insert, and on an update that could move the booking. A
-- status change to 'cancelled' does not recompute anything.
--
-- Changing a tenant's timezone later does NOT move existing bookings. They
-- keep the instants they were booked at, which is what the guests were told.
drop trigger if exists bookings_compute_during on bookings;
create trigger bookings_compute_during
  before insert or update of tenant_id, slot_id, booked_date on bookings
  for each row execute function bookings_compute_during();

-- 7. Availability, for ONE tenant, over a date range.
--
-- One row per (date, unit, slot), with status 'open' or 'taken'. A slot is
-- taken when its span on that date overlaps a live booking of that unit, which
-- is exactly the test the exclusion constraint applies. So "open" here means
-- "an insert would succeed", not an approximation of it.
--
-- It returns NO guest data: no name, phone, count, notes or booking id.
-- Whatever this returns goes into the chatbot's prompt, and a prompt-injected
-- model can recite it. PII that is not in the result cannot leak through it
-- (plan/bookings.md Rule 3).
--
-- p_tenant_id has NO DEFAULT, the same as match_chunks (D-027). The 366-day cap
-- bounds generate_series against a bad caller; @rag/bookings applies a much
-- smaller one.
create or replace function check_availability (
  p_tenant_id bigint,
  p_from      date,
  p_to        date
)
returns table (
  booked_date date,
  unit        text,
  slot        text,
  status      text
)
language plpgsql stable
as $$
declare
  v_timezone text;
begin
  if p_to < p_from then
    raise exception 'p_to (%) is before p_from (%)', p_to, p_from using errcode = 'invalid_parameter_value';
  end if;
  if p_to - p_from > 366 then
    raise exception 'A range of % days is too long; the limit is 366', p_to - p_from
      using errcode = 'invalid_parameter_value';
  end if;

  select config->>'timezone' into v_timezone
  from tenant_applications
  where tenant_id = p_tenant_id and application_key = 'bookings';
  -- No bookings application: no rows. The same answer as a tenant with no
  -- units, so the result says nothing about how another tenant is set up.
  if v_timezone is null then
    return;
  end if;

  return query
    select
      d::date,
      u.name,
      s.name,
      case when exists (
        select 1
        from bookings b
        where b.tenant_id = p_tenant_id
          and b.unit_id = u.id
          and b.status <> 'cancelled'
          and b.during && slot_range(d::date, s.start_time, s.duration, v_timezone)
      ) then 'taken' else 'open' end
    from generate_series(p_from, p_to, interval '1 day') as d
    cross join units u
    join slots s on s.tenant_id = u.tenant_id
    where u.tenant_id = p_tenant_id
    order by d, u.name, s.start_time, s.name;
end;
$$;

-- 8. RLS on, no policies. The same posture as every other table (D-006): the
--    anon key gets nothing, and service_role bypasses RLS.
alter table tenant_applications enable row level security;
alter table units               enable row level security;
alter table slots               enable row level security;
alter table bookings            enable row level security;

-- 9. Seed Villa Amihan, if the tenant exists. Northwind gets nothing.
--
-- The slots are taken from sample-documents/02-rates-and-schedules.md:
--   Day Tour            8:00 AM to 5:00 PM             -> 08:00 + 9 hours
--   Overnight           2:00 PM to 12:00 noon next day -> 14:00 + 22 hours
--   22-Hour Whole Day   8:00 AM to 6:00 AM next day    -> 08:00 + 22 hours
--
-- plan/bookings.md § 8 asks the owners whether there is a turnover gap between
-- bookings. None is modelled yet. If there is one, it becomes a column on
-- slots, added to the end of `during` in slot_range().
insert into tenant_applications (tenant_id, application_key, config)
select id, 'bookings', '{"timezone":"Asia/Manila"}'::jsonb from tenants where slug = 'villa'
on conflict (tenant_id, application_key) do nothing;

insert into units (tenant_id, name)
select id, 'Whole property' from tenants where slug = 'villa'
on conflict (tenant_id, name) do nothing;

insert into slots (tenant_id, name, start_time, duration)
select t.id, v.name, v.start_time, v.duration
from tenants t
cross join (values
  ('Day Tour',          time '08:00', interval '9 hours'),
  ('Overnight',         time '14:00', interval '22 hours'),
  ('22-Hour Whole Day', time '08:00', interval '22 hours')
) as v(name, start_time, duration)
where t.slug = 'villa'
on conflict (tenant_id, name) do nothing;

-- PostgREST caches the schema. Without this the new tables and the function
-- stay invisible to .from() and .rpc() until the cache refreshes on its own.
notify pgrst, 'reload schema';

-- Verify:
--   select * from check_availability((select id from tenants where slug = 'villa'),
--                                    current_date, current_date + 1);   -- 6 rows, all open
--   pnpm --filter @rag/db verify
