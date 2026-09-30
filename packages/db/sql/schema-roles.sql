-- schema-roles.sql — roles on memberships, a platform (super user) table, and
-- the policies that let a super user manage tenants (plan/tenant-management.md,
-- Phase 1).
--
-- Run in the Supabase SQL editor AFTER schema-customer-booking.sql. Idempotent.
-- This file REPLACES definitions from four earlier files: app_is_admin() and
-- tenant_public() (schema-auth.sql), tenant_applications_validate()
-- (schema-bookings.sql, schema-booking-types.sql), request_booking()
-- (schema-customer-booking.sql), and the bookings_* and
-- unanswered_resolutions_* policies (schema-auth.sql, schema-unanswered.sql).
-- Those files now skip them once `platform_admins` exists, so re-running an
-- earlier file cannot put the older definition back (CLAUDE.md trap 20).
--
-- THE TWO THINGS TO KNOW
-- ----------------------
-- 1. A role is a ROW, read on every request, never a claim. A staff token
--    still carries only `sub` and `app_admin`; app_role() looks the row up.
--    So a demotion, like a removal, takes effect on the next request, and no
--    token can outrank its row (plan Rule 4).
-- 2. app_is_admin() keeps its name and CHANGES MEANING: owner or admin. The
--    thirty policies that name it are not edited and now mean that. Only the
--    six whose meaning must widen (bookings, unanswered: any member) are
--    rewritten, to app_is_staff() (plan § 2.2).
--
-- The super user is not a member of anything. It is a row in platform_admins
-- and a second token shape with NO tenant_id (plan Rule 1), so every tenant
-- policy is false for it and only the *_super_* policies below open a table.
--
-- app_role(), three trigger functions and two lookups below are SECURITY
-- DEFINER. Each has search_path = '' and qualifies every name. app_role()
-- must be, or the memberships read policy that calls it recurses (step 2);
-- the triggers count rows the caller may not see (a super token sees 0
-- bookings; an owner sees only its tenant's rows); the lookups read
-- auth.users. D-042's list grows, and Phase 8 records each one.

-- 1. Roles, and the platform table (plan § 3.1).
--
--    Every existing membership row meant "admin" (D-041), so the backfill IS
--    the default. Then the default goes: a new row must say what it is
--    (schema-tenancy.sql step 9's pattern). The CLI's member:add defaults to
--    admin itself, so member:operator keeps its meaning.
alter table memberships add column if not exists role text not null default 'admin';
alter table memberships drop constraint if exists memberships_role;
alter table memberships add  constraint memberships_role check (role in ('owner', 'admin', 'staff'));
alter table memberships alter column role drop default;

--    Who runs the platform. No tenant, hence no tenant_id. Rows are written by
--    the CLI on service_role (super:add), because the first super user is, by
--    definition, something no super user can create yet. Created FIRST among
--    the new objects: its existence is the marker the earlier files' guards
--    read (to_regclass('public.platform_admins')).
create table if not exists platform_admins (
  user_id    uuid        primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table platform_admins enable row level security;
drop policy if exists platform_admins_read_own on platform_admins;
create policy platform_admins_read_own on platform_admins for select to authenticated
  using (user_id = (select auth.uid()));
revoke all on platform_admins from anon;
revoke insert, update, delete on platform_admins from authenticated;

-- 2. The claim helpers (plan § 2.2).
--
--    app_role(): the membership row's role for the token's user and tenant,
--    when the token is a staff token (app_admin). Null for a chat token (no
--    sub), for a non-member, and for a platform token (no tenant_id).
--
--    SECURITY DEFINER, and here is why. Step 7 lets a member read every
--    membership row of its tenant, and that policy asks app_role(). As
--    INVOKER, app_role()'s own SELECT on memberships would be governed by the
--    same policy, which asks app_role() again: Postgres stops with "infinite
--    recursion detected in policy for relation memberships". As definer the
--    inner read bypasses RLS, and the chain ends. It reads exactly one row,
--    the caller's own (auth.uid()), which memberships_read_own already
--    showed it, so nothing new is exposed.
create or replace function app_role() returns text
language sql stable
security definer
set search_path = ''
as $$
  select m.role
  from public.memberships m
  where coalesce((auth.jwt() ->> 'app_admin')::boolean, false)
    and m.user_id = auth.uid()
    and m.tenant_id = public.app_tenant_id()
$$;

--    Unchanged signature, new meaning: owner or admin. Every policy that names
--    it (documents, chunks, units, unit_rates, unit_images, rate_calendar,
--    storage.objects) now means "owner or admin" with no edit.
create or replace function app_is_admin() returns boolean
language sql stable
set search_path = ''
as $$ select coalesce(public.app_role() in ('owner', 'admin'), false) $$;

--    Any member. Only the bookings and unanswered policies use it (step 3).
create or replace function app_is_staff() returns boolean
language sql stable
set search_path = ''
as $$ select coalesce(public.app_role() in ('owner', 'admin', 'staff'), false) $$;

--    The platform. The claim AND the row, as app_is_admin() demands the claim
--    and the membership: a server bug that mints app_super for the wrong user
--    still writes nothing.
create or replace function app_is_super() returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce((auth.jwt() ->> 'app_super')::boolean, false)
     and exists (select 1 from public.platform_admins p where p.user_id = auth.uid())
$$;

-- 3. The policies whose MEANING changes: any member reads and writes bookings
--    (the daily work) and resolutions. Same text as before but for the helper.
drop policy if exists bookings_read   on bookings;
drop policy if exists bookings_insert on bookings;
drop policy if exists bookings_update on bookings;
create policy bookings_read on bookings for select to authenticated
  using (tenant_id = (select public.app_tenant_id()) and (select public.app_is_staff()));
create policy bookings_insert on bookings for insert to authenticated
  with check (tenant_id = (select public.app_tenant_id()) and (select public.app_is_staff()));
create policy bookings_update on bookings for update to authenticated
  using      (tenant_id = (select public.app_tenant_id()) and (select public.app_is_staff()))
  with check (tenant_id = (select public.app_tenant_id()) and (select public.app_is_staff()));

drop policy if exists unanswered_resolutions_read   on unanswered_resolutions;
drop policy if exists unanswered_resolutions_insert on unanswered_resolutions;
drop policy if exists unanswered_resolutions_delete on unanswered_resolutions;
create policy unanswered_resolutions_read on unanswered_resolutions for select to authenticated
  using (tenant_id = (select public.app_tenant_id()) and (select public.app_is_staff()));
create policy unanswered_resolutions_insert on unanswered_resolutions for insert to authenticated
  with check (tenant_id = (select public.app_tenant_id()) and (select public.app_is_staff()));
create policy unanswered_resolutions_delete on unanswered_resolutions for delete to authenticated
  using (tenant_id = (select public.app_tenant_id()) and (select public.app_is_staff()));

-- 4. tenants: archive, the write-side shapes, and its first policy (plan
--    § 2.3, § 2.5, § 3.3).
--
--    archived_at: set by the platform form. tenant_public() (step 5) stops
--    returning the row, so every page and route answers 404 for it at once.
--    Hard delete stays a CLI (tenant:remove), which sweeps Storage after.
alter table tenants add column if not exists archived_at timestamptz;

--    The theme is CSS from a database column. lib/branding.ts validates on
--    read and DROPS a bad value; a form that writes must be at least as
--    strict, and Postgres is the second wall, as for fallback_messages.
--    Five keys, each #rgb or #rrggbb. (No subqueries in a check, hence one
--    clause per key. A key that is not a string comes out of ->> as its JSON
--    text, which fails the regex.) Phase 0 ran every live row through these
--    rules first (plan/tenant-management-phase0-shapes.mjs, 23/23).
alter table tenants drop constraint if exists tenants_theme_shape;
alter table tenants add  constraint tenants_theme_shape check (
  jsonb_typeof(theme) = 'object'
  and theme - array['accent', 'accentSoft', 'bg', 'panel', 'ink'] = '{}'::jsonb
  and coalesce(theme ->> 'accent',     '#000') ~ '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$'
  and coalesce(theme ->> 'accentSoft', '#000') ~ '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$'
  and coalesce(theme ->> 'bg',         '#000') ~ '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$'
  and coalesce(theme ->> 'panel',      '#000') ~ '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$'
  and coalesce(theme ->> 'ink',        '#000') ~ '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$'
);
--    An <img src> from a column is the same class of hole as CSS from one.
alter table tenants drop constraint if exists tenants_urls_https;
alter table tenants add  constraint tenants_urls_https check (
  (logo_url   is null or logo_url   ~ '^https://[^[:space:]]+$')
  and (banner_url is null or banner_url ~ '^https://[^[:space:]]+$')
);
alter table tenants drop constraint if exists tenants_business_name_length;
alter table tenants add  constraint tenants_business_name_length check (char_length(business_name) between 1 and 100);
alter table tenants drop constraint if exists tenants_assistant_name_length;
alter table tenants add  constraint tenants_assistant_name_length check (char_length(assistant_name) between 1 and 50);
--    "platform" joins the reserved slugs (plan § 2.6): a slug only ever
--    appears under /t/, so nothing collides, but a workspace by that name
--    would read as a system page, which is what this list is for.
alter table tenants drop constraint if exists tenants_slug_reserved;
alter table tenants add  constraint tenants_slug_reserved check (
  slug not in ('api', 'admin', 't', '_next', 'static', 'new', 'login', 'health', 'platform')
);

--    The FIRST policy tenants has had. A chat or staff token still reads
--    nothing here (app_is_super() is false for both) and still resolves a
--    slug through tenant_public(). A platform token reads and writes every
--    row, archived included: that is what the platform form is.
drop policy if exists tenants_super_all on tenants;
create policy tenants_super_all on tenants for all to authenticated
  using      ((select public.app_is_super()))
  with check ((select public.app_is_super()));
revoke all on tenants from anon;

-- 5. tenant_public(): one line, and an archived tenant is gone everywhere.
--    Same return type, so create or replace; the grants are re-applied below.
-- GUARDED (D-089, 2026-09-30): schema-suggested-questions.sql replaces this
-- with a suggested_questions column. Once that has run, this `create or
-- replace` would fail on the changed return type, so it is skipped.
do $guard$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'tenant_public'
       and 'suggested_questions' = any(p.proargnames)
  ) then
    execute $ddl$
create or replace function tenant_public(p_slug text)
returns table (
  id                bigint,
  slug              text,
  business_name     text,
  assistant_name    text,
  logo_url          text,
  banner_url        text,
  theme             jsonb,
  fallback_messages jsonb
)
language sql stable
security definer
set search_path = ''
as $$
  select t.id, t.slug, t.business_name, t.assistant_name, t.logo_url, t.banner_url, t.theme, t.fallback_messages
  from public.tenants t
  where t.slug = p_slug and t.archived_at is null
$$
$ddl$;
  end if;
end
$guard$;

-- 6. tenant_applications: the platform switches applications on and off and
--    edits their config; the triggers keep deciding what is allowed.
drop policy if exists tenant_applications_super_all on tenant_applications;
create policy tenant_applications_super_all on tenant_applications for all to authenticated
  using      ((select public.app_is_super()))
  with check ((select public.app_is_super()));

--    Switching bookings OFF while a booking has not ended is refused (plan
--    § 8 q7, D-055's rule). SECURITY DEFINER: a platform token has no tenant
--    claim, so under RLS it would count 0 bookings and the guard would be
--    vacuous (CLAUDE.md trap 12). When the TENANT is being deleted, its rows
--    cascade through here; that is not "switching off", so it is let through
--    (the tenants row is already gone when the cascade runs).
create or replace function tenant_applications_no_delete_live() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_live int;
begin
  if old.application_key = 'bookings'
     and exists (select 1 from public.tenants t where t.id = old.tenant_id) then
    select count(*) into v_live from public.bookings b
     where b.tenant_id = old.tenant_id and b.status <> 'cancelled' and upper(b.during) > now();
    if v_live > 0 then
      raise exception 'Tenant % has % live booking(s) that have not ended; bookings cannot be switched off', old.tenant_id, v_live
        using errcode = 'check_violation';
    end if;
  end if;
  return old;
end;
$$;
drop trigger if exists tenant_applications_no_delete_live on tenant_applications;
create trigger tenant_applications_no_delete_live
  before delete on tenant_applications
  for each row execute function tenant_applications_no_delete_live();

--    The validate trigger, from schema-booking-types.sql, with three changes:
--    SECURITY DEFINER and search_path = '' (its live-bookings count must not
--    run under a super token's empty view of bookings, trap 12; and trap 19),
--    qualified names, and the two new limits. Its other rules are unchanged.
create or replace function tenant_applications_validate() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type     text;
  v_old_type text;
  v_live     int;
  v_active   int;
begin
  if new.application_key = 'bookings' then
    if new.config->>'timezone' is null then
      raise exception 'The bookings application needs config.timezone, e.g. {"timezone":"Asia/Manila"}'
        using errcode = 'check_violation';
    end if;
    perform now() at time zone (new.config->>'timezone');

    v_type := coalesce(new.config->>'booking_type', 'whole_resort');
    if v_type not in ('whole_resort', 'per_room') then
      raise exception 'config.booking_type must be "whole_resort" or "per_room", not "%"', v_type
        using errcode = 'check_violation';
    end if;

    if new.config ? 'weekend_days' and (
         jsonb_typeof(new.config->'weekend_days') <> 'array'
         or exists (select 1 from jsonb_array_elements(new.config->'weekend_days') e
                     where e::text !~ '^[1-7]$')) then
      raise exception 'config.weekend_days must be an array of ISO weekdays, 1 (Monday) to 7 (Sunday)'
        using errcode = 'check_violation';
    end if;

    if new.config ? 'currency' and coalesce(new.config->>'currency', '') !~ '^[A-Z]{3}$' then
      raise exception 'config.currency must be a three-letter code such as "PHP"'
        using errcode = 'check_violation';
    end if;

    -- Tenant management Phase 1 (plan/tenant-management.md § 2.4): the two
    -- limits request_booking() used to hold as constants. Whole numbers,
    -- 1–60 nights and 1–730 days; absent means 14 and 365.
    -- A case, not an or-chain: SQL does not promise short-circuit evaluation, and a
    -- cast of "3.5" would raise 22P02 before the check could say why.
    if new.config ? 'max_stay_nights' and (
         case when jsonb_typeof(new.config->'max_stay_nights') <> 'number' then true
              else (new.config->>'max_stay_nights')::numeric not between 1 and 60
                   or (new.config->>'max_stay_nights')::numeric <> floor((new.config->>'max_stay_nights')::numeric)
         end) then
      raise exception 'config.max_stay_nights is a whole number of nights from 1 to 60'
        using errcode = 'check_violation';
    end if;
    if new.config ? 'max_advance_days' and (
         case when jsonb_typeof(new.config->'max_advance_days') <> 'number' then true
              else (new.config->>'max_advance_days')::numeric not between 1 and 730
                   or (new.config->>'max_advance_days')::numeric <> floor((new.config->>'max_advance_days')::numeric)
         end) then
      raise exception 'config.max_advance_days is a whole number of days from 1 to 730'
        using errcode = 'check_violation';
    end if;

    if tg_op = 'UPDATE' then
      v_old_type := coalesce(old.config->>'booking_type', 'whole_resort');
      if v_type <> v_old_type then
        select count(*) into v_live from public.bookings
         where tenant_id = new.tenant_id and status <> 'cancelled' and upper(during) > now();
        if v_live > 0 then
          raise exception 'Tenant % has % live booking(s) that have not ended; its booking type cannot change', new.tenant_id, v_live
            using errcode = 'check_violation';
        end if;
        if v_type = 'whole_resort' then
          select count(*) into v_active from public.units where tenant_id = new.tenant_id and active;
          if v_active > 1 then
            raise exception 'Tenant % has % active units; a whole-resort tenant has at most one', new.tenant_id, v_active
              using errcode = 'check_violation';
          end if;
        end if;
      end if;
    end if;
  end if;
  return new;
end;
$$;
-- The trigger itself (tenant_applications_validate, before insert or update)
-- already exists from schema-bookings.sql and now runs this body.

-- 7. memberships: owners manage their tenant's members, the platform manages
--    any tenant's (plan § 2.7, § 2.8).
--
--    schema-auth.sql revoked insert, update and delete from authenticated as
--    belt and braces. Both halves are needed now: the privilege AND a policy.
--    The grant alone opens nothing (no policy is deny); a policy alone does
--    nothing (no privilege). A staff or admin token still matches no write
--    policy, and verify proves it (Phase 6).
grant insert, update, delete on memberships to authenticated;

--    Members read their tenant's rows. Not only for the Members screen (which
--    reads emails through member_emails(), step 9): an UPDATE or DELETE under
--    RLS reaches only rows the token can also SELECT, so without this an
--    owner's role change would match 0 rows and say nothing (found by verify
--    in Phase 1). Any member, not owners only, so member_emails() and this
--    policy agree on who sees the list. A chat token still sees nothing here.
drop policy if exists memberships_read_tenant on memberships;
create policy memberships_read_tenant on memberships for select to authenticated
  using (tenant_id = (select public.app_tenant_id()) and (select public.app_is_staff()));

--    Owner write policies, per verb.
drop policy if exists memberships_owner_insert on memberships;
drop policy if exists memberships_owner_update on memberships;
drop policy if exists memberships_owner_delete on memberships;
create policy memberships_owner_insert on memberships for insert to authenticated
  with check (tenant_id = (select public.app_tenant_id()) and coalesce((select public.app_role()) = 'owner', false));
create policy memberships_owner_update on memberships for update to authenticated
  using      (tenant_id = (select public.app_tenant_id()) and coalesce((select public.app_role()) = 'owner', false))
  with check (tenant_id = (select public.app_tenant_id()) and coalesce((select public.app_role()) = 'owner', false));
create policy memberships_owner_delete on memberships for delete to authenticated
  using      (tenant_id = (select public.app_tenant_id()) and coalesce((select public.app_role()) = 'owner', false));

--    The platform, every verb. app_is_super() reads platform_admins, not this
--    table, so `for all` is safe here.
drop policy if exists memberships_super_all on memberships;
create policy memberships_super_all on memberships for all to authenticated
  using      ((select public.app_is_super()))
  with check ((select public.app_is_super()));

--    A tenant always keeps an owner (plan § 2.7). The change that would leave
--    zero owner rows is refused in the database, not pre-checked in code
--    (trap 8's shape). SECURITY DEFINER, because the count must see every
--    owner and an owner's token sees only its own row. Two cascades are let
--    through: a tenant being deleted and an account being deleted take their
--    rows with them, and neither is "leaving the tenant without an owner".
create or replace function memberships_keep_an_owner() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_others int;
begin
  if old.role <> 'owner' then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if tg_op = 'UPDATE' and new.role = 'owner' and new.tenant_id = old.tenant_id and new.user_id = old.user_id then
    return new;
  end if;
  if not exists (select 1 from public.tenants t where t.id = old.tenant_id)
     or not exists (select 1 from auth.users u where u.id = old.user_id) then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  select count(*) into v_others
  from public.memberships m
  where m.tenant_id = old.tenant_id and m.role = 'owner' and m.user_id <> old.user_id;
  if v_others = 0 then
    raise exception 'Tenant % would be left with no owner', old.tenant_id
      using errcode = 'check_violation';
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;
drop trigger if exists memberships_keep_an_owner on memberships;
create trigger memberships_keep_an_owner
  before update or delete on memberships
  for each row execute function memberships_keep_an_owner();

-- 8. request_booking(): the two limits come from the tenant's config, with
--    the old numbers as the defaults. Nothing else in the body changed; it is
--    the schema-customer-booking.sql text with two constants turned into two
--    reads (plan § 2.4). validate (step 6) bounds what the config may say.
create or replace function request_booking (
  p_tenant_id bigint,
  p_slot_id   bigint,
  p_unit_ids  bigint[],
  p_guests    int[],
  p_check_in  date,
  p_nights    int,
  p_name      text,
  p_phone     text,
  p_email     text,
  p_notes     text
)
returns table (
  reference         text,
  booked_date       date,
  unit              text,
  slot              text,
  starts_at         timestamptz,
  ends_at           timestamptz,
  guests            int,
  base_price        bigint,
  extra_guest_price bigint,
  surcharge         bigint,
  price             bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Per tenant since tenant management Phase 1 (plan/tenant-management.md
  -- § 2.4): config.max_stay_nights and config.max_advance_days, read below
  -- with the row that holds the timezone. ABSENT MEANS THE OLD NUMBERS, 14
  -- and 365, the same defaults @rag/bookings' bookingsConfig() applies.
  v_max_nights  int;
  v_max_advance int;
  c_max_open      constant int := 3;
  c_max_rows      constant int := 70;
  c_alphabet      constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ2345679';   -- no 0 O 1 I L 8
  v_timezone text;
  v_slug     text;
  v_start    time;
  v_duration interval;
  v_nightly  boolean;
  v_today    date;
  v_units    int;
  v_name     text;
  v_phone    text;
  v_email    text;
  v_notes    text;
  v_open     int;
  v_group    uuid := gen_random_uuid();
  v_ref      text;
begin
  -- The tenant is the token's (wall 2); p_tenant_id is what the code sends
  -- (wall 1). service_role is allowed for the tools, as in the other three.
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and p_tenant_id is distinct from public.app_tenant_id() then
    raise exception 'request_booking: tenant % is not the token''s tenant', p_tenant_id
      using errcode = 'insufficient_privilege';
  end if;

  select a.config->>'timezone', t.slug,
         coalesce((a.config->>'max_stay_nights')::int, 14),
         coalesce((a.config->>'max_advance_days')::int, 365)
    into v_timezone, v_slug, v_max_nights, v_max_advance
  from public.tenant_applications a
  join public.tenants t on t.id = a.tenant_id
  where a.tenant_id = p_tenant_id and a.application_key = 'bookings';
  if v_timezone is null then
    raise exception 'This business does not take bookings' using errcode = 'invalid_parameter_value';
  end if;

  select s.start_time, s.duration, s.nightly into v_start, v_duration, v_nightly
  from public.slots s
  where s.tenant_id = p_tenant_id and s.id = p_slot_id;
  if v_start is null then
    raise exception 'No such booking slot' using errcode = 'invalid_parameter_value';
  end if;

  -- Dates: the tenant's today (CLAUDE.md trap 9), and the first night must
  -- not have started yet.
  v_today := (now() at time zone v_timezone)::date;
  if p_check_in is null or p_nights is null then
    raise exception 'A date and a number of nights are required' using errcode = 'invalid_parameter_value';
  end if;
  if p_nights < 1 or p_nights > v_max_nights then
    raise exception 'A stay is 1 to % nights, not %', v_max_nights, p_nights using errcode = 'invalid_parameter_value';
  end if;
  if p_nights > 1 and not v_nightly then
    raise exception 'Only an overnight slot can be booked for several nights' using errcode = 'invalid_parameter_value';
  end if;
  if p_check_in > v_today + v_max_advance then
    raise exception 'Bookings open % days ahead; % is too far', v_max_advance, p_check_in using errcode = 'invalid_parameter_value';
  end if;
  if lower(public.slot_range(p_check_in, v_start, v_duration, v_timezone)) <= now() then
    raise exception 'That date has already started or passed' using errcode = 'invalid_parameter_value';
  end if;

  -- Units: one guest count each, no repeats, and bounded rows. Whether each
  -- unit is this tenant's, active and big enough is the trigger's job.
  v_units := coalesce(cardinality(p_unit_ids), 0);
  if v_units = 0 or v_units <> coalesce(cardinality(p_guests), 0) then
    raise exception 'Choose at least one unit, with a guest count for each' using errcode = 'invalid_parameter_value';
  end if;
  if array_position(p_unit_ids, null) is not null or array_position(p_guests, null) is not null
     or exists (select 1 from unnest(p_guests) g where g < 1) then
    raise exception 'Every unit needs a guest count of at least 1' using errcode = 'invalid_parameter_value';
  end if;
  if (select count(distinct u) from unnest(p_unit_ids) u) <> v_units then
    raise exception 'A unit appears twice' using errcode = 'invalid_parameter_value';
  end if;
  if public.booking_type_of(p_tenant_id) = 'whole_resort' and v_units <> 1 then
    raise exception 'A whole-resort booking is for the one property' using errcode = 'invalid_parameter_value';
  end if;
  if v_units * p_nights > c_max_rows then
    raise exception 'That is % room-nights; the limit is %', v_units * p_nights, c_max_rows using errcode = 'invalid_parameter_value';
  end if;

  -- Contact details: FORMAT only. A form cannot prove a phone or an email is
  -- real (plan § 2.7); staff contact the guest before confirming.
  v_name  := btrim(coalesce(p_name, ''));
  v_phone := regexp_replace(coalesce(p_phone, ''), '[\s().-]', '', 'g');
  if v_phone like '+63%' then v_phone := '0' || substr(v_phone, 4); end if;
  v_email := lower(btrim(coalesce(p_email, '')));
  v_notes := nullif(btrim(coalesce(p_notes, '')), '');
  if char_length(v_name) not between 2 and 100 then
    raise exception 'A name of 2 to 100 characters is required' using errcode = 'invalid_parameter_value';
  end if;
  if v_phone !~ '^09[0-9]{9}$' then
    raise exception 'A mobile number like 0917 123 4567 is required' using errcode = 'invalid_parameter_value';
  end if;
  if char_length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'A valid email address is required' using errcode = 'invalid_parameter_value';
  end if;
  if char_length(v_notes) > 1000 then
    raise exception 'Notes are at most 1000 characters' using errcode = 'invalid_parameter_value';
  end if;

  -- Serialises requests per tenant from here to commit: the limit count and
  -- the reference's uniqueness are both read-then-write, and this lock is
  -- what makes them safe under concurrency. It does NOT decide who gets a
  -- date; the constraint does that at confirmation.
  perform pg_advisory_xact_lock(hashtextextended('request_booking:' || p_tenant_id::text, 0));

  select count(distinct b.group_id) into v_open
  from public.bookings b
  where b.tenant_id = p_tenant_id
    and b.source = 'web' and b.status = 'pending'
    and upper(b.during) > now()
    and (b.guest_phone = v_phone or b.guest_email = v_email);
  if v_open >= c_max_open then
    raise exception 'There are already % open requests for this contact; the resort will reply to those first', v_open
      using errcode = 'program_limit_exceeded';
  end if;

  -- A courtesy check, not the guard: a night already CONFIRMED for one of
  -- these units is refused now, so nobody requests what is visibly gone.
  -- The guard is the constraint, when staff confirm.
  if exists (
    select 1
    from unnest(p_unit_ids) as u(unit_id)
    cross join generate_series(0, p_nights - 1) as n
    join public.bookings b
      on b.tenant_id = p_tenant_id and b.unit_id = u.unit_id and b.status = 'confirmed'
     and b.during && public.slot_range(p_check_in + n, v_start, v_duration, v_timezone)
  ) then
    raise exception 'That date is no longer available' using errcode = 'exclusion_violation';
  end if;

  -- The reference: 3 letters of the slug and 6 from a 30-letter alphabet.
  -- random() is fine here: the reference grants nothing (plan § 3).
  loop
    v_ref := upper(left(regexp_replace(v_slug, '[^a-zA-Z]', '', 'g') || 'XXX', 3)) || '-' ||
             (select string_agg(substr(c_alphabet, 1 + floor(random() * 30)::int, 1), '')
                from generate_series(1, 6));
    exit when not exists (select 1 from public.bookings b where b.tenant_id = p_tenant_id and b.reference = v_ref);
  end loop;

  -- ONE insert, so a stay that fails on any row saves none (booking-types
  -- § 2.5). The trigger sets `during` and the price of every row.
  insert into public.bookings
    (tenant_id, unit_id, slot_id, booked_date, status, source,
     guest_name, guest_phone, guest_email, guest_count, notes, group_id, reference)
  select p_tenant_id, u.unit_id, p_slot_id, p_check_in + n, 'pending', 'web',
         v_name, v_phone, v_email, u.guests, v_notes, v_group, v_ref
  from unnest(p_unit_ids, p_guests) as u(unit_id, guests)
  cross join generate_series(0, p_nights - 1) as n;

  -- A page with no price is what this plan exists to avoid: a whole_resort
  -- unit with no rate for this slot is refused, and the insert rolls back.
  if exists (select 1 from public.bookings b
              where b.tenant_id = p_tenant_id and b.group_id = v_group and b.price is null) then
    raise exception 'This slot has no price yet' using errcode = 'invalid_parameter_value';
  end if;

  return query
    select b.reference, b.booked_date, un.name, s.name, lower(b.during), upper(b.during),
           b.guest_count, b.base_price, b.extra_guest_price, b.surcharge, b.price
    from public.bookings b
    join public.units un on un.tenant_id = b.tenant_id and un.id = b.unit_id
    join public.slots s  on s.tenant_id  = b.tenant_id and s.id  = b.slot_id
    where b.tenant_id = p_tenant_id and b.group_id = v_group
    order by b.booked_date, un.sort_order, un.name;
end;
$$;

-- 9. Two lookups into auth.users, which no token reads (plan § 2.9). Both
--    SECURITY DEFINER with search_path = '', and each checks the caller
--    ITSELF, as the other definer functions do (D-042).
--
--    member_emails: the members of ONE tenant with their email and role, and
--    nothing else from auth.users. For a member of that tenant (any role: a
--    colleague's address is not a secret from a colleague) or the platform.
create or replace function member_emails(p_tenant_id bigint)
returns table (
  user_id    uuid,
  email      text,
  role       text,
  created_at timestamptz
)
language plpgsql stable
security definer
set search_path = ''
as $$
begin
  if not (
       coalesce(auth.jwt() ->> 'role', '') = 'service_role'
    or public.app_is_super()
    or (p_tenant_id is not distinct from public.app_tenant_id() and public.app_is_staff())
  ) then
    raise exception 'member_emails: tenant % is not the token''s tenant', p_tenant_id
      using errcode = 'insufficient_privilege';
  end if;
  return query
    select m.user_id, u.email::text, m.role, m.created_at
    from public.memberships m
    join auth.users u on u.id = m.user_id
    where m.tenant_id = p_tenant_id
    order by m.created_at, u.email;
end;
$$;

--    user_id_by_email: one uuid or null, so an owner can add an EXISTING
--    account to their tenant. It answers "found" and "not found" differently,
--    which is a probe (R-42), so it is owner-only or platform, never staff.
create or replace function user_id_by_email(p_email text) returns uuid
language plpgsql stable
security definer
set search_path = ''
as $$
begin
  if not (
       coalesce(auth.jwt() ->> 'role', '') = 'service_role'
    or public.app_is_super()
    or coalesce(public.app_role() = 'owner', false)
  ) then
    raise exception 'user_id_by_email: only an owner or the platform may look up an account'
      using errcode = 'insufficient_privilege';
  end if;
  return (select u.id from auth.users u where lower(u.email) = lower(btrim(p_email)) limit 1);
end;
$$;

-- 10. EXECUTE grants: revoke from all three, grant back exactly who needs it
--     (schema-auth.sql step 6's rule). tenant_public was re-created, so its
--     grants are re-applied, anon included: the server resolves a slug before
--     it knows which tenant to mint a token for.
revoke all on function app_role()                    from public, anon, authenticated;
revoke all on function app_is_admin()                from public, anon, authenticated;
revoke all on function app_is_staff()                from public, anon, authenticated;
revoke all on function app_is_super()                from public, anon, authenticated;
revoke all on function tenant_public(text)           from public, anon, authenticated;
revoke all on function member_emails(bigint)         from public, anon, authenticated;
revoke all on function user_id_by_email(text)        from public, anon, authenticated;
revoke all on function request_booking(bigint, bigint, bigint[], int[], date, int, text, text, text, text) from public, anon, authenticated;

grant execute on function app_role()                 to authenticated, service_role;
grant execute on function app_is_admin()             to authenticated, service_role;
grant execute on function app_is_staff()             to authenticated, service_role;
grant execute on function app_is_super()             to authenticated, service_role;
grant execute on function tenant_public(text)        to anon, authenticated, service_role;
grant execute on function member_emails(bigint)      to authenticated, service_role;
grant execute on function user_id_by_email(text)     to authenticated, service_role;
grant execute on function request_booking(bigint, bigint, bigint[], int[], date, int, text, text, text, text) to authenticated, service_role;

-- PostgREST caches the schema: without this, platform_admins, the new column
-- and the two lookups stay invisible to .from() and .rpc().
notify pgrst, 'reload schema';

-- Verify:  pnpm --filter @rag/db verify        (Phase 1's checks, plan § 5)
--          pnpm --filter @rag/db member:list -- villa    (every row now says admin)
--          pnpm eval                            (verdict for verdict against Phase 0)
